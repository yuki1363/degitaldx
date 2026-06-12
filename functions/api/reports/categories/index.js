import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB
    .prepare(`SELECT * FROM report_category WHERE deleted_at IS NULL ORDER BY sort_order, id`)
    .all();
  return json({ categories: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { name, sort_order = 0 } = body ?? {};
  if (!name?.trim()) return jsonError(400, 'name は必須です');

  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(`
    INSERT INTO report_category (name, sort_order, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(name.trim(), sort_order, userEmail, now, userEmail, now).run();
  const id = result.meta?.last_row_id;

  await writeMasterHistory(db, { masterName: 'report_category', recordId: id, snapshot: { name: name.trim(), sort_order }, changedBy: userEmail });
  await writeAuditLog(db, { tableName: 'report_category', recordId: id, action: 'create', changedBy: userEmail, diff: { name: name.trim(), sort_order } });
  return json({ id }, 201);
}
