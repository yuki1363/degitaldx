import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureColumns } from '../_lib/db-compat.js';

// 後付けの列・テーブルを、未マイグレーションの本番DBでも自動で用意する（自己修復）。
//   file_ids_json 列が無いDBでは投稿INSERTが「has no column named」で500になるため、
//   投稿・既読更新の入口で必ず呼ぶ。適用済みなら何もしない（1プロセス1回だけ実行）。
export async function ensureChatSchema(db) {
  await ensureColumns(db, 'chat_schema', [
    'ALTER TABLE chat_messages ADD COLUMN file_ids_json TEXT',
    `CREATE TABLE IF NOT EXISTS chat_channel_reads (
       channel       TEXT NOT NULL,
       user_email    TEXT NOT NULL,
       last_read_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       PRIMARY KEY (channel, user_email)
     )`,
    // 📌ピン留め（ピン中は10日自動削除の対象外）
    'ALTER TABLE chat_messages ADD COLUMN pinned_at TEXT',
    'ALTER TABLE chat_messages ADD COLUMN pinned_by TEXT',
    // 👍確認リアクション（既読とは別の「了解した」表明。1メッセージ×1ユーザーで1件）
    `CREATE TABLE IF NOT EXISTS chat_reactions (
       message_id  INTEGER NOT NULL,
       user_email  TEXT    NOT NULL,
       created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       PRIMARY KEY (message_id, user_email)
     )`,
  ]);
}

// ---- 古いメッセージの自動削除（送信から10日）----
//   チャットは短期の引き継ぎ用途のため、10日を過ぎたメッセージは自動で物理削除して
//   DBとR2を軽く保つ。添付ファイルは R2 オブジェクトも削除し、files は purged 扱いにする
//   （容量集計から除外される）。GET の応答をブロックしないよう waitUntil で実行し、
//   1プロセスにつき1時間に1回だけ動かす（3名運用では十分）。
const CHAT_RETENTION_DAYS = 10;
let lastCleanupAt = 0;

async function cleanupOldMessages(env) {
  const db = env.DB;
  const cutoff = new Date(Date.now() - CHAT_RETENTION_DAYS * 86400000).toISOString();
  // 📌ピン留め中のメッセージは削除しない（重要な申し送りを残す。解除すると次回の対象になる）
  const { results: olds } = await db
    .prepare('SELECT id, file_ids_json FROM chat_messages WHERE created_at < ? AND pinned_at IS NULL')
    .bind(cutoff).all();
  if (!olds || olds.length === 0) return;

  // 添付ファイルを R2 ごと削除（失敗しても本体の削除は続行）
  const now = nowIso();
  for (const m of olds) {
    let fileIds = [];
    try { const a = JSON.parse(m.file_ids_json || 'null'); if (Array.isArray(a)) fileIds = a; } catch { /* 壊れたJSONは無視 */ }
    for (const fid of fileIds) {
      try {
        const f = await db.prepare('SELECT r2_key, purged_at FROM files WHERE id = ?').bind(fid).first();
        if (f && !f.purged_at) {
          try { if (env.FILES) await env.FILES.delete(f.r2_key); } catch { /* R2削除失敗は無視 */ }
          await db.prepare(
            `UPDATE files SET purged_at = ?, purged_by = ?, deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(deleted_by, ?) WHERE id = ?`
          ).bind(now, 'system:chat-cleanup', now, 'system:chat-cleanup', fid).run();
        }
      } catch { /* purged列が無い旧DB等でもメッセージ削除は続行 */ }
    }
  }

  // リアクションも本体と一緒に物理削除（孤児レコードを残さない）
  try {
    await db.prepare(
      'DELETE FROM chat_reactions WHERE message_id IN (SELECT id FROM chat_messages WHERE created_at < ? AND pinned_at IS NULL)'
    ).bind(cutoff).run();
  } catch { /* chat_reactions が無い旧DBでも本体の削除は続行 */ }
  await db.prepare('DELETE FROM chat_messages WHERE created_at < ? AND pinned_at IS NULL').bind(cutoff).run();
  await writeAuditLog(db, {
    tableName: 'chat_messages', recordId: 'auto-cleanup', action: 'delete',
    changedBy: 'system:chat-cleanup', diff: { deleted_count: olds.length, cutoff },
  });
}

