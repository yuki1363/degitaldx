// 通知センター（最近の動き・アラート）一覧
//   GET /api/notifications?status=unread&type=parts_zero&from_month=2026-01&to_month=2026-06&assignee=a@b.com&limit=50
//     status=unread … 未確認のみ（省略時は確認済みも含めて新着順）
//     type           … parts_zero / inspection_abnormal / trouble で絞り込み（カンマ区切り可）
//     from_month     … YYYY-MM（JST基準）この年月以降に絞り込み（範囲検索の開始）
//     to_month       … YYYY-MM（JST基準）この年月以前に絞り込み（範囲検索の終了）
//     assignee       … 担当者（通知を発生させた操作者 created_by のメール）で絞り込み
//   未読数（unread_count）は常に返す（ホームのバッジ表示に使う）。
//   facets … 月・担当者の選択肢一覧（フィルタUIの組み立て用。フィルタ条件に関わらず全件から集計）。
//   閲覧は全ログインユーザー可（確認操作のみ editor 以上）。

import { json } from '../_lib/http.js';

// 保存は UTC ISO 8601、表示は JST。月別フィルタも JST 基準（+9時間）で揃える。
const JST_MONTH = `strftime('%Y-%m', created_at, '+9 hours')`;

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const status = sp.get('status');           // 'unread' | null
  const type = sp.get('type');               // parts_zero / inspection_abnormal / trouble
  const fromMonth = sp.get('from_month');    // YYYY-MM（JST）範囲開始
  const toMonth = sp.get('to_month');        // YYYY-MM（JST）範囲終了
  const assignee = sp.get('assignee');       // created_by のメール
  const limit = Math.min(Number(sp.get('limit')) || 50, 200);

  let sql = `SELECT * FROM notifications WHERE deleted_at IS NULL`;
  const binds = [];
  if (status === 'unread') sql += ` AND acknowledged_at IS NULL`;
  // type はカンマ区切りで複数指定可（例 parts_zero,parts_low）。プレースホルダで安全に IN 展開。
  if (type) {
    const types = type.split(',').map((t) => t.trim()).filter(Boolean);
    if (types.length === 1) {
      sql += ` AND type = ?`;
      binds.push(types[0]);
    } else if (types.length > 1) {
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      binds.push(...types);
    }
  }
  // 年月の範囲検索（JST）— YYYY-MM 形式のときのみ適用。文字列比較で前後関係が判定できる。
  if (fromMonth && /^\d{4}-\d{2}$/.test(fromMonth)) {
    sql += ` AND ${JST_MONTH} >= ?`;
    binds.push(fromMonth);
  }
  if (toMonth && /^\d{4}-\d{2}$/.test(toMonth)) {
    sql += ` AND ${JST_MONTH} <= ?`;
    binds.push(toMonth);
  }
  // 担当者別 — 通知を発生させた操作者（created_by）で絞り込み
  if (assignee) {
    sql += ` AND created_by = ?`;
    binds.push(assignee);
  }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await db.prepare(sql).bind(...binds).all();

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE deleted_at IS NULL AND acknowledged_at IS NULL`)
    .first();

  // フィルタUIの選択肢（全件から集計。現在のフィルタには依存させず、選択肢を固定して使いやすくする）
  const monthsRes = await db
    .prepare(`SELECT DISTINCT ${JST_MONTH} AS ym FROM notifications WHERE deleted_at IS NULL ORDER BY ym DESC`)
    .all();
  const assigneesRes = await db
    .prepare(
      `SELECT n.created_by AS email, u.name AS name, COUNT(*) AS count
         FROM notifications n
         LEFT JOIN users u ON u.email = n.created_by AND u.deleted_at IS NULL
        WHERE n.deleted_at IS NULL AND n.created_by IS NOT NULL AND n.created_by <> ''
        GROUP BY n.created_by
        ORDER BY count DESC`
    )
    .all();

  return json({
    notifications: results ?? [],
    unread_count: countRow?.n ?? 0,
    facets: {
      months: (monthsRes.results ?? []).map((r) => r.ym).filter(Boolean),
      assignees: assigneesRes.results ?? [],
    },
  });
}
