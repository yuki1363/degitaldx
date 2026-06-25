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

// ユーザーは論理削除ではなく物理削除する（無効化ではなく完全削除）。
//   ・各テーブルの created_by 等はメール文字列を保持しているため、users 行を消しても
//     過去レコードは壊れない（履歴上のメールはそのまま残る）。
//   ・物理削除すれば同じメールを後から再登録できる（無効化だと重複扱いで再登録不可だった）。
//   ・誰を削除したかは audit_log に削除時点の情報を残す（行自体は消えるため diff に保存）。
export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  if (!existing) return jsonError(404, 'ユーザーが見つかりません');

  if (existing.email === data.user.email) return jsonError(400, '自分自身を削除することはできません');

  const userEmail = data.user.email;

  await db.prepare(`DELETE FROM users WHERE id=?`).bind(id).run();
  await writeAuditLog(db, {
    tableName: 'users', recordId: id, action: 'delete', changedBy: userEmail,
    diff: { email: existing.email, name: existing.name, group_name: existing.group_name, role: existing.role },
  });
  return json({ ok: true });
}
