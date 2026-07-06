import { json } from '../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;

  // デフォルト: 直近6ヶ月
  const toDate   = sp.get('to')   ? new Date(sp.get('to'))   : new Date();
  const fromDate = sp.get('from') ? new Date(sp.get('from')) : (() => {
    const d = new Date(toDate);
    // 先に1日へ丸めてから月を引く。逆順だと月末日（29〜31日）に短い月へ繰り越されて
    // 1ヶ月ずれる（例: 7/31 → setMonth(-5)で2/31→3/3 → setDate(1)で3/1 = 5ヶ月分になる）
    d.setDate(1);
    d.setMonth(d.getMonth() - 5);
    return d;
  })();

  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr   = toDate.toISOString().slice(0, 10);
  const toEndTs = toStr + 'T23:59:59Z';

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
      SELECT strftime('%Y-%m', occurred_at) AS month, COUNT(*) AS count
      FROM trouble_record
      WHERE deleted_at IS NULL AND occurred_at >= ? AND occurred_at <= ?
      GROUP BY month ORDER BY month
    `).bind(fromStr, toEndTs).all(),

    // ジャンル別トラブル
    db.prepare(`
      SELECT COALESCE(tc.name, '未分類') AS category_name, COUNT(*) AS count
      FROM trouble_record tr
      LEFT JOIN trouble_category tc ON tr.category_id = tc.id
      WHERE tr.deleted_at IS NULL AND tr.occurred_at >= ? AND tr.occurred_at <= ?
      GROUP BY tr.category_id ORDER BY count DESC
    `).bind(fromStr, toEndTs).all(),

    // 設備別故障ランキング（上位10件）
    db.prepare(`
      SELECT
        COALESCE(e.name, '設備未指定') AS equipment_name,
        e.code AS equipment_code,
        COUNT(*) AS trouble_count
      FROM trouble_record tr
      LEFT JOIN equipment_ledger e ON tr.equipment_id = e.id
      WHERE tr.deleted_at IS NULL AND tr.occurred_at >= ? AND tr.occurred_at <= ?
      GROUP BY tr.equipment_id ORDER BY trouble_count DESC LIMIT 10
    `).bind(fromStr, toEndTs).all(),

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
    db.prepare(`SELECT COUNT(*) AS n FROM trouble_record WHERE deleted_at IS NULL AND occurred_at >= ? AND occurred_at <= ?`).bind(fromStr, toEndTs).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM repair_request WHERE deleted_at IS NULL AND created_at >= ? AND created_at <= ?`).bind(fromStr, toEndTs).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM inspection_result WHERE deleted_at IS NULL AND inspected_at >= ? AND inspected_at <= ?`).bind(fromStr, toEndTs).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM daily_report WHERE deleted_at IS NULL AND report_date >= ? AND report_date <= ?`).bind(fromStr, toStr).first(),
  ]);

  const repairSummary = Object.fromEntries((repairStatusRows ?? []).map((r) => [r.status, r.count]));
  const planCounts    = Object.fromEntries((planRows        ?? []).map((r) => [r.status, r.count]));
  const totalPlanned  = Object.values(planCounts).reduce((a, b) => a + b, 0);
  const donePlanned   = planCounts['done'] ?? 0;

  return json({
    period: { from: fromStr, to: toStr },
    trouble_trend:      troubleTrend      ?? [],
    trouble_by_category:troubleByCategory ?? [],
    equipment_ranking:  equipmentRanking  ?? [],
    repair_summary:     repairSummary,
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
