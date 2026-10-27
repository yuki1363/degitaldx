import { json } from '../_lib/http.js';
import { jstToday, jstDayStartUtc, jstNextDayStartUtc } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;

  // 期間は JST の日付（YYYY-MM-DD）。デフォルト: 直近6ヶ月（JSTの今日まで）
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const toStr = DATE_ONLY.test(sp.get('to') || '') ? sp.get('to') : jstToday();
  const fromStr = DATE_ONLY.test(sp.get('from') || '') ? sp.get('from') : (() => {
    // 5ヶ月前の1日（例: to=2026-07-31 → 2026-02-01）。月だけを計算するので月末日の繰り越しは起きない
    const [y, m] = toStr.split('-').map(Number);
    const idx = y * 12 + (m - 1) - 5;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
  })();

  // 日時列（occurred_at 等）は UTC 保存のため、JST の日付境界へ変換して比べる（>= 開始 / < 翌日0:00）。
  // 日付だけの列（planned_date / report_date）は fromStr / toStr をそのまま使う。
  const fromTs = jstDayStartUtc(fromStr);
  const toTsExcl = jstNextDayStartUtc(toStr);

  const [
    { results: troubleTrend },
    { results: troubleByCategory },
    { results: equipmentRanking },
    { results: repairStatusRows },
    { results: planRows },
    troubleTotal,
    repairTotal,
    inspectionTotal,
    reportTotal,
  ] = await Promise.all([
    // トラブル月別推移
    db.prepare(`
      SELECT strftime('%Y-%m', occurred_at, '+9 hours') AS month, COUNT(*) AS count
      FROM trouble_record
      WHERE deleted_at IS NULL AND occurred_at >= ? AND occurred_at < ?
      GROUP BY month ORDER BY month
    `).bind(fromTs, toTsExcl).all(),

    // ジャンル別トラブル
    db.prepare(`
      SELECT COALESCE(tc.name, '未分類') AS category_name, COUNT(*) AS count
      FROM trouble_record tr
      LEFT JOIN trouble_category tc ON tr.category_id = tc.id
      WHERE tr.deleted_at IS NULL AND tr.occurred_at >= ? AND tr.occurred_at < ?
      GROUP BY tr.category_id ORDER BY count DESC
    `).bind(fromTs, toTsExcl).all(),

    // 設備別故障ランキング（全件取得→JS側で上位10件+10位同着を分離。GROUP BYの母数は設備数程度のため
    // LIMITなしでも軽い。同点内の順序をequipment_nameで固定しないと10位のカットラインで
    // 表示される設備がSQLite内部順序次第で変わってしまう）
    db.prepare(`
      SELECT
        COALESCE(e.name, '設備未指定') AS equipment_name,
        e.code AS equipment_code,
        COUNT(*) AS trouble_count
      FROM trouble_record tr
      LEFT JOIN equipment_ledger e ON tr.equipment_id = e.id
      WHERE tr.deleted_at IS NULL AND tr.occurred_at >= ? AND tr.occurred_at < ?
      GROUP BY tr.equipment_id ORDER BY trouble_count DESC, equipment_name ASC
    `).bind(fromTs, toTsExcl).all(),

    // 業務依頼ステータス内訳（全期間）
    db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM repair_request
      WHERE deleted_at IS NULL
      GROUP BY status
    `).all(),

    // 点検計画達成率（期間内）
    db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM maintenance_plan
      WHERE deleted_at IS NULL AND plan_type = 'inspection'
        AND planned_date >= ? AND planned_date <= ?
      GROUP BY status
    `).bind(fromStr, toStr).all(),

    // 各種件数
    db.prepare(`SELECT COUNT(*) AS n FROM trouble_record WHERE deleted_at IS NULL AND occurred_at >= ? AND occurred_at < ?`).bind(fromTs, toTsExcl).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM repair_request WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?`).bind(fromTs, toTsExcl).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM inspection_result WHERE deleted_at IS NULL AND inspected_at >= ? AND inspected_at < ?`).bind(fromTs, toTsExcl).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM daily_report WHERE deleted_at IS NULL AND report_date >= ? AND report_date <= ?`).bind(fromStr, toStr).first(),
  ]);

  const repairSummary = Object.fromEntries((repairStatusRows ?? []).map((r) => [r.status, r.count]));
  const planCounts    = Object.fromEntries((planRows        ?? []).map((r) => [r.status, r.count]));
  const totalPlanned  = Object.values(planCounts).reduce((a, b) => a + b, 0);
  const donePlanned   = planCounts['done'] ?? 0;

  // 上位10件は通常表示。11位以降で10位と同じ件数（同着）のものだけ「折りたたみ」用に分離する
  // （10位の件数未満は通常どおり非表示のまま）
  const rankingAll = equipmentRanking ?? [];
  const rankingTop = rankingAll.slice(0, 10);
  const tiedCutoffCount = rankingTop.length === 10 ? rankingTop[9].trouble_count : null;
  const rankingTiedExtra = tiedCutoffCount === null
    ? []
    : rankingAll.slice(10).filter((r) => r.trouble_count === tiedCutoffCount);

  return json({
    period: { from: fromStr, to: toStr },
    trouble_trend:          troubleTrend      ?? [],
    trouble_by_category:    troubleByCategory ?? [],
    equipment_ranking:      rankingTop,
    equipment_ranking_tied: rankingTiedExtra,
    repair_summary:         repairSummary,
    inspection_rate: {
      planned: totalPlanned,
      done:    donePlanned,
      rate:    totalPlanned > 0 ? Math.round((donePlanned / totalPlanned) * 100) : null,
    },
    activity: {
      troubles:    troubleTotal?.n    ?? 0,
      repairs:     repairTotal?.n     ?? 0,
      inspections: inspectionTotal?.n ?? 0,
      reports:     reportTotal?.n     ?? 0,
    },
  });
}
