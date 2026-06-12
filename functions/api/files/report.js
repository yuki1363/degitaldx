// /api/files/report — 保存容量に関する管理者への報告
//
//   POST : 認証済みユーザー全員。アップロードが容量上限で拒否された（blocked）／
//          警告ラインを超えた（warning）ときに報告画面から送信される。
//          使用量はサーバー側で再取得して記録する（クライアントの値は信用しない）。
//   GET  : admin のみ。直近の報告一覧（ホーム画面の件数表示・管理画面用）。

import { json, jsonError, readJson } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';
import { getStorageUsage } from '../_lib/storage.js';

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  const context = body && body.context;
  if (context !== 'blocked' && context !== 'warning') {
    return jsonError(400, 'context は blocked または warning を指定してください。');
  }
  const message = body.message ? String(body.message).slice(0, 500) : null;

  const usage = await getStorageUsage(env);
  const result = await env.DB.prepare(
    `INSERT INTO storage_reports (context, used_bytes, hard_limit_bytes, message, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(context, usage.used_bytes, usage.hard_limit_bytes, message, data.user.email, nowIso())
    .run();

  const reportId = result.meta.last_row_id;
  await writeAuditLog(env.DB, {
    tableName: 'storage_reports',
    recordId: reportId,
    action: 'create',
    changedBy: data.user.email,
    diff: { context, used_bytes: usage.used_bytes, message },
  });

  return json({ ok: true, id: reportId }, 201);
}

export async function onRequestGet({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT id, context, used_bytes, hard_limit_bytes, message, created_by, created_at
       FROM storage_reports
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50`
  ).all();

  return json({ reports: results });
}
