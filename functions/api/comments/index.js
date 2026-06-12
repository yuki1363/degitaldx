import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const ALLOWED_TABLES = ['trouble_record', 'inspection_result', 'repair_request', 'daily_report'];

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const relatedTable = sp.get('related_table');
  const relatedId    = sp.get('related_id');

  if (!relatedTable || !relatedId) return jsonError(400, 'related_table と related_id は必須です');

  const { results } = await db.prepare(`
    SELECT c.*, u.name AS author_name
    FROM comments c
    LEFT JOIN users u ON c.created_by = u.email
    WHERE c.related_table = ? AND c.related_id = ? AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC
  `).bind(relatedTable, Number(relatedId)).all();

  return json({ comments: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { related_table, related_id, body: commentBody } = body ?? {};

  if (!related_table || !ALLOWED_TABLES.includes(related_table)) return jsonError(400, 'related_table が不正です');
  if (!related_id) return jsonError(400, 'related_id は必須です');
  if (!commentBody?.trim()) return jsonError(400, 'コメント本文は必須です');

  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(`
    INSERT INTO comments (related_table, related_id, body, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(related_table, Number(related_id), commentBody.trim(), userEmail, now, userEmail, now).run();

  const id = result.meta?.last_row_id;
  await writeAuditLog(db, { tableName: 'comments', recordId: id, action: 'create', changedBy: userEmail, diff: { related_table, related_id, body: commentBody.trim() } });
  return json({ id }, 201);
}
