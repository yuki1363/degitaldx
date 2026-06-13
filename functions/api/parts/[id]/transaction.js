// 05: 部品在庫 — 入出庫記録
// POST /api/parts/:id/transaction  在庫数を更新して入出庫履歴を登録（editor以上）

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { createNotification } from '../../_lib/notify.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

export async function onRequestPost({ env, data, params, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const id = Number(params.id);
  const { DB } = env;
  const userEmail = data.user.email;

  // 部品の存在確認（在庫0通知の見出しに使うため名称等も取得）
  const part = await DB.prepare(
    `SELECT id, name, part_no, unit, quantity FROM parts_inventory WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(id)
    .first();

  if (!part) return jsonError(404, '部品が見つかりません。');

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');

  const { type, quantity: bodyQty, note } = body;

  // バリデーション: type
  if (!['in', 'out', 'adjust'].includes(type)) {
    return jsonError(400, 'type は in / out / adjust のいずれかを指定してください。');
  }

  // バリデーション: quantity（正の整数）
  if (!Number.isInteger(bodyQty) || bodyQty <= 0) {
    return jsonError(400, 'quantity は1以上の整数を指定してください。');
  }

  const oldQty = part.quantity;
  let newQty;
  let delta;

  if (type === 'in') {
    delta = bodyQty;
    newQty = oldQty + bodyQty;
  } else if (type === 'out') {
    if (oldQty - bodyQty < 0) {
      return jsonError(400, '在庫不足です。');
    }
    delta = -bodyQty;
    newQty = oldQty - bodyQty;
  } else {
    // adjust: body.quantity は新しい絶対値
    delta = bodyQty - oldQty;
    newQty = bodyQty;
  }

  const now = nowIso();

  // 在庫数を更新
  await DB.prepare(
    `UPDATE parts_inventory
        SET quantity = ?1, updated_by = ?2, updated_at = ?3
      WHERE id = ?4`
  )
    .bind(newQty, userEmail, now, id)
    .run();

  // 入出庫履歴を登録（adjust のとき delta は負になることもある）
  await DB.prepare(
    `INSERT INTO parts_transaction (part_id, type, quantity, note, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(id, type, delta, note ?? null, userEmail, now)
    .run();

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: id,
    action: 'update',
    changedBy: userEmail,
    diff: { old_qty: oldQty, new_qty: newQty, type, delta },
  });

  // 在庫が0になったらアラート通知（0から0へは変化なしなので oldQty>0 のときのみ）
  if (newQty === 0 && oldQty > 0) {
    await createNotification(DB, {
      type: 'parts_zero',
      level: 'alert',
      title: `在庫切れ: ${part.name}`,
      body: `${part.part_no}（${part.name}）の在庫が0${part.unit}になりました。発注をご検討ください。`,
      relatedTable: 'parts_inventory',
      relatedId: id,
      linkUrl: `/pages/parts?id=${id}`,
      createdBy: userEmail,
    });
  }

  return json({ quantity: newQty });
}
