// 05: 部品在庫 — 個別取得 / 編集 / 削除
// GET    /api/parts/:id   詳細 + 入出庫履歴
// PUT    /api/parts/:id   編集（editor以上）
// DELETE /api/parts/:id   論理削除（editor以上）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { normImportance } from './index.js';
import { json, jsonError, readJson, checkEditConflict } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { normalizeJa } from '../_lib/normalize.js';

// NFKC 正規化＋trim（半角カナ→全角カナ・全角英数→半角。検索・表示の統一）。空は null
const nz = (v) => { const s = normalizeJa(String(v)).trim(); return s === '' ? null : s; };

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

  // 設備台帳との照合（line_name・equipment_name が一致する設備を1件返す）
  let equipment = null;
  if (part.line_name) {
    try {
      equipment = await DB.prepare(
        `SELECT id, code, name FROM equipment_ledger
          WHERE deleted_at IS NULL
            AND COALESCE(line_name, '') = COALESCE(?1, '')
            AND COALESCE(equipment_name, '') = COALESCE(?2, '')
          LIMIT 1`
      )
        .bind(part.line_name || '', part.equipment_name || '')
        .first();
    } catch { /* 未マイグレーション環境でも落ちないよう */ }
  }

  return json({ part, transactions, equipment });
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
  const conflict = checkEditConflict(body, part);
  if (conflict) return conflict; // 同時編集ガード

  // quantity は transaction エンドポイント経由で更新するためここでは受け付けない。
  // part_no は内部キーのため変更しない（型番は model_no）。
  const { model_no, name, line_name, equipment_name, safety_stock, location, importance, supplier, supplier_email, note } = body;

  if (name !== undefined && (!name || !String(name).trim())) {
    return jsonError(400, '部品名（name）は空にできません。');
  }

  const now = nowIso();

  const newModelNo      = model_no       !== undefined ? (model_no ? nz(model_no) : null)                        : part.model_no;
  const newName         = name           !== undefined ? nz(name)                                                : part.name;
  const newLineName     = line_name      !== undefined ? (line_name ? nz(line_name) : null)                      : part.line_name;
  const newEquipName    = equipment_name !== undefined ? (equipment_name ? nz(equipment_name) : null)            : part.equipment_name;
  const newSafetyStock  = safety_stock   !== undefined ? (Number.isFinite(Number(safety_stock)) ? Math.trunc(Number(safety_stock)) : part.safety_stock) : part.safety_stock;
  const newLocation     = location       !== undefined ? (location ? nz(location) : null)                        : part.location;
  const newImportance   = importance     !== undefined ? normImportance(importance)                              : part.importance;
  const newSupplier     = supplier       !== undefined ? (supplier ? nz(supplier) : null)                        : part.supplier;
  const newSupplierEmail = supplier_email !== undefined ? (supplier_email ? String(supplier_email).trim() : null) : part.supplier_email;
  const newNote         = note           !== undefined ? (note ? nz(note) : null)                                : part.note;

  await DB.prepare(
    `UPDATE parts_inventory
        SET model_no = ?1, name = ?2, line_name = ?3, equipment_name = ?4, safety_stock = ?5,
            location = ?6, importance = ?7, supplier = ?8, supplier_email = ?9, note = ?10,
            updated_by = ?11, updated_at = ?12
      WHERE id = ?13`
  )
    .bind(newModelNo, newName, newLineName, newEquipName, newSafetyStock, newLocation,
          newImportance, newSupplier, newSupplierEmail, newNote, userEmail, now, id)
    .run();

  // 変更差分を記録（変化したフィールドのみ）
  const diff = {};
  const track = (key, oldVal, newVal) => { if (String(oldVal ?? '') !== String(newVal ?? '')) diff[key] = { old: oldVal, new: newVal }; };
  track('model_no', part.model_no, newModelNo);
  track('name', part.name, newName);
  track('line_name', part.line_name, newLineName);
  track('equipment_name', part.equipment_name, newEquipName);
  track('safety_stock', part.safety_stock, newSafetyStock);
  track('location', part.location, newLocation);
  track('importance', part.importance, newImportance);
  track('supplier', part.supplier, newSupplier);
  track('supplier_email', part.supplier_email, newSupplierEmail);
  track('note', part.note, newNote);

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
