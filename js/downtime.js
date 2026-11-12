// 休止時間（トラブル報告書の入力項目）を「分」の数値に直す純粋関数。
//   休止時間は文字で入力・保存している（帳票にそのまま差し込むため）ので、集計するときにここで数値に直す。
//   画面（js/trouble.js・js/trouble-csv.js）とサーバー（functions/api/stats/index.js）の両方で使う
//   （他の import を持たない＝単体テスト tests/unit-downtime.mjs）。
//
//   読み取れる書き方（全角数字・空白・「約」は吸収する）:
//     「30」「30分」「90min」           … 分
//     「1時間」「1.5時間」「2h」        … 時間 → 分
//     「1時間30分」「1h30m」「1:30」    … 時間＋分
//   読み取れないもの（「半日」「不明」など）は null を返す＝集計に入れない（黙って0にしない）。

export const DOWNTIME_TAG = '休止時間';
export const DOWNTIME_KIND_TAG = '休止種別';
export const DOWNTIME_KIND_NONE = '区分なし';
// 1件の上限（分）。入力ミス（桁違い）で合計が壊れないように、これを超える値は読み取れない扱いにする（30日）
export const MAX_DOWNTIME_MINUTES = 43200;

function normalize(text) {
  return String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[：]/g, ':')
    .replace(/[，,、\s　]/g, '')
    .replace(/^約/, '')
    .toLowerCase();
}

const NUM = '(\\d+(?:\\.\\d+)?)';
const HOUR = '(?:時間|hours?|hrs?|h)';
const MIN = '(?:分間?|minutes?|mins?|m)';
const PATTERNS = [
  [new RegExp(`^${NUM}${MIN}?$`), (m) => Number(m[1])],
  [new RegExp(`^${NUM}${HOUR}$`), (m) => Number(m[1]) * 60],
  [new RegExp(`^${NUM}${HOUR}${NUM}${MIN}?$`), (m) => Number(m[1]) * 60 + Number(m[2])],
  [/^(\d+):([0-5]?\d)$/, (m) => Number(m[1]) * 60 + Number(m[2])],
];

/** 休止時間の文字 → 分（整数に丸める）。空・読み取れない・範囲外は null */
export function parseDowntimeMinutes(text) {
  const t = normalize(text);
  if (t === '') return null;
  for (const [re, calc] of PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const minutes = Math.round(calc(m));
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_DOWNTIME_MINUTES) return null;
    return minutes;
  }
  return null;
}

/** 入力はあるのに読み取れない（＝集計に入らない）か */
export function isUnreadableDowntime(text) {
  return String(text ?? '').trim() !== '' && parseDowntimeMinutes(text) === null;
}

/** 分 → 「1時間30分」「45分」（表示用） */
export function formatDowntime(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

/** form_values_json（文字列または連想配列）→ { minutes, unreadable, kind, raw } */
export function downtimeOf(formValues) {
  let v = formValues;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};
  const raw = v[DOWNTIME_TAG] == null ? '' : String(v[DOWNTIME_TAG]).trim();
  const kind = v[DOWNTIME_KIND_TAG] == null ? '' : String(v[DOWNTIME_KIND_TAG]).trim();
  const minutes = parseDowntimeMinutes(raw);
  return { minutes, unreadable: raw !== '' && minutes === null, kind, raw };
}

/**
 * トラブル記録の行（form_values_json・月・設備）から休止時間を集計する。
 * @param {Array<{form_values_json:any, month:string, equipment_id:any}>} rows
 * @returns {{total_minutes:number, counted:number, unreadable:number,
 *            by_month:Array<{month:string, kind:string, minutes:number}>,
 *            by_kind:Array<{kind:string, minutes:number, count:number}>,
 *            by_equipment:Record<string, number>}}
 */
export function summarizeDowntime(rows) {
  let total = 0, counted = 0, unreadable = 0;
  const byMonth = new Map();   // 'YYYY-MM\t区分' → 分
  const byKind = new Map();    // 区分 → { minutes, count }
  const byEquipment = {};      // 設備ID（無ければ ''）→ 分
  for (const row of rows || []) {
    const d = downtimeOf(row.form_values_json);
    if (d.unreadable) { unreadable++; continue; }
    if (d.minutes === null) continue;
    const kind = d.kind || DOWNTIME_KIND_NONE;
    total += d.minutes;
    counted++;
    const mk = `${row.month}\t${kind}`;
    byMonth.set(mk, (byMonth.get(mk) || 0) + d.minutes);
    const k = byKind.get(kind) || { minutes: 0, count: 0 };
    k.minutes += d.minutes;
    k.count++;
    byKind.set(kind, k);
    const eq = row.equipment_id == null ? '' : String(row.equipment_id);
    byEquipment[eq] = (byEquipment[eq] || 0) + d.minutes;
  }
  return {
    total_minutes: total,
    counted,
    unreadable,
    by_month: [...byMonth.entries()]
      .map(([key, minutes]) => { const [month, kind] = key.split('\t'); return { month, kind, minutes }; })
      .sort((a, b) => a.month.localeCompare(b.month) || a.kind.localeCompare(b.kind)),
    by_kind: [...byKind.entries()]
      .map(([kind, v]) => ({ kind, minutes: v.minutes, count: v.count }))
      .sort((a, b) => b.minutes - a.minutes || a.kind.localeCompare(b.kind)),
    by_equipment: byEquipment,
  };
}
