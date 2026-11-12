import { json } from '../_lib/http.js';
import { jstToday, jstDayStartUtc, jstNextDayStartUtc } from '../_lib/util.js';
import { summarizeDowntime } from '../../../js/downtime.js';

// 休止時間の集計（トラブル報告書の入力項目「休止時間」「休止種別」＝form_values_json）。
//   休止時間は文字で保存しているため、期間内で帳票入力のある記録だけを読み、js/downtime.js で分に直して足す。
//   form_values_json 列が無い古いDB・読み取りの失敗では、集計なし（0件）として返す（件数の集計は止めない）。
async function loadDowntime(db, fromTs, toTsExcl) {
  try {
    const { results } = await db.prepare(`
      SELECT strftime('%Y-%m', occurred_at, '+9 hours') AS month, equipment_id, form_values_json
      FROM trouble_record
      WHERE deleted_at IS NULL AND occurred_at >= ? AND occurred_at < ?
        AND form_values_json IS NOT NULL AND form_values_json <> ''
    `).bind(fromTs, toTsExcl).all();
    return summarizeDowntime(results ?? []);
  } catch (err) {
    console.error('stats: downtime failed:', err && err.stack ? err.stack : err);
    return summarizeDowntime([]);
  }
}

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
    { results: troubleTrendByCategory },
    { results: equipmentRanking },
    { results: repairStatusRows },
    troubleTotal,
    repairTotal,
    inspectionTotal,
    reportTotal,
    downtime,
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

    // ジャンル別の月推移（月×ジャンル。ダッシュボードの積み上げ棒グラフ用）
    db.prepare(`
      SELECT strftime('%Y-%m', tr.occurred_at, '+9 hours') AS month,
             COALESCE(tc.name, '未分類') AS category_name, COUNT(*) AS count
      FROM trouble_record tr
      LEFT JOIN trouble_category tc ON tr.category_id = tc.id
      WHERE tr.deleted_at IS NULL AND tr.occurred_at >= ? AND tr.occurred_at < ?
      GROUP BY month, tr.category_id ORDER BY month
    `).bind(fromTs, toTsExcl).all(),

    // 設備別の故障件数（期間内にトラブルがあった設備すべて。GROUP BYの母数は設備数程度のため
    // LIMITなしでも軽い）。ダッシュボードは全件を表で、レポートタブは上位15件＋「ほかN設備」で表示する。
    // 同点内の順序をequipment_nameで固定しないと、上位10件のカットラインがSQLite内部順序で変わる
    db.prepare(`
      SELECT
        tr.equipment_id AS equipment_id,
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

    // 各種件数
    db.prepare(`SELECT COUNT(*) AS n FROM trouble_record WHERE deleted_at IS NULL AND occurred_at >= ? AND occurred_at < ?`).bind(fromTs, toTsExcl).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM repair_request WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?`).bind(fromTs, toTsExcl).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM inspection_result WHERE deleted_at IS NULL AND inspected_at >= ? AND inspected_at < ?`).bind(fromTs, toTsExcl).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM daily_report WHERE deleted_at IS NULL AND report_date >= ? AND report_date <= ?`).bind(fromStr, toStr).first(),
    loadDowntime(db, fromTs, toTsExcl),
  ]);

  const repairSummary = Object.fromEntries((repairStatusRows ?? []).map((r) => [r.status, r.count]));

  // 期間内にトラブルがあった全設備の件数（ダッシュボードの表と、印刷用レポートの設備別が使う）
  // 設備ごとの休止時間（分）も同じ行に載せる（休止時間の入力が無い設備は 0）
  const equipmentCounts = (equipmentRanking ?? []).map((r) => ({
    ...r,
    downtime_minutes: downtime.by_equipment[r.equipment_id == null ? '' : String(r.equipment_id)] || 0,
  }));

  return json({
    period: { from: fromStr, to: toStr },
    trouble_trend:          troubleTrend      ?? [],
    trouble_by_category:    troubleByCategory ?? [],
    trouble_trend_by_category: troubleTrendByCategory ?? [],
    equipment_trouble_counts: equipmentCounts,
    repair_summary:         repairSummary,
    // 休止時間（分）。unreadable＝入力はあるが読み取れず集計に入っていない件数
    downtime: {
      total_minutes: downtime.total_minutes,
      counted: downtime.counted,
      unreadable: downtime.unreadable,
      by_month: downtime.by_month,
      by_kind: downtime.by_kind,
    },
    activity: {
      troubles:    troubleTotal?.n    ?? 0,
      repairs:     repairTotal?.n     ?? 0,
      inspections: inspectionTotal?.n ?? 0,
      reports:     reportTotal?.n     ?? 0,
    },
  });
}
