import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestGet({ request, env, data }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const channel = sp.get('channel') || 'general';
  const since   = sp.get('since');
  const limit   = Math.min(Number(sp.get('limit')) || 50, 200);

  // count_unread=1: 現ユーザーの未読数 + 最新メッセージの既読者数を返す（ホーム概要タブ用）
  if (sp.get('count_unread') === '1') {
    const userEmail = data?.user?.email;
    let unreadCount = 0, readers = 0, totalUsers = 0;
    try {
      if (userEmail) {
        const readRow = await db.prepare(
          'SELECT last_read_at FROM chat_channel_reads WHERE channel = ? AND user_email = ?'
        ).bind(channel, userEmail).first();
        const since2 = readRow?.last_read_at || '1970-01-01T00:00:00.000Z';
        const cntRow = await db.prepare(
          'SELECT COUNT(*) AS n FROM chat_messages WHERE channel = ? AND deleted_at IS NULL AND created_at > ?'
        ).bind(channel, since2).first();
        unreadCount = cntRow?.n ?? 0;
      }
      // 最新メッセージを既読した人数（last_read_at >= latest message）
      const latestRow = await db.prepare(
        'SELECT MAX(created_at) AS latest FROM chat_messages WHERE channel = ? AND deleted_at IS NULL'
      ).bind(channel).first();
      if (latestRow?.latest) {
        const rRow = await db.prepare(
          'SELECT COUNT(*) AS n FROM chat_channel_reads WHERE channel = ? AND last_read_at >= ?'
        ).bind(channel, latestRow.latest).first();
        readers = rRow?.n ?? 0;
      }
      const tRow = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').first();
      totalUsers = tRow?.n ?? 0;
    } catch { /* 未マイグレーション環境ではスキップ */ }
    return json({ unread_count: unreadCount, readers, total_users: totalUsers });
  }

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

  // 既読ユーザー数: 各メッセージに対して「このメッセージ以降まで読んだ人数」を付与
  // 最新20件だけに付与（古いメッセージは全員既読扱いで十分）
  let readCounts = {};
  try {
    const { results: reads } = await db.prepare(
      'SELECT user_email, last_read_at FROM chat_channel_reads WHERE channel = ?'
    ).bind(channel).all();
    for (const msg of messages.slice(-20)) {
      readCounts[msg.id] = (reads ?? []).filter((r) => r.last_read_at >= msg.created_at).length;
    }
  } catch { /* 未マイグレーション時はスキップ */ }

  const enriched = messages.map((m) => ({ ...m, read_count: readCounts[m.id] ?? undefined }));
  return json({ messages: enriched });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { body: msgBody, channel = 'general', file_ids } = body ?? {};
  if (!msgBody?.trim() && (!file_ids || file_ids.length === 0)) {
    return jsonError(400, 'メッセージ本文またはファイルを指定してください');
  }

  const now = nowIso();
  const userEmail = data.user.email;
  const fileIdsJson = Array.isArray(file_ids) && file_ids.length > 0
    ? JSON.stringify(file_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))
    : null;

  const result = await db.prepare(`
    INSERT INTO chat_messages (channel, body, file_ids_json, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(channel, (msgBody || '').trim(), fileIdsJson, userEmail, now, userEmail, now).run();

  const id = result.meta?.last_row_id;
  await writeAuditLog(db, {
    tableName: 'chat_messages',
    recordId: id,
    action: 'create',
    changedBy: userEmail,
    diff: { channel, body: (msgBody || '').trim(), file_ids: file_ids || [] },
  });

  return json({ id }, 201);
}

// PUT /api/chat/read — 既読位置を更新（channel クエリパラメータで指定）
export async function onRequestPut({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  const channel = new URL(request.url).searchParams.get('channel') || 'general';
  const now = nowIso();
  try {
    await db.prepare(
      `INSERT INTO chat_channel_reads (channel, user_email, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel, user_email) DO UPDATE SET last_read_at = ?`
    ).bind(channel, data.user.email, now, now).run();
  } catch { /* 未マイグレーション時はスキップ */ }
  return json({ ok: true });
}
