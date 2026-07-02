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

  // 部品の存在確認（在庫0・安全在庫割れ通知の見出し・しきい値に使う）
  const part = await DB.prepare(
    `SELECT id, name, model_no, quantity, safety_stock FROM parts_inventory WHERE id = ?1 AND deleted_at IS NULL`
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

  // バリデーション: quantity（整数）。入庫・出庫は1以上、棚卸調整(adjust)のみ0も許可
  // （棚卸で在庫ゼロを記録できるようにするため）
  if (!Number.isInteger(bodyQty) || bodyQty < 0) {
    return jsonError(400, 'quantity は0以上の整数を指定してください。');
  }
  if (bodyQty === 0 && type !== 'adjust') {
    return jsonError(400, '入庫・出庫の数量は1以上を指定してください。');
  }

  // 任意: 入出庫を業務依頼・トラブル対応に紐づける（使用部品の記録）
  const RELATED_TABLES = ['repair_request', 'trouble_record'];
  const relatedTable = body.related_table ?? null;
  const relatedId =
    body.related_id === undefined || body.related_id === null ? null : Number(body.related_id);
  if (relatedTable !== null && !RELATED_TABLES.includes(relatedTable)) {
    return jsonError(400, `related_table が不正です: ${relatedTable}`);
  }
  if (relatedId !== null && !Number.isInteger(relatedId)) {
    return jsonError(400, 'related_id は整数で指定してください。');
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
    `INSERT INTO parts_transaction (part_id, type, quantity, note, related_table, related_id, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(id, type, delta, note ?? null, relatedTable, relatedId, userEmail, now)
    .run();

  // 入庫したら「発注中」バッジを自動解除する（発注→入庫の完了）。
  // ordered_at 列が無い旧DBではエラーになるが、バッジ機能が無いだけなので握りつぶす。
  if (type === 'in' && delta > 0) {
    try {
      await DB.prepare(
        `UPDATE parts_inventory SET ordered_at = NULL, ordered_by = NULL WHERE id = ?1 AND ordered_at IS NOT NULL`
      ).bind(id).run();
    } catch { /* 列未追加の旧DBでは何もしない */ }
  }

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: id,
    action: 'update',
    changedBy: userEmail,
    diff: { old_qty: oldQty, new_qty: newQty, type, delta },
  });

  // 在庫アラート通知。多重通知を避けるため「しきい値をまたいだ瞬間」だけ発火する。
  //   ・在庫切れ（0）  : alert（0→0は変化なしなので oldQty>0 のときのみ）
  //   ・安全在庫割れ    : warning（必要数を下回った瞬間。0は上の在庫切れで通知済みなので除外）
  const label = part.model_no ? `${part.model_no}（${part.name}）` : part.name;
  const safetyStock = part.safety_stock || 0;
  if (newQty === 0 && oldQty > 0) {
    await createNotification(DB, {
      type: 'parts_zero',
      level: 'alert',
      title: `在庫切れ: ${part.name}`,
      body: `${label}の在庫が0になりました。発注をご検討ください。`,
      relatedTable: 'parts_inventory',
      relatedId: id,
      linkUrl: `/pages/parts?id=${id}`,
      createdBy: userEmail,
    });
  } else if (safetyStock > 0 && newQty > 0 && newQty < safetyStock && oldQty >= safetyStock) {
    await createNotification(DB, {
      type: 'parts_low',
      level: 'warning',
      title: `発注アラート: ${part.name}`,
      body: `${label}の在庫が必要数（${safetyStock}）を下回りました（現在 ${newQty}）。発注をご検討ください。`,
      relatedTable: 'parts_inventory',
      relatedId: id,
      linkUrl: `/pages/parts?id=${id}`,
      createdBy: userEmail,
    });
  }

  // 入庫したら、この部品を使う「部品待ち」の業務依頼に入庫を通知する
  //   （部品待ちで止まりがちな依頼を、部品到着で自動的に促す）
  if (type === 'in' && delta > 0) {
    const waiting = await DB.prepare(
      `SELECT DISTINCT r.id, r.title
         FROM parts_transaction pt
         JOIN repair_request r ON r.id = pt.related_id
        WHERE pt.part_id = ?1 AND pt.related_table = 'repair_request'
          AND r.status = 'waiting_parts' AND r.deleted_at IS NULL`
    )
      .bind(id)
      .all()
      .catch(() => ({ results: [] }));
    for (const r of waiting.results ?? []) {
      await createNotification(DB, {
        type: 'parts_restock',
        level: 'info',
        title: `部品が入庫しました: ${part.name}`,
        body: `部品待ちの業務依頼「${r.title}」で使用する${label}が入庫しました（現在 ${newQty}）。`,
        relatedTable: 'repair_request',
        relatedId: r.id,
        linkUrl: `/pages/repair?id=${r.id}`,
        createdBy: userEmail,
      });
    }
  }

  return json({ quantity: newQty });
}
