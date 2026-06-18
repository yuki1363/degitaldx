// POST /api/equipment/renumber — 管理者専用: INV-以外の設備番号を INV-xxx に振り直す
import { json } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestPost({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;

  const { results: maxResult } = await db.prepare(
    `SELECT MAX(CAST(REPLACE(code, 'INV-', '') AS INTEGER)) AS max_num
     FROM equipment_ledger WHERE code LIKE 'INV-%'`
  ).all();
  let nextNum = (maxResult?.[0]?.max_num || 0) + 1;

  const { results: toRenumber } = await db.prepare(
    `SELECT id, code FROM equipment_ledger
     WHERE deleted_at IS NULL AND code NOT LIKE 'INV-%'
     ORDER BY id ASC`
  ).all();

  if (!toRenumber || toRenumber.length === 0) {
    return json({ updated: 0, message: 'INV以外の設備番号は見つかりませんでした。' });
  }

  const now = nowIso();
  const userEmail = data.user.email;
  const updated = [];

  for (const eq of toRenumber) {
    const newCode = `INV-${String(nextNum).padStart(3, '0')}`;
    nextNum++;
    await db.prepare(
      `UPDATE equipment_ledger SET code = ?1, updated_by = ?2, updated_at = ?3 WHERE id = ?4`
    ).bind(newCode, userEmail, now, eq.id).run();
    await writeAuditLog(db, {
      tableName: 'equipment_ledger',
      recordId: eq.id,
      action: 'update',
      changedBy: userEmail,
      diff: { code: { before: eq.code, after: newCode } },
    });
    updated.push({ id: eq.id, old_code: eq.code, new_code: newCode });
  }

  return json({ updated: updated.length, items: updated });
}