// 直近20件ぶんの既読数・リアクションと、ピン留め一覧をまとめて返す。
//   一覧GET・ポーリングGETの両方に載せることで、既読数/リアクション/ピンが
//   画面リロードなしで（5秒ポーリングで）ライブ更新される。
async function buildChatMeta(db, channel, userEmail) {
  const meta = {};
  let pinned = [];
  try {
    const { results: latest } = await db.prepare(
      `SELECT id, created_at, created_by FROM chat_messages
        WHERE channel = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 20`
    ).bind(channel).all();

    const { results: reads } = await db.prepare(
      'SELECT user_email, last_read_at FROM chat_channel_reads WHERE channel = ?'
    ).bind(channel).all();

    let reactions = [];
    const ids = (latest ?? []).map((m) => m.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const { results } = await db.prepare(
        `SELECT r.message_id, r.user_email, COALESCE(u.name, r.user_email) AS name
           FROM chat_reactions r
           LEFT JOIN users u ON u.email = r.user_email
          WHERE r.message_id IN (${placeholders})`
      ).bind(...ids).all();
      reactions = results ?? [];
    }

    for (const m of latest ?? []) {
      meta[m.id] = {
        // 既読数（送信者本人は数えない）
        read_count: (reads ?? []).filter((r) => r.last_read_at >= m.created_at && r.user_email !== m.created_by).length,
        reactions:  reactions.filter((r) => r.message_id === m.id).map((r) => r.name),
        my_react:   userEmail ? reactions.some((r) => r.message_id === m.id && r.user_email === userEmail) : false,
      };
    }

    const { results: pinnedRows } = await db.prepare(
      `SELECT cm.*, u.name AS author_name
         FROM chat_messages cm
         LEFT JOIN users u ON cm.created_by = u.email
        WHERE cm.channel = ? AND cm.deleted_at IS NULL AND cm.pinned_at IS NOT NULL
        ORDER BY cm.pinned_at DESC LIMIT 10`
    ).bind(channel).all();
    pinned = pinnedRows ?? [];
  } catch { /* 未マイグレーション環境では meta なしで返す（表示は劣化するが動作は継続） */ }
  return { meta, pinned };
}

export async function onRequestGet({ request, env, data, waitUntil }) {
  await ensureChatSchema(env.DB); // 既読テーブル等を自動で用意（未読数・既読数の表示に必要）

  // 10日より古いメッセージの自動削除（1時間に1回・応答をブロックしない）
  if (Date.now() - lastCleanupAt > 3600_000) {
    lastCleanupAt = Date.now();
    const p = cleanupOldMessages(env).catch(() => { /* 失敗しても次回再試行 */ });
    if (typeof waitUntil === 'function') waitUntil(p);
  }
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
      // 最新メッセージを既読した人数（last_read_at >= latest message）。
      // 送信者本人は「既読」に数えない（自分の投稿を自分が見ても既読が付かないように）。
      // total_users も送信者を除いた人数を返す（表示は「◯人中N人既読」のまま意味が正しくなる）。
      const latestRow = await db.prepare(
        'SELECT created_at AS latest, created_by AS author FROM chat_messages WHERE channel = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1'
      ).bind(channel).first();
      const tRow = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').first();
      totalUsers = tRow?.n ?? 0;
      if (latestRow?.latest) {
        const rRow = await db.prepare(
          'SELECT COUNT(*) AS n FROM chat_channel_reads WHERE channel = ? AND last_read_at >= ? AND user_email != ?'
        ).bind(channel, latestRow.latest, latestRow.author || '').first();
        readers = rRow?.n ?? 0;
        totalUsers = Math.max(0, totalUsers - 1); // 分母からも送信者を除く
      }
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

  // 既読数・リアクション・ピン一覧（直近20件ぶん）。ポーリングGETにも載せてライブ更新する
  const { meta, pinned } = await buildChatMeta(db, channel, data?.user?.email);
  const enriched = messages.map((m) => ({ ...m, read_count: meta[m.id]?.read_count }));
  return json({ messages: enriched, meta, pinned });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  await ensureChatSchema(db); // file_ids_json 列を自動で用意（未マイグレーションでも500にしない）
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

// PUT /api/chat?channel=... — 既読位置を更新（フロントは js/chat.js が呼ぶ）
export async function onRequestPut({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  await ensureChatSchema(db); // 既読テーブルを自動で用意（未マイグレーションでも既読が記録されるように）
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
