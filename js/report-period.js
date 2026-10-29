// 08 保全レポート: 期間の計算（今週・先週・今月・先月）。他の import を持たない（Node の単体テスト用）。
//   日付は JST の 'YYYY-MM-DD' 文字列で扱い、UTC の日付計算だけで求める（端末のタイムゾーンに依存しない）。
//   週は月曜始まり〜日曜終わり。

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return fmt(d) === s ? d : null; // 2026-02-30 のような存在しない日付は null
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** 'YYYY-MM-DD' に日数を足す。日付として不正なら null */
export function shiftDate(s, days) {
  const d = parse(s);
  return d ? fmt(addDays(d, days)) : null;
}

/**
 * 期間の種類 → { from, to }（どちらも含む）。today は JST の 'YYYY-MM-DD'。不正なら null。
 * @param {'week'|'lastweek'|'month'|'lastmonth'} kind
 */
export function periodFor(kind, today) {
  const t = parse(today);
  if (!t) return null;
  if (kind === 'week' || kind === 'lastweek') {
    const sinceMonday = (t.getUTCDay() + 6) % 7; // 月=0 … 日=6
    const monday = addDays(t, -sinceMonday - (kind === 'lastweek' ? 7 : 0));
    return { from: fmt(monday), to: fmt(addDays(monday, 6)) };
  }
  if (kind === 'month' || kind === 'lastmonth') {
    const offset = kind === 'lastmonth' ? -1 : 0;
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    return { from: fmt(first), to: fmt(last) };
  }
  return null;
}

/** 開始・終了が日付として正しく、開始 <= 終了 か（レポートの任意期間の検証用） */
export function isValidPeriod(from, to) {
  return !!parse(from) && !!parse(to) && from <= to;
}
