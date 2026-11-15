// 08 ダッシュボード: 集計の計算（前年度比・設備別ワースト・繰り返しトラブル・曜日×時間帯）。
//   他の import を持たない純粋関数（Node の単体テスト tests/unit-dashboard-calc.mjs 用）。
//   日付は JST の 'YYYY-MM-DD' 文字列で扱う。

const pad = (n) => String(n).padStart(2, '0');

/** 1年前の同じ日（'YYYY-MM-DD'）。2/29 は前年の 2/28。日付として不正なら null */
export function prevYearDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]) - 1;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // その月の末日
  const thisLast = new Date(Date.UTC(y + 1, mo, 0)).getUTCDate();
  if (d > thisLast) return null;
  return `${y}-${pad(mo)}-${pad(Math.min(d, last))}`;
}

/**
 * 前年度比の比べる相手の期間。
 *   過去の年度を見ているとき: 前の年度まるごと（10/1〜翌9/30）
 *   今年度を見ているとき: 前の年度の「同じ時期まで」（10/1〜1年前の今日）。今年度はまだ途中なので、
 *   前年度まるごとと比べると必ず「減った」に見えてしまうため。
 * @returns {{from:string, to:string, partial:boolean}|null}
 */
export function comparePeriod(fy, currentFy, today) {
  if (!Number.isInteger(fy) || !Number.isInteger(currentFy)) return null;
  const from = `${fy - 1}-10-01`;
  const fullTo = `${fy}-09-30`;
  if (fy < currentFy) return { from, to: fullTo, partial: false };
  const to = prevYearDate(today);
  if (!to || to < from) return null;
  return to >= fullTo ? { from, to: fullTo, partial: false } : { from, to, partial: true };
}

/**
 * 今年と前年の差。dir: 'up'（増えた）/'down'（減った）/'same'。pct は前年が0のとき null（割り算できない）
 * @returns {{diff:number, pct:number|null, dir:'up'|'down'|'same'}}
 */
export function yoy(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  const diff = c - p;
  return {
    diff,
    pct: p > 0 ? Math.round((diff / p) * 100) : null,
    dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'same',
  };
}

/**
 * 設備別の上位 n 件（key の大きい順。0 は載せない。設備未指定＝equipment_id が無い行は対象外）。
 * 同点は元の並び（APIは件数の多い順→設備名順）を保つ。
 */
export function worstEquipment(rows, key, n = 5) {
  return (rows || [])
    .filter((r) => r && r.equipment_id != null && Number(r[key]) > 0)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r[key]) - Number(a.r[key]) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.r);
}

/** 設備未指定（equipment_id が無い）のトラブル件数 */
export function unassignedCount(rows) {
  return (rows || []).filter((r) => r && r.equipment_id == null).reduce((a, r) => a + (Number(r.trouble_count) || 0), 0);
}

/** 繰り返しトラブルの設備（期間内に min 回以上。件数の多い順。設備未指定は対象外） */
export function repeatEquipment(rows, min = 3) {
  return (rows || [])
    .filter((r) => r && r.equipment_id != null && Number(r.trouble_count) >= min)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.trouble_count) - Number(a.r.trouble_count) || a.i - b.i)
    .map((x) => x.r);
}

// 曜日×時間帯: 列は月〜日、行は3時間ごとの8つの時間帯
export const HEAT_WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
export const HEAT_BAND_HOURS = 3;
export const HEAT_BANDS = Array.from({ length: 24 / HEAT_BAND_HOURS }, (_, i) => `${i * HEAT_BAND_HOURS}〜${(i + 1) * HEAT_BAND_HOURS}時`);

/**
 * APIの行（weekday: 0=日〜6=土・hour: 0〜23・count）→ 時間帯×曜日の表。
 * @returns {{cells:number[][], max:number, total:number}} cells[時間帯][曜日（月=0…日=6）]
 */
export function heatmapGrid(rows) {
  const cells = HEAT_BANDS.map(() => HEAT_WEEKDAYS.map(() => 0));
  let total = 0;
  for (const r of rows || []) {
    const wd = Number(r.weekday);
    const hour = Number(r.hour);
    const count = Number(r.count) || 0;
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23 || count <= 0) continue;
    cells[Math.floor(hour / HEAT_BAND_HOURS)][(wd + 6) % 7] += count;
    total += count;
  }
  let max = 0;
  for (const row of cells) for (const v of row) if (v > max) max = v;
  return { cells, max, total };
}

/** 色の濃さの段階（0＝なし、1〜steps）。件数が少ないときも 1件＝1段目になるようにする */
export function heatStep(count, max, steps = 5) {
  if (!(count > 0) || !(max > 0)) return 0;
  return Math.min(steps, Math.max(1, Math.ceil((count / max) * steps)));
}

/**
 * 色の割り当て（ジャンル）。マスタのID順に 0,1,2… の枠を決める＝件数の順位や年度で色が変わらない。
 * 枠の数（slots）を超えた分と未分類（id なし）は -1（灰色）。
 * @param {Array<{id:number}>} categories ジャンルマスタ（削除済みも含む全件）
 * @returns {Map<number, number>}
 */
export function categorySlots(categories, slots = 8) {
  const ids = [...new Set((categories || []).map((c) => Number(c.id)).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  return new Map(ids.map((id, i) => [id, i < slots ? i : -1]));
}

/** 色の割り当て（休止区分）。標準の3区分は固定の枠、それ以外は名前順で後ろの枠。「区分なし」は -1（灰色） */
export function kindSlots(kinds, fixed = ['故障休止', '点検休止', '調整休止'], none = '区分なし', slots = 8) {
  const map = new Map(fixed.map((k, i) => [k, i]));
  const others = [...new Set((kinds || []).filter((k) => k !== none && !map.has(k)))].sort((a, b) => a.localeCompare(b, 'ja'));
  others.forEach((k, i) => { const s = fixed.length + i; map.set(k, s < slots ? s : -1); });
  map.set(none, -1);
  return map;
}
