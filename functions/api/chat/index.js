import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const channel = sp.get('channel') || 'general';
  const since   = sp.get('since');        // ISO timestamp：これ以降のみ取得
  const limit   = Math.min(Number(sp.get('limit')) || 50, 200);

  let sql = `
    SELECT cm.*, u.name AS author_name
    FROM chat_messages cm
    LEFT JOIN users u ON cm.created_by = u.email
    WHERE cm.channel = ? AND cm.deleted_at IS NULL
  `;
  const binds = [channel];

  if (since) { sql += ` AND cm.created_at > ?`; binds.push(since); }

  sql += ` ORDER BY cm.created_at ${since ? 'ASC' : 'DESC'} LIMIT ?`;
  binds.push(limit);

  const { results } = await db.prepare(sql).bind(...binds).all();
  const messages = since ? (results ?? []) : (results ?? []).reverse();
  return json({ messages });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { body: msgBody, channel = 'general' } = body ?? {};
  if (!msgBody?.trim()) return jsonError(400, 'メッセージ本文は必須です');

  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(`
    INSERT INTO chat_messages (channel, body, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(channel, msgBody.trim(), userEmail, now, userEmail, now).run();

  const id = result.meta?.last_row_id;
  await writeAuditLog(db, {
    tableName: 'chat_messages',
    recordId: id,
    action: 'create',
    changedBy: userEmail,
    diff: { channel, body: msgBody.trim() },
  });

  return json({ id }, 201);
}
