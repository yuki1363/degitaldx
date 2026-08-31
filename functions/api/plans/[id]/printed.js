// POST /api/plans/:id/printed — 工事連絡書を出力（印刷）したことを記録する（editor以上）
//
//   帳票（工事連絡書）を Excel 出力したとき、フロント（js/excel-fill.js）から呼ぶ。
//   printed_at / printed_by を「今」で更新し、計画詳細の「印刷日」表示と、
//   「工事3日前で未印刷なら通知」（functions/api/_lib/overdue-notify.js）の判定に使う。
//
//   後付け列（printed_at/printed_by）が無い旧DBでも落ちないよう、入口で自己修復する。

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { json, jsonError } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { ensureColumns } from '../../_lib/db-compat.js';

export async function ensurePlanPrintedColumns(db) {
  await ensureColumns(db, 'maintenance_plan_printed', [
    'ALTER TABLE maintenance_plan ADD COLUMN printed_at TEXT',
    'ALTER TABLE maintenance_plan ADD COLUMN printed_by TEXT',
  ]);
}

export async function onRequestPost({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = params.id;
  await ensurePlanPrintedColumns(db);

  const existing = await db
    .prepare('SELECT id, printed_at FROM maintenance_plan WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first();
  if (!existing) return jsonError(404, '保全計画が見つかりません');

  const now = nowIso();
  const userEmail = data.user.email;
  await db
    .prepare('UPDATE maintenance_plan SET printed_at = ?, printed_by = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(now, userEmail, userEmail, now, id)
    .run();

  await writeAuditLog(db, {
    tableName: 'maintenance_plan',
    recordId: id,
    action: 'update',
    changedBy: userEmail,
    diff: { printed_at: { from: existing.printed_at || null, to: now } },
  });

  return json({ printed_at: now, printed_by: userEmail });
}
