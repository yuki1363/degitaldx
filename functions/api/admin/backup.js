// GET /api/admin/backup          — JSON形式（データのみ）
// GET /api/admin/backup?format=sql — SQLダンプ形式（スキーマ＋データ、他DBへ移植可）
//
// データは全テーブル・全件が対象のため、一度に全部メモリへ読んでから組み立てると、
// 年数が経ってデータが増えたときにメモリを使い切ったりタイムアウトしたりして失敗する恐れがある。
// そのため各テーブルを BACKUP_PAGE_SIZE 件ずつ読み、読めた分からレスポンスのストリームへ書き出す。
//
//   ★ ページ送りは「LIMIT n OFFSET m」ではなく「前回の最後の rowid より後ろ」で読む（keyset 方式）。
//     OFFSET は読み飛ばす行も D1 の「読み取り行数」に数えられ、後ろのページほど重くなる
//     （6万行の表で OFFSET 方式は約200万行ぶん＝無料枠 500万行/日 の約4割を1回のバックアップで使った）。
//     keyset 方式なら全体で表の行数ぶんだけで済む。
//   ★ 読み取りに失敗したら null や空で続けず、ストリームごとエラーにする（ダウンロードを失敗させる）。
//     途中までのバックアップを「成功」と見間違えて、復元できない版を保管しないため。
//   ★ 引っ張り方式（pull）で書き出すので、受け取る側が遅いときは読み込みも待つ（メモリに溜めない）。
import { requireRole } from '../_lib/auth.js';
import { nowIso } from '../_lib/util.js';

// 対象テーブル。push_subscriptions は端末の暗号鍵（p256dh/auth）を含み、バックアップに残す価値が低い
// （再購読すれば作り直せる）ため意図的に除外している
export const TABLES = [
  'users', 'equipment_ledger',
  'inspection_master', 'inspection_result',
  'trouble_record', 'trouble_category', 'trouble_custom_field',
  'repair_request', 'repair_history',
  'parts_inventory', 'parts_transaction',
  'maintenance_plan', 'daily_report', 'report_category',
  'utility_item', 'utility_report',
  'comments', 'chat_messages', 'notifications', 'files',
  'storage_reports', 'audit_log', 'master_history',
  'print_templates', 'chat_reactions', 'chat_channel_reads',
  'plan_reset_log', 'annual_plan_status',
  'electrical_inspection', 'electrical_config',
  'parts_equipment',
];

// 1テーブルを一度に読む件数。小さすぎるとクエリ数が増えて遅く、大きすぎるとメモリを使う
const BACKUP_PAGE_SIZE = 1000;

// SQL文字列エスケープ（SQLiteのシングルクォートは '' で表現）
function sqlVal(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'bigint') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

// テーブルを rowid 順に BACKUP_PAGE_SIZE 件ずつ読み、ページ（行の配列）を順に渡す（keyset 方式）。
// id 列が無いテーブル（electrical_config 等）も rowid は常にあるため対応できる。
// 失敗は握りつぶさず、そのまま投げる（呼び出し側が「最初のページ＝表が無い等」か「途中＝本当の失敗」かを区別する）。
async function* readTablePages(db, table) {
  let lastRid = 0;
  for (;;) {
    const page = await db
      .prepare(`SELECT rowid AS _rid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid ASC LIMIT ?2`)
      .bind(lastRid, BACKUP_PAGE_SIZE)
      .all();
    const raw = page.results ?? [];
    if (raw.length === 0) return;
    lastRid = raw[raw.length - 1]._rid;
    yield raw.map((r) => { const row = { ...r }; delete row._rid; return row; });
    if (raw.length < BACKUP_PAGE_SIZE) return;
  }
}

// 最初のページを読んでみる。表が無い・読めないときは { unreadable: true }（従来どおり null / スキップ扱い）。
async function openTable(db, table) {
  const pages = readTablePages(db, table);
  try {
    const first = await pages.next();
    return { pages, first };
  } catch {
    return { unreadable: true };
  }
}

