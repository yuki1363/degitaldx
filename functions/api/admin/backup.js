// GET /api/admin/backup          — JSON形式（データのみ）
// GET /api/admin/backup?format=sql — SQLダンプ形式（スキーマ＋データ、他DBへ移植可）
import { requireRole } from '../_lib/auth.js';
import { nowIso } from '../_lib/util.js';

const TABLES = [
  'users', 'equipment_ledger',
  'inspection_master', 'inspection_result',
  'trouble_record', 'trouble_category', 'trouble_custom_field',
  'repair_request', 'repair_history',
  'parts_inventory', 'parts_transaction',
  'maintenance_plan', 'daily_report', 'report_category',
  'utility_item', 'utility_report',
  'comments', 'chat_messages', 'notifications', 'files',
  'storage_reports', 'audit_log', 'master_history',
];

// SQL文字列エスケープ（SQLiteのシングルクォートは '' で表現）
function sqlVal(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'bigint') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

// ---- JSON形式 ----

async function buildJsonBackup(db) {
  const backup = { exported_at: nowIso(), tables: {} };
  for (const table of TABLES) {
    try {
      const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all();
      backup.tables[table] = results ?? [];
    } catch {
      backup.tables[table] = null;
    }
  }
  return backup;
}

// ---- SQLダンプ形式 ----

async function buildSqlDump(db) {
  const lines = [];
  const now = nowIso();

  lines.push('-- ==================================================');
  lines.push('-- 設備保全アプリ データベース完全バックアップ');
  lines.push(`-- Exported at: ${now}`);
  lines.push('-- Compatible with SQLite 3.x');
  lines.push('-- 使い方: sqlite3 mainte-db.sqlite < backup.sql');
  lines.push('-- ==================================================');
  lines.push('');
  lines.push('PRAGMA journal_mode = WAL;');
  lines.push('PRAGMA foreign_keys = ON;');
  lines.push('');

  // スキーマ（CREATE TABLE / CREATE INDEX）を sqlite_master から取得
  lines.push('-- ===== テーブル定義（Schema） =====');
  lines.push('');
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
        lines.push(normalized + ';');
        lines.push('');
      }
    }
  } catch (e) {
    lines.push(`-- スキーマ取得エラー: ${e.message}`);
    lines.push('');
  }

  // 各テーブルのデータを INSERT 文で出力
  lines.push('-- ===== データ（Data） =====');
  lines.push('');

  for (const table of TABLES) {
    try {
      const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all();
      if (!results || results.length === 0) {
        lines.push(`-- Table: ${table} (0 rows)`);
        lines.push('');
        continue;
      }
      lines.push(`-- Table: ${table} (${results.length} rows)`);
      const cols = Object.keys(results[0]);
      const colList = cols.map((c) => `"${c}"`).join(', ');
      for (const row of results) {
        const vals = cols.map((c) => sqlVal(row[c])).join(', ');
        lines.push(`INSERT INTO "${table}" (${colList}) VALUES (${vals});`);
      }
      lines.push('');
    } catch {
      lines.push(`-- Table: ${table} (スキップ: テーブルが存在しないか取得失敗)`);
      lines.push('');
    }
  }

  lines.push('-- ===== バックアップ終了 =====');
  return lines.join('\n');
}

// ---- エンドポイント ----

export async function onRequestGet({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const format = new URL(request.url).searchParams.get('format') || 'json';
  const db = env.DB;
  const date = nowIso().slice(0, 10);

  if (format === 'sql') {
    const sql = await buildSqlDump(db);
    return new Response(sql, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="backup-${date}.sql"`,
      },
    });
  }

  // デフォルト: JSON
  const backup = await buildJsonBackup(db);
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${date}.json"`,
    },
  });
}
