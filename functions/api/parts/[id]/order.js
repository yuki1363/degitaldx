// POST /api/parts/:id/order — 部品の「発注中」状態の設定・解除（05 発注状態管理）
//   { ordered: true }  … 発注中にする（ordered_at/ordered_by を記録）
//   { ordered: false } … 発注中を解除
//   入庫（/api/parts/:id/transaction type=in）でも自動解除される。
//   二重発注・発注漏れの防止用。editor 以上。

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { ensureColumns } from '../../_lib/db-compat.js';

export async function ensurePartsOrderColumns(db) {
  await ensureColumns(db, 'parts_inventory_order', [
    'ALTER TABLE parts_inventory ADD COLUMN ordered_at TEXT',
    'ALTER TABLE parts_inventory ADD COLUMN ordered_by TEXT',
  ]);
}

export async function onRequestPost({ env, data, params, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const { DB } = env;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  await ensurePartsOrderColumns(DB);

  const part = await DB.prepare(
    `SELECT id, name, ordered_at FROM parts_inventory WHERE id = ?1 AND deleted_at IS NULL`
  ).bind(id).first();
  if (!part) return jsonError(404, '部品が見つかりません。');

  const body = await readJson(request);
  const ordered = body?.ordered === true;
  const now = nowIso();
  const userEmail = data.user.email;

  await DB.prepare(
    `UPDATE parts_inventory
        SET ordered_at = ?1, ordered_by = ?2, updated_by = ?3, updated_at = ?4
      WHERE id = ?5`
  )
    .bind(ordered ? now : null, ordered ? userEmail : null, userEmail, now, id)
    .run();

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: id,
    action: 'update',
    changedBy: userEmail,
    diff: { ordered: { old: !!part.ordered_at, new: ordered } },
  });

  return json({ ok: true, ordered_at: ordered ? now : null, ordered_by: ordered ? userEmail : null });
}
