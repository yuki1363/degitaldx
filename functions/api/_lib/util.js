// 共通ユーティリティ

/**
 * 現在時刻を UTC の ISO 8601（秒精度・例 2026-06-12T01:23:45Z）で返す。
 * D1 へ保存する日時はすべてこの形式で統一する（表示時に JST へ変換）。
 */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// 日時の入力（ISO 8601・タイムゾーン付き）を、保存形式（UTC・秒精度・末尾Z）にそろえる。不正なら null。
//   期間の絞り込みは文字列比較（jstDayStartUtc 等）なので、形式が違う値（日付だけ・ミリ秒付き・+09:00 付き・
//   ただの文字列）が入ると、一覧・集計の期間から黙って外れていた
export function normalizeUtcIso(value) {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- JST の日付境界（期間絞り込み・日付表示） ----
//   日時列（occurred_at / inspected_at / created_at / changed_at 等）は UTC で保存している。
//   画面の期間指定「YYYY-MM-DD」は JST の日付なので、UTC の日付境界（T00:00:00Z / T23:59:59Z）で
//   比べると 9 時間ずれ、JST 0:00〜8:59 の記録が前日・前月に入る。以下で JST の境界へ変換する。
//   ※ report_date / planned_date など「日付だけの列」は変換不要（そのまま比べる）。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const JST_OFFSET_MS = 9 * 3600_000;
const toSecondIso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'); // nowIso と同じ秒精度の形式

/** JST の日付 'YYYY-MM-DD' → その日 0:00（JST）の UTC ISO。「>=」で比べる。日付以外の値はそのまま返す */
export function jstDayStartUtc(date) {
  if (!DATE_ONLY_RE.test(date || '')) return date;
  const d = new Date(`${date}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return date; // 2026-13-45 のような存在しない日付で例外（500）にしない
  return toSecondIso(d);
}

/** JST の日付 'YYYY-MM-DD' → 翌日 0:00（JST）の UTC ISO。「<」で比べる（その日の終わりまでを含む） */
export function jstNextDayStartUtc(date) {
  if (!DATE_ONLY_RE.test(date || '')) return date;
  const t = new Date(`${date}T00:00:00+09:00`).getTime();
  if (Number.isNaN(t)) return date; // 存在しない日付で例外（500）にしない
  return toSecondIso(new Date(t + 24 * 3600_000));
}

/** 日付だけの値 'YYYY-MM-DD' が実在する日付か（2026-13-45・2026-02-31・文字列「abc」は false） */
export function isValidYmd(value) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// ---- LIKE 検索（部分一致）の安全な組み立て ----
//   検索語に含まれる % _ \ は LIKE のワイルドカード・エスケープ文字なので、そのまま使うと
//   「100%」で全件が一致する・「A_1」の _ が任意の1文字になる。退避してから使い、
//   SQL 側は `LIKE ? ESCAPE '\'` と書く（LIKE_ESCAPE）。
export const LIKE_ESCAPE = " ESCAPE '\\'";
export function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, '\\$&');
}
/** 部分一致用のパターン（%…%）。値のワイルドカードは退避済み */
export function likeContains(value) {
  return `%${escapeLike(value)}%`;
}

/** UTC の ISO 日時 → JST の日付 'YYYY-MM-DD'（日付だけの値・解釈できない値はそのまま） */
export function toJstDate(value) {
  if (!value || DATE_ONLY_RE.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 今日の日付（JST）'YYYY-MM-DD' */
export function jstToday() {
  return new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);
}
