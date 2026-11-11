// GET /api/admin/backup          — JSON形式（データのみ）
// GET /api/admin/backup?format=sql — SQLダンプ形式（スキーマ＋データ、他DBへ移植可）
//
// データは全テーブル・全件が対象のため、一度に全部メモリへ読んでから組み立てると、
// 年数が経ってデータが増えたときにメモリを使い切ったりタイムアウトしたりしてバックアップが
// 失敗する恐れがある。そのため各テーブルを BACKUP_PAGE_SIZE 件ずつページ送りで読み、
// 読めた分からすぐレスポンスのストリームへ書き出す（一度にメモリに持つのは1ページ分だけ）。
// 出力される内容（JSON・SQLの文面）は以前の一括生成版と同じになるようにしている。
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

// 1テーブルを一度に読む件数。小さすぎるとクエリ数が増えて遅く、大きすぎるとメモリを使うため、
// 無料枠で想定される規模（数万行程度）に対して十分小さい値にしている
const BACKUP_PAGE_SIZE = 1000;

// SQL文字列エスケープ（SQLiteのシングルクォートは '' で表現）
function sqlVal(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'bigint') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

// テーブルを rowid 順に BACKUP_PAGE_SIZE 件ずつ読み、ページ（行の配列）を順に渡す。
// id 列が無いテーブル（electrical_config 等）も rowid は常にあるため対応できる。
// テーブルが存在しない等で最初のページから失敗したら null を返す（従来の「取得失敗時は
// tables[table] = null」と同じ扱い）。途中のページで失敗した場合は、そこまで読めた分で
// 打ち切る（全く読めないよりはまし。通常は起きない想定）。
async function* readTablePages(db, table) {
  let offset = 0;
  for (;;) {
    let page;
    try {
      page = await db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid ASC LIMIT ? OFFSET ?`)
        .bind(BACKUP_PAGE_SIZE, offset)
        .all();
    } catch (err) {
      if (offset === 0) throw err; // 最初のページから失敗 → テーブル自体が無い等
      return; // 途中からの失敗は、それまでの分で打ち切る
    }
    const rows = page.results ?? [];
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < BACKUP_PAGE_SIZE) return; // 最後のページ
    offset += BACKUP_PAGE_SIZE;
  }
}

const ENC = new TextEncoder();

// ---- JSON形式（ストリーミング） ----
//   {"exported_at":"...","tables":{"table1":[...],"table2":null,...}}
function buildJsonBackupStream(db) {
  return new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(ENC.encode(s));
      try {
        push(`{"exported_at":${JSON.stringify(nowIso())},"tables":{`);
        for (let i = 0; i < TABLES.length; i++) {
          const table = TABLES[i];
          if (i > 0) push(',');
          push(`${JSON.stringify(table)}:`);
          // 先に存在確認（軽いクエリ）。ここで失敗するテーブルは従来どおり null にする
          // （[] で配列を開いてしまうと、後続のページ読み取りが失敗したときに閉じられない）
          let readable = true;
          try {
            await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all();
          } catch {
            readable = false;
          }
          if (!readable) {
            push('null');
            continue;
          }
          push('[');
          let firstRow = true;
          for await (const rows of readTablePages(db, table)) {
            for (const row of rows) {
              if (!firstRow) push(',');
              firstRow = false;
              push(JSON.stringify(row));
            }
          }
          push(']');
        }
        push('}}');
      } finally {
        controller.close();
      }
    },
  });
}

// ---- SQLダンプ形式（ストリーミング） ----

function buildSqlDumpStream(db) {
  return new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(ENC.encode(s + '\n'));
      const now = nowIso();

      push('-- ==================================================');
      push('-- 設備保全アプリ データベース完全バックアップ');
      push(`-- Exported at: ${now}`);
      push('-- Compatible with SQLite 3.x');
      push('-- 使い方: sqlite3 mainte-db.sqlite < backup.sql');
      push('-- ==================================================');
      push('');
      push('PRAGMA journal_mode = WAL;');
      push('PRAGMA foreign_keys = ON;');
      push('');

      // スキーマ（CREATE TABLE / CREATE INDEX）を sqlite_master から取得
      push('-- ===== テーブル定義（Schema） =====');
      push('');
      try {
        const { results: schemaDefs } = await db.prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'
           ORDER BY type DESC, name ASC`
        ).all();
        for (const row of schemaDefs ?? []) {
          if (row.sql) {
            // CREATE TABLE → CREATE TABLE IF NOT EXISTS に正規化
            const normalized = row.sql
              .replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ')
              .replace(/^CREATE INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS ')
              .replace(/^CREATE UNIQUE INDEX\s+/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
            push(normalized + ';');
            push('');
          }
        }
      } catch (e) {
        push(`-- スキーマ取得エラー: ${e.message}`);
        push('');
      }

      // 各テーブルのデータを INSERT 文で出力（テーブルごとにページ送りで読む）
      push('-- ===== データ（Data） =====');
      push('');

      for (const table of TABLES) {
        try {
          // 件数を先に数える（軽いクエリ）。コメントに件数を書くため、データより先に必要
          const countResult = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all();
          const rowCount = countResult.results?.[0]?.n ?? 0;
          if (rowCount === 0) {
            push(`-- Table: ${table} (0 rows)`);
            push('');
            continue;
          }
          push(`-- Table: ${table} (${rowCount} rows)`);
          // 1ページずつ読んで、そのまま書き出す（テーブル全体をメモリに持たない）
          for await (const rows of readTablePages(db, table)) {
            const cols = Object.keys(rows[0]);
            const colList = cols.map((c) => `"${c}"`).join(', ');
            for (const row of rows) {
              const vals = cols.map((c) => sqlVal(row[c])).join(', ');
              push(`INSERT INTO "${table}" (${colList}) VALUES (${vals});`);
            }
          }
          push('');
        } catch {
          push(`-- Table: ${table} (スキップ: テーブルが存在しないか取得失敗)`);
          push('');
        }
      }

      push('-- ===== バックアップ終了 =====');
      controller.close();
    },
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
    return new Response(buildSqlDumpStream(db), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="backup-${date}.sql"`,
      },
    });
  }

  // デフォルト: JSON
  return new Response(buildJsonBackupStream(db), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${date}.json"`,
    },
  });
}
