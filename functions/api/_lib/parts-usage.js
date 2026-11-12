// 部品の使用実績（直近12か月の月別出庫数）— 05 部品在庫の詳細画面用。
//   入出庫履歴は直近50件の表示だけで、どのくらいの速さで使っているかが分からなかった
//   （必要数〔安全在庫〕や発注数を決める材料が無い）。出庫（type='out'）だけを月ごとに足す。
//   ・棚卸調整（adjust）と入庫（in）は使用に数えない
//   ・月は JST で分ける（created_at は UTC 保存）
//   ・今月を含む12か月。出庫の無い月は 0 で埋める
//   ・読むのはその部品の12か月ぶんの出庫だけ（索引 idx_parts_transaction_part＝part_id, created_at）
import { jstToday, jstDayStartUtc } from './util.js';

export const USAGE_MONTHS = 12;

/** 'YYYY-MM-DD'（JSTの今日）→ 今月を含む直近 n か月の 'YYYY-MM'（古い順） */
export function recentMonths(todayJst, n = USAGE_MONTHS) {
  const [y, m] = todayJst.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/** 月別の集計行（[{month, qty}]）→ 12か月ぶんに埋めた使用実績 */
export function buildUsage(rows, todayJst) {
  const months = recentMonths(todayJst);
  const by = new Map((rows || []).map((r) => [r.month, Number(r.qty) || 0]));
  const list = months.map((month) => ({ month, out: by.get(month) ?? 0 }));
  const total = list.reduce((s, x) => s + x.out, 0);
  return {
    months: list,
    total_out: total,
    // 月平均は小数1桁（12か月で割る。登録して間もない部品は実際より少なく出る）
    avg_out: Math.round((total / months.length) * 10) / 10,
  };
}

export async function loadPartUsage(db, partId, todayJst = jstToday()) {
  const from = jstDayStartUtc(`${recentMonths(todayJst)[0]}-01`);
  const { results } = await db
    .prepare(
      `SELECT strftime('%Y-%m', created_at, '+9 hours') AS month, SUM(-quantity) AS qty
         FROM parts_transaction
        WHERE part_id = ?1 AND type = 'out' AND created_at >= ?2
        GROUP BY month`
    )
    .bind(partId, from)
    .all();
  return buildUsage(results ?? [], todayJst);
}
