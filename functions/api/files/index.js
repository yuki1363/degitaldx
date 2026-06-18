// POST /api/files — ファイルアップロード（R2 へ保存・容量上限ガード付き）
//
//   呼び出し方（ボディはファイルのバイナリそのまま。multipart ではない）:
//     fetch('/api/files?filename=photo.jpg&related_table=trouble_record&related_id=1', {
//       method: 'POST',
//       headers: { 'Content-Type': file.type },
//       body: file,
//     })
//
//   検証（すべてサーバー側）:
//     - 権限: editor 以上
//     - Content-Type / 拡張子 / 1ファイルサイズ上限（storage.js の FILE_RULES）
//     - 容量上限ガード: 使用量 + 今回サイズ がハードリミットを超えるなら 507 で拒否
//   ※ 同時アップロードでチェックがすれ違う理論上の余地はあるが、
//     ハードリミット自体に 1GB のマージンがあるため実害はない（10名規模）

import { json, jsonError } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';
import {
  getStorageUsage,
  sanitizeFileName,
  validateFileMeta,
  RELATED_TABLES,
} from '../_lib/storage.js';

// GET /api/files — 管理画面「ファイル容量」用のファイル一覧（admin のみ）
//   物理削除（purged_at）済みは除外。サイズの大きい順に返す（容量を空けやすいように）。
export async function onRequestGet({ env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const cols = `id, file_name, content_type, size_bytes, related_table, related_id,
                created_by, created_at, deleted_at, deleted_by`;
  let results;
  try {
    ({ results } = await env.DB.prepare(
      `SELECT ${cols} FROM files WHERE purged_at IS NULL ORDER BY size_bytes DESC, id DESC LIMIT 500`
    ).all());
  } catch {
    // purged_at 未追加の環境向けフォールバック
    ({ results } = await env.DB.prepare(
      `SELECT ${cols} FROM files ORDER BY size_bytes DESC, id DESC LIMIT 500`
    ).all());
  }
  return json({ files: results ?? [], usage: await getStorageUsage(env) });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const url = new URL(request.url);
  const fileName = sanitizeFileName(url.searchParams.get('filename') || '');
  const contentType = (request.headers.get('Content-Type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const contentLength = Number(request.headers.get('Content-Length'));

  if (!url.searchParams.get('filename')) {
    return jsonError(400, 'クエリパラメータ filename を指定してください。');
  }
  if (!Number.isFinite(contentLength)) {
    return jsonError(400, 'Content-Length ヘッダーが必要です。');
  }

  // 添付先（任意）。指定する場合は許可テーブルのみ
  const relatedTable = url.searchParams.get('related_table') || null;
  const relatedIdRaw = url.searchParams.get('related_id');
  const relatedId = relatedIdRaw === null || relatedIdRaw === '' ? null : Number(relatedIdRaw);
  if (relatedTable !== null && !RELATED_TABLES.includes(relatedTable)) {
    return jsonError(400, `related_table が不正です: ${relatedTable}`);
  }
  if (relatedId !== null && !Number.isInteger(relatedId)) {
    return jsonError(400, 'related_id は整数で指定してください。');
  }

  // 種別・拡張子・1ファイルサイズ上限の検証
  const meta = validateFileMeta({ fileName, contentType, sizeBytes: contentLength });
  if (meta.error) return jsonError(meta.error.status, meta.error.message);

  // R2 バインディング未設定の場合は明示的なエラーを返す（バケット未作成・未接続の場合）
  if (!env.FILES) {
    return jsonError(503, 'ファイル保存が設定されていません（R2バインディング未設定）。Cloudflare Pages の設定を確認してください。');
  }

  // 容量上限ガード（無料枠10GBを超えない）
  let usage;
  try {
    usage = await getStorageUsage(env);
  } catch (err) {
    console.error('files upload: getStorageUsage failed:', err && err.stack ? err.stack : err);
    return jsonError(500, '保存容量の集計に失敗しました（D1 の files テーブルが未作成の可能性があります。schema.sql の適用を確認してください）。');
  }
  if (usage.used_bytes + contentLength > usage.hard_limit_bytes) {
    return jsonError(
      507,
      '保存容量の上限に達したためアップロードできません。不要な動画・ファイルの整理を管理者に依頼してください。',
      { usage }
    );
  }

  // R2 へ保存（リクエストボディをストリームのまま渡す。メモリに載せない）
  const now = new Date();
  const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const r2Key = `uploads/${ym}/${crypto.randomUUID()}${meta.ext}`;
  let object;
  try {
    object = await env.FILES.put(r2Key, request.body, {
      httpMetadata: { contentType },
    });
  } catch (err) {
    console.error('files upload: R2 put failed:', err && err.stack ? err.stack : err);
    return jsonError(502, 'ファイルの保存に失敗しました（R2バケットの設定・バインディング FILES を確認してください）。');
  }
  if (!object) {
    return jsonError(502, 'ファイルの保存に失敗しました（R2が応答しませんでした）。');
  }

  // メタデータを D1 に記録（実サイズは R2 が受け取った object.size を正とする）
  let fileId;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO files
         (r2_key, file_name, content_type, size_bytes, related_table, related_id, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(r2Key, fileName, contentType, object.size, relatedTable, relatedId, data.user.email, nowIso())
      .run();
    fileId = result.meta.last_row_id;

    await writeAuditLog(env.DB, {
      tableName: 'files',
      recordId: fileId,
      action: 'create',
      changedBy: data.user.email,
      diff: { file_name: fileName, content_type: contentType, size_bytes: object.size, related_table: relatedTable, related_id: relatedId },
    });
  } catch (err) {
    console.error('files upload: D1 insert failed:', err && err.stack ? err.stack : err);
    // R2 には保存済みだが D1 記録に失敗 → 不整合を避けるため R2 を消す（ベストエフォート）
    try { await env.FILES.delete(r2Key); } catch { /* 消せなくても致命的ではない */ }
    return jsonError(500, 'ファイル情報の記録に失敗しました（D1 の files テーブルを確認してください）。');
  }

  let usageAfter;
  try {
    usageAfter = await getStorageUsage(env);
  } catch {
    usageAfter = usage; // 取得失敗してもアップロード自体は成功しているため直前の値で代用
  }
  return json(
    {
      file: {
        id: fileId,
        file_name: fileName,
        content_type: contentType,
        size_bytes: object.size,
        url: `/api/files/${fileId}`,
      },
      usage: usageAfter,
      // 警告ライン超え: フロントは「容量が残りわずか」の注意を表示する
      warning: usageAfter.warning
        ? `保存容量が警告ライン（${Math.round(usageAfter.warn_bytes / 1_000_000_000)}GB）を超えました。不要なファイルの整理を検討してください。`
        : null,
    },
    201
  );
}
