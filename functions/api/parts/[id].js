// 05: 部品在庫 — 個別取得 / 編集 / 削除
// GET    /api/parts/:id   詳細 + 入出庫履歴
// PUT    /api/parts/:id   編集（editor以上）
// DELETE /api/parts/:id   論理削除（editor以上）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

async function getPart(DB, id) {
  return DB.prepare(
    `SELECT * FROM parts_inventory WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(id)
    .first();
}

export async function onRequestGet({ env, params }) {
  const { DB } = env;
  const id = Number(params.id);

  const part = await getPart(DB, id);
  if (!part) return jsonError(404, '部品が見つかりません。');

  const { results: transactions } = await DB.prepare(
    `SELECT * FROM parts_transaction
      WHERE part_id = ?1
      ORDER BY created_at DESC
      LIMIT 50`
  )
    .bind(id)
    .all();

  return json({ part, transactions });
}

export async function onRequestPut({ env, data, params, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const id = Number(params.id);
  const { DB } = env;
  const userEmail = data.user.email;

  const part = await getPart(DB, id);
  if (!part) return jsonError(404, '部品が見つかりません。');

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');

  // quantity は transaction エンドポイント経由で更新するためここでは受け付けない
  const { name, spec, unit, safety_stock, location, supplier, note } = body;

  if (name !== undefined && !name) {
    return jsonError(400, '部品名（name）は空にできません。');
  }

  const now = nowIso();

  const newName        = name        !== undefined ? name        : part.name;
  const newSpec        = spec        !== undefined ? spec        : part.spec;
  const newUnit        = unit        !== undefined ? unit        : part.unit;
  const newSafetyStock = safety_stock !== undefined ? safety_stock : part.safety_stock;
  const newLocation    = location    !== undefined ? location    : part.location;
  const newSupplier    = supplier    !== undefined ? supplier    : part.supplier;
  const newNote        = note        !== undefined ? note        : part.note;

  await DB.prepare(
    `UPDATE parts_inventory
        SET name = ?1, spec = ?2, unit = ?3, safety_stock = ?4,
            location = ?5, supplier = ?6, note = ?7,
            updated_by = ?8, updated_at = ?9
      WHERE id = ?10`
  )
    .bind(newName, newSpec, newUnit, newSafetyStock, newLocation, newSupplier, newNote, userEmail, now, id)
    .run();

  // 変更差分を記録（変化したフィールドのみ）
  const diff = {};
  if (name        !== undefined && name        !== part.name)         diff.name        = { old: part.name,         new: name };
  if (spec        !== undefined && spec        !== part.spec)         diff.spec        = { old: part.spec,         new: spec };
  if (unit        !== undefined && unit        !== part.unit)         diff.unit        = { old: part.unit,         new: unit };
  if (safety_stock !== undefined && safety_stock !== part.safety_stock) diff.safety_stock = { old: part.safety_stock, new: safety_stock };
  if (location    !== undefined && location    !== part.location)     diff.location    = { old: part.location,     new: location };
  if (supplier    !== undefined && supplier    !== part.supplier)     diff.supplier    = { old: part.supplier,     new: supplier };
  if (note        !== undefined && note        !== part.note)         diff.note        = { old: part.note,         new: note };

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: id,
    action: 'update',
    changedBy: userEmail,
    diff,
  });

  return json({ ok: true });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const id = Number(params.id);
  const { DB } = env;
  const userEmail = data.user.email;

  const part = await getPart(DB, id);
  if (!part) return jsonError(404, '部品が見つかりません。');

  const now = nowIso();

  await DB.prepare(
    `UPDATE parts_inventory
        SET deleted_by = ?1, deleted_at = ?2, updated_by = ?1, updated_at = ?2
      WHERE id = ?3`
  )
    .bind(userEmail, now, id)
    .run();

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: id,
    action: 'delete',
    changedBy: userEmail,
    diff: { part_no: part.part_no, name: part.name },
  });

  return json({ ok: true });
}
