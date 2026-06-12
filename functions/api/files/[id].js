// /api/files/:id — ファイル取得・削除
//
//   GET    : 認証済みユーザー全員（viewer 以上）。R2 オブジェクトを返す。
//            動画再生（iOS Safari 等）のため Range リクエストに対応。
//   DELETE : editor 以上。論理削除（R2 オブジェクトは残し、一覧から消す）。
//            ※ 容量を空ける物理削除は管理画面（Phase 5）で実装予定

import { json, jsonError } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';

async function findFile(env, idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  return env.DB.prepare(
    `SELECT id, r2_key, file_name, content_type, size_bytes
       FROM files
      WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(id)
    .first();
}

/** Range ヘッダー（単一範囲のみ）を解釈する。不正なら 'invalid'、無ければ null */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start;
  let end;
  if (m[1] === '') {
    // bytes=-N : 末尾 N バイト
    const suffix = Number(m[2]);
    if (suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

export async function onRequestGet({ request, env, data, params }) {
  // 閲覧は認証済みユーザー全員（ミドルウェアで認証済み = viewer 以上）
  const file = await findFile(env, params.id);
  if (!file) return jsonError(404, 'ファイルが見つかりません。');

  const range = parseRange(request.headers.get('Range'), file.size_bytes);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${file.size_bytes}` },
    });
  }

  const object = await env.FILES.get(file.r2_key, range ? { range } : undefined);
  if (!object) {
    // D1 に台帳はあるが R2 にオブジェクトが無い（通常起きない）
    return jsonError(404, 'ファイル本体が見つかりません。管理者に連絡してください。');
  }

  const headers = new Headers({
    'Content-Type': file.content_type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=600',
    ETag: object.httpEtag,
    // 日本語ファイル名は RFC 5987 形式で渡す（ASCII フォールバック付き）
    'Content-Disposition': `inline; filename="file-${file.id}"; filename*=UTF-8''${encodeURIComponent(file.file_name).replace(/'/g, '%27')}`,
  });

  if (range) {
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size_bytes}`
    );
    headers.set('Content-Length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(file.size_bytes));
  return new Response(object.body, { status: 200, headers });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const file = await findFile(env, params.id);
  if (!file) return jsonError(404, 'ファイルが見つかりません。');

  await env.DB.prepare(
    `UPDATE files SET deleted_by = ?1, deleted_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`
  )
    .bind(data.user.email, nowIso(), file.id)
    .run();

  await writeAuditLog(env.DB, {
    tableName: 'files',
    recordId: file.id,
    action: 'delete',
    changedBy: data.user.email,
    diff: { file_name: file.file_name },
  });

  return json({ ok: true, id: file.id });
}
