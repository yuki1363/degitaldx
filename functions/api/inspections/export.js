// /api/inspections/export — 点検レポート出力用のデータ取得（02 / 08）
//   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&equipment_id=&abnormal_only=1
//   一覧APIと違い、各点検の項目値（items_json をパースした items 配列）まで含めて返す。
//   レポートビルダー（CSV/PDF）が項目を自由に組み合わせて出力するために使う。
//   閲覧は全ログインユーザー可（GET・読み取り専用）。

import { json } from '../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const conditions = ['r.deleted_at IS NULL'];
  const binds = [];

  const equipmentId = Number(url.searchParams.get('equipment_id'));
  if (Number.isInteger(equipmentId) && equipmentId > 0) {
    binds.push(equipmentId);
    conditions.push(`r.equipment_id = ?${binds.length}`);
  }
  const from = url.searchParams.get('from');
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    binds.push(`${from}T00:00:00Z`);
    conditions.push(`r.inspected_at >= ?${binds.length}`);
  }
  const to = url.searchParams.get('to');
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    binds.push(`${to}T23:59:59Z`);
    conditions.push(`r.inspected_at <= ?${binds.length}`);
  }
  if (url.searchParams.get('abnormal_only') === '1') {
    conditions.push('r.has_abnormal = 1');
  }

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.equipment_id, e.code AS equipment_code, e.name AS equipment_name,
            r.assignee_name, r.inspected_at, r.has_abnormal, r.note, r.items_json
       FROM inspection_result r
       JOIN equipment_ledger e ON e.id = r.equipment_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.inspected_at ASC, r.id ASC
      LIMIT 1000`
  )
    .bind(...binds)
    .all();

  const inspections = (results ?? []).map((r) => {
    let items = [];
    try { items = JSON.parse(r.items_json) || []; } catch { items = []; }
    const { items_json, ...rest } = r;
    return { ...rest, items };
  });

  return json({ inspections });
}
