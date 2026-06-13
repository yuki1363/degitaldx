// 05: 部品在庫 — 一覧取得 / 新規登録
// GET  /api/parts          一覧（検索・低在庫フィルタ）
// POST /api/parts          新規登録（editor以上）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestGet({ env, data, request }) {
  const { DB } = env;
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const lowStock = url.searchParams.get('low_stock') === '1';

  let query;
  let bindings;

  if (q && lowStock) {
    query = `
      SELECT * FROM parts_inventory
      WHERE deleted_at IS NULL
        AND quantity <= safety_stock
        AND (part_no LIKE ?1 OR name LIKE ?1 OR spec LIKE ?1)
      ORDER BY part_no ASC
    `;
    bindings = [`%${q}%`];
  } else if (q) {
    query = `
      SELECT * FROM parts_inventory
      WHERE deleted_at IS NULL
        AND (part_no LIKE ?1 OR name LIKE ?1 OR spec LIKE ?1)
      ORDER BY part_no ASC
    `;
    bindings = [`%${q}%`];
  } else if (lowStock) {
    query = `
      SELECT * FROM parts_inventory
      WHERE deleted_at IS NULL
        AND quantity <= safety_stock
      ORDER BY part_no ASC
    `;
    bindings = [];
  } else {
    query = `
      SELECT * FROM parts_inventory
      WHERE deleted_at IS NULL
      ORDER BY part_no ASC
    `;
    bindings = [];
  }

  const stmt = DB.prepare(query);
  const bound = bindings.length > 0 ? stmt.bind(...bindings) : stmt;
  const { results } = await bound.all();

  return json({ parts: results });
}

export async function onRequestPost({ env, data, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');

  const { part_no, name, spec, unit, quantity, safety_stock, location, supplier, supplier_email, note } = body;

  if (!part_no || !name) {
    return jsonError(400, '部品番号（part_no）と部品名（name）は必須です。');
  }

  const now = nowIso();
  const { DB } = env;
  const userEmail = data.user.email;

  // UNIQUE 制約チェック（deleted でないもの）
  const existing = await DB.prepare(
    `SELECT id FROM parts_inventory WHERE part_no = ?1 AND deleted_at IS NULL`
  )
    .bind(part_no)
    .first();

  if (existing) {
    return jsonError(409, `部品番号 "${part_no}" はすでに登録されています。`);
  }

  const result = await DB.prepare(
    `INSERT INTO parts_inventory
       (part_no, name, spec, unit, quantity, safety_stock, location, supplier, supplier_email, note,
        created_by, created_at, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?11, ?12)`
  )
    .bind(
      part_no,
      name,
      spec ?? null,
      unit ?? '個',
      quantity ?? 0,
      safety_stock ?? 0,
      location ?? null,
      supplier ?? null,
      supplier_email ?? null,
      note ?? null,
      userEmail,
      now
    )
    .run();

  const newId = result.meta?.last_row_id;

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: newId,
    action: 'create',
    changedBy: userEmail,
    diff: { part_no, name, spec, unit, quantity, safety_stock, location, supplier, supplier_email, note },
  });

  return json({ id: newId }, 201);
}
