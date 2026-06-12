import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(404, 'ユーザーが見つかりません');

  const body = await readJson(request);
  const { name, group_name, role } = body ?? {};
  if (!name?.trim()) return jsonError(400, 'name は必須です');
  if (!['viewer', 'editor', 'admin'].includes(role)) return jsonError(400, '不正な role です');

  // 自分自身の権限を下げることは禁止
  if (existing.email === data.user.email && role !== 'admin') {
    return jsonError(400, '自分自身の管理者権限を外すことはできません');
  }

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(`
    UPDATE users SET name=?, group_name=?, role=?, deleted_at=NULL, deleted_by=NULL,
      updated_by=?, updated_at=? WHERE id=?
  `).bind(name.trim(), group_name?.trim() || null, role, userEmail, now, id).run();

  await writeAuditLog(db, { tableName: 'users', recordId: id, action: 'update', changedBy: userEmail, diff: { before: { name: existing.name, group_name: existing.group_name, role: existing.role }, after: { name: name.trim(), group_name, role } } });
  return json({ ok: true });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await db.prepare(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!existing) return jsonError(404, 'ユーザーが見つかりません');

  if (existing.email === data.user.email) return jsonError(400, '自分自身を削除することはできません');

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(`UPDATE users SET deleted_by=?, deleted_at=? WHERE id=?`).bind(userEmail, now, id).run();
  await writeAuditLog(db, { tableName: 'users', recordId: id, action: 'delete', changedBy: userEmail, diff: null });
  return json({ ok: true });
}
