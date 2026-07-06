import { requireRole, hasRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureChatSchema } from './index.js';

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

// POST /api/chat/:id — 👍確認リアクションのトグル（「了解した」の表明。既読=見た とは別）
export async function onRequestPost({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  await ensureChatSchema(db); // chat_reactions テーブルを自動で用意
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const msg = await db.prepare('SELECT id FROM chat_messages WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!msg) return jsonError(404, 'メッセージが見つかりません');

  const email = data.user.email;
  const existing = await db.prepare(
    'SELECT 1 AS x FROM chat_reactions WHERE message_id = ? AND user_email = ?'
  ).bind(id, email).first();

  let reacted;
  if (existing) {
    await db.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user_email = ?').bind(id, email).run();
    reacted = false;
  } else {
    await db.prepare(
      'INSERT INTO chat_reactions (message_id, user_email, created_at) VALUES (?, ?, ?)'
    ).bind(id, email, nowIso()).run();
    reacted = true;
  }
  await writeAuditLog(db, {
    tableName: 'chat_reactions', recordId: id,
    action: reacted ? 'create' : 'delete',
    changedBy: email, diff: { message_id: id },
  });
  return json({ reacted });
}

// PUT /api/chat/:id — 📌ピン留めのトグル。ピン中は10日自動削除の対象外＋画面上部に常時表示
export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  await ensureChatSchema(db); // pinned_at / pinned_by 列を自動で用意
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const body = await readJson(request);
  const pinned = body?.pinned === true;

  const msg = await db.prepare('SELECT id FROM chat_messages WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!msg) return jsonError(404, 'メッセージが見つかりません');

  const now = nowIso();
  const email = data.user.email;
  await db.prepare(
    'UPDATE chat_messages SET pinned_at = ?, pinned_by = ?, updated_by = ?, updated_at = ? WHERE id = ?'
  ).bind(pinned ? now : null, pinned ? email : null, email, now, id).run();

  await writeAuditLog(db, {
    tableName: 'chat_messages', recordId: id, action: 'update',
    changedBy: email, diff: { pinned },
  });
  return json({ pinned });
}
