// GET /api/admin/backup — 管理者専用：全テーブルのデータを JSON でダウンロード
import { requireRole } from '../_lib/auth.js';
import { nowIso } from '../_lib/util.js';

const TABLES = [
  'users', 'equipment_ledger',
  'inspection_master', 'inspection_result',
  'trouble_record', 'trouble_category', 'trouble_custom_field',
  'repair_request', 'repair_history',
  'parts_inventory', 'parts_transaction',
  'maintenance_plan', 'daily_report', 'report_category',
  'comments', 'chat_messages', 'notifications', 'files',
  'storage_reports', 'audit_log', 'master_history',
];

export async function onRequestGet({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const backup = { exported_at: nowIso(), tables: {} };

  for (const table of TABLES) {
    try {
      const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all();
      backup.tables[table] = results ?? [];
    } catch {
      backup.tables[table] = null; // テーブルが存在しない場合はスキップ
    }
  }

  const date = nowIso().slice(0, 10);
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${date}.json"`,
    },
  });
}