// ---- JSON形式 ----
//   {"exported_at":"...","tables":{"table1":[...],"table2":null,...}}
//   （表が読めないときだけ null。途中で失敗したときはストリームごとエラー）
async function* jsonChunks(db) {
  yield `{"exported_at":${JSON.stringify(nowIso())},"tables":{`;
  for (let i = 0; i < TABLES.length; i++) {
    const table = TABLES[i];
    yield `${i > 0 ? ',' : ''}${JSON.stringify(table)}:`;
    const t = await openTable(db, table);
    if (t.unreadable) { yield 'null'; continue; }
    yield '[';
    let firstRow = true;
    let step = t.first;
    while (!step.done) {
      yield step.value.map((row) => {
        const s = JSON.stringify(row);
        const out = firstRow ? s : `,${s}`;
        firstRow = false;
        return out;
      }).join('');
      step = await t.pages.next();
    }
    yield ']';
  }
  yield '}}';
}

// ---- SQLダンプ形式 ----
async function* sqlChunks(db) {
  const now = nowIso();
  const head = [
    '-- ==================================================',
    '-- 設備保全アプリ データベース完全バックアップ',
    `-- Exported at: ${now}`,
    '-- Compatible with SQLite 3.x',
    '-- 使い方: sqlite3 mainte-db.sqlite < backup.sql',
    '-- ==================================================',
    '',
    'PRAGMA journal_mode = WAL;',
    'PRAGMA foreign_keys = ON;',
    '',
    '-- ===== テーブル定義（Schema） =====',
    '',
  ];
  yield head.join('\n') + '\n';

  // スキーマ（CREATE TABLE / CREATE INDEX）を sqlite_master から取得。
  // 読めないとこのバックアップは単体では復元できないため、握りつぶさず失敗として扱う
  const { results: schemaDefs } = await db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'
     ORDER BY type DESC, name ASC`
  ).all();
  let schemaOut = '';
  for (const row of schemaDefs ?? []) {
    if (!row.sql) continue;
    // CREATE TABLE → CREATE TABLE IF NOT EXISTS に正規化
    const normalized = row.sql
      .replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/^CREATE INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS ')
      .replace(/^CREATE UNIQUE INDEX\s+/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
    schemaOut += `${normalized};\n\n`;
  }
  yield schemaOut;

  yield '-- ===== データ（Data） =====\n\n';
  for (const table of TABLES) {
    const t = await openTable(db, table);
    if (t.unreadable) {
      yield `-- Table: ${table} (スキップ: テーブルが存在しないか取得失敗)\n\n`;
      continue;
    }
    if (t.first.done) {
      yield `-- Table: ${table} (0 rows)\n\n`;
      continue;
    }
    yield `-- Table: ${table}\n`;
    let total = 0;
    let step = t.first;
    while (!step.done) {
      const rows = step.value;
      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => `"${c}"`).join(', ');
      yield rows.map((row) => `INSERT INTO "${table}" (${colList}) VALUES (${cols.map((c) => sqlVal(row[c])).join(', ')});\n`).join('');
      total += rows.length;
      step = await t.pages.next();
    }
    // 件数は読み終わってから書く（先に数えると表を二度読むことになり、読み取り行数が倍になるため）
    yield `-- Table: ${table}: ${total} rows\n\n`;
  }

  yield '-- ===== バックアップ終了 =====\n';
}

// 非同期ジェネレーター（文字列を順に出す）→ 引っ張り方式のストリーム。途中の失敗はストリームのエラーにする
function streamFrom(makeGen, label) {
  const ENC = new TextEncoder();
  let it;
  return new ReadableStream({
    async pull(controller) {
      try {
        it ??= makeGen();
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(ENC.encode(value));
      } catch (err) {
        console.error(`backup(${label}) failed:`, err && err.stack ? err.stack : err);
        controller.error(err);
      }
    },
    cancel() { return it?.return?.(); },
  });
}

// ---- エンドポイント ----

export async function onRequestGet({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const format = new URL(request.url).searchParams.get('format') || 'json';
  const db = env.DB;
  const date = nowIso().slice(0, 10);

  if (format === 'sql') {
    return new Response(streamFrom(() => sqlChunks(db), 'sql'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="backup-${date}.sql"`,
      },
    });
  }

  // デフォルト: JSON
  return new Response(streamFrom(() => jsonChunks(db), 'json'), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${date}.json"`,
    },
  });
}
