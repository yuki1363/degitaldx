import { requireRole, hasRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestDelete({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await db.prepare(`SELECT * FROM chat_messages WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!existing) return jsonError(404, 'メッセージが見つかりません');

  if (!hasRole(data.user, 'admin') && existing.created_by !== data.user.email) {
    return jsonError(403, '自分のメッセージのみ削除できます');
  }

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(`UPDATE chat_messages SET deleted_by=?, deleted_at=? WHERE id=?`).bind(userEmail, now, id).run();
  await writeAuditLog(db, { tableName: 'chat_messages', recordId: id, action: 'delete', changedBy: userEmail, diff: null });
  return json({ ok: true });
}
