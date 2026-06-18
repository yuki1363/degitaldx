// R2 ストレージの容量上限ガード・アップロード検証の共通モジュール
//
// 無料枠（10GB）を超えて課金が発生しないよう、アプリ側でハードリミットを設ける:
//   - 使用量 = files テーブルの SUM(size_bytes)（= R2 に存在する全オブジェクト）
//   - ハードリミット（既定 9GB = 無料枠に対し 1GB の安全マージン）を超える
//     アップロードは HTTP 507 で拒否する
//   - 警告ライン（既定 8GB）を超えたら応答に warning を付け、画面で注意喚起する
//   - 論理削除されたファイルも R2 にオブジェクトが残るため使用量に含める
//     （R2 オブジェクトごと消す物理削除は管理画面（Phase 5）で実装予定）
//   - 環境変数 R2_HARD_LIMIT_BYTES / R2_WARN_BYTES で上限を変更できる
//     （ローカルでの拒否動作テストにも使う）

const DEFAULT_HARD_LIMIT_BYTES = 9_000_000_000; // 9 GB
const DEFAULT_WARN_BYTES = 8_000_000_000; // 8 GB

// 種別ごとの許可 Content-Type / 拡張子 / 1ファイルあたりのサイズ上限
// （CLAUDE.md: 画像10MB・動画100MB目安。PDF はマニュアル・図面用に 20MB）
export const FILE_RULES = {
  'image/jpeg': { exts: ['.jpg', '.jpeg'], maxBytes: 10 * 1024 * 1024, label: '画像' },
  'image/png': { exts: ['.png'], maxBytes: 10 * 1024 * 1024, label: '画像' },
  'image/webp': { exts: ['.webp'], maxBytes: 10 * 1024 * 1024, label: '画像' },
  'video/mp4': { exts: ['.mp4'], maxBytes: 100 * 1024 * 1024, label: '動画' },
  'video/quicktime': { exts: ['.mov'], maxBytes: 100 * 1024 * 1024, label: '動画' },
  'application/pdf': { exts: ['.pdf'], maxBytes: 20 * 1024 * 1024, label: 'PDF' },
};

// 添付先として許可するテーブル名（各機能の実装フェーズで使用）
export const RELATED_TABLES = [
  'equipment_ledger',
  'inspection_result',
  'repair_request',
  'trouble_record',
  'maintenance_plan',
  'daily_report',
  'comments',
  'chat_messages',
  'print_templates', // 帳票テンプレートの背景用紙画像
];

/**
 * アップロード済みファイルをレコードに紐づける（点検記録・設備資料などの保存時に使う）。
 * 未紐づけ（related_id IS NULL）か、同じレコードに紐づいているファイルのみ更新できる。
 * @returns 紐づけた件数
 */
export async function attachFiles(env, { fileIds, relatedTable, relatedId, userEmail, now }) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return 0;
  const ids = fileIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return 0;

  // プリペアドステートメント（IN句はプレースホルダを件数分生成）
  const placeholders = ids.map((_, i) => `?${i + 5}`).join(', ');
  const result = await env.DB.prepare(
    `UPDATE files
        SET related_table = ?1, related_id = ?2, updated_by = ?3, updated_at = ?4
      WHERE id IN (${placeholders})
        AND deleted_at IS NULL
        AND (related_id IS NULL OR (related_table = ?1 AND related_id = ?2))`
  )
    .bind(relatedTable, relatedId, userEmail, now, ...ids)
    .run();
  return result.meta.changes;
}

/** レコードに紐づくファイル一覧（添付表示用） */
export async function listAttachedFiles(env, relatedTable, relatedId) {
  const { results } = await env.DB.prepare(
    `SELECT id, file_name, content_type, size_bytes, created_by, created_at
       FROM files
      WHERE related_table = ?1 AND related_id = ?2 AND deleted_at IS NULL
      ORDER BY id`
  )
    .bind(relatedTable, relatedId)
    .all();
  return results;
}

export function getLimits(env) {
  return {
    hardLimitBytes: Number(env.R2_HARD_LIMIT_BYTES) || DEFAULT_HARD_LIMIT_BYTES,
    warnBytes: Number(env.R2_WARN_BYTES) || DEFAULT_WARN_BYTES,
  };
}

/** 現在の使用量と上限を返す（warning: 警告ライン超え） */
export async function getStorageUsage(env) {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS used_bytes FROM files'
  ).first();
  const { hardLimitBytes, warnBytes } = getLimits(env);
  const usedBytes = row ? row.used_bytes : 0;
  return {
    used_bytes: usedBytes,
    hard_limit_bytes: hardLimitBytes,
    warn_bytes: warnBytes,
    used_percent: Math.round((usedBytes / hardLimitBytes) * 1000) / 10,
    warning: usedBytes >= warnBytes,
  };
}

/** ファイル名から余計なパス・制御文字を除去する */
export function sanitizeFileName(name) {
  const base = String(name)
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim();
  return base.slice(0, 120) || 'file';
}

/**
 * アップロード前の検証（Content-Type / 拡張子 / 1ファイルサイズ上限）。
 * 問題があれば { error: { status, message } }、なければ { rule, ext } を返す。
 */
export function validateFileMeta({ fileName, contentType, sizeBytes }) {
  const rule = FILE_RULES[contentType];
  if (!rule) {
    return {
      error: {
        status: 415,
        message: `このファイル形式（${contentType || '不明'}）はアップロードできません。対応形式: JPEG / PNG / WebP / MP4 / MOV / PDF`,
      },
    };
  }

  const extMatch = /\.[a-z0-9]+$/.exec(fileName.toLowerCase());
  const ext = extMatch ? extMatch[0] : '';
  if (!rule.exts.includes(ext)) {
    return {
      error: {
        status: 415,
        message: `拡張子（${ext || 'なし'}）がファイル形式（${contentType}）と一致しません。`,
      },
    };
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { error: { status: 400, message: 'ファイルサイズが不正です（空ファイルは保存できません）。' } };
  }
  if (sizeBytes > rule.maxBytes) {
    const maxMb = Math.round(rule.maxBytes / 1024 / 1024);
    return {
      error: {
        status: 413,
        message: `${rule.label}は1ファイル ${maxMb}MB までです。`,
      },
    };
  }

  return { rule, ext };
}
