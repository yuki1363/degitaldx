// 共通ユーティリティ

/**
 * 現在時刻を UTC の ISO 8601（秒精度・例 2026-06-12T01:23:45Z）で返す。
 * D1 へ保存する日時はすべてこの形式で統一する（表示時に JST へ変換）。
 */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
