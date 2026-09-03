// 電気設備点検（12）の1記録の削除。[id] は client_id（取り込み元アプリの Record.id）。
//   DELETE /api/electrical-inspections/:client_id  （editor以上・論理削除・監査）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureElectricalSchema } from './index.js';

export async function onRequestDelete({ env, params, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  await ensureElectricalSchema(db);

  const clientId = params.id;
  const row = await db.prepare(
    'SELECT id FROM electrical_inspection WHERE client_id = ? AND deleted_at IS NULL'
  ).bind(clientId).first();
  if (!row) return jsonError(404, '記録が見つかりません');

  const now = nowIso();
  await db.prepare(
    'UPDATE electrical_inspection SET deleted_at = ?, deleted_by = ? WHERE client_id = ?'
  ).bind(now, data.user.email, clientId).run();
  await writeAuditLog(db, {
    tableName: 'electrical_inspection', recordId: row.id, action: 'delete', changedBy: data.user.email,
  });
  return json({ ok: true });
}
