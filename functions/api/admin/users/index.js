import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

export async function onRequestGet({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT id, email, name, group_name, role, created_at, deleted_at
     FROM users ORDER BY deleted_at IS NOT NULL, name`
  ).all();
  return json({ users: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { email, name, group_name, role = 'viewer' } = body ?? {};
  if (!email?.trim()) return jsonError(400, 'email は必須です');
  if (!name?.trim())  return jsonError(400, 'name は必須です');
  if (!['viewer', 'editor', 'admin'].includes(role)) return jsonError(400, '不正な role です');

  const exists = await db.prepare(`SELECT id FROM users WHERE lower(email) = lower(?)`).bind(email.trim()).first();
  if (exists) return jsonError(409, 'このメールアドレスは既に登録されています');

  const now = nowIso();
  const userEmail = data.user.email;
  const result = await db.prepare(`
    INSERT INTO users (email, name, group_name, role, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(email.trim(), name.trim(), group_name?.trim() || null, role, userEmail, now, userEmail, now).run();

  const id = result.meta?.last_row_id;
  await writeAuditLog(db, { tableName: 'users', recordId: id, action: 'create', changedBy: userEmail, diff: { email: email.trim(), name: name.trim(), group_name, role } });
  return json({ id }, 201);
}
