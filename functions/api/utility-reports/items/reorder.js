// 13 ユーティリティ日報 — 点検項目の並び替え（admin のみ）
//   PUT /api/utility-reports/items/reorder
//     body: { order: [item_id, ...], moved_id?: number }
//
//   画面に表示している全項目のIDを、表示したい順で受け取り sort_order を振り直す。
//   受け取った ID の集合が現在の有効項目と一致しない場合は 409（他の人が項目を
//   追加・削除した後の古い画面から保存されるのを防ぐ）。
//
//   採番は REORDER_BASE（1000）から REORDER_STEP（10）刻み。旧レイアウトを揃える
//   _schema.js の UTILITY_MIGRATIONS が使う番号帯（1〜45）と重ねないことで、
//   手動の並びが移行SQLで巻き戻されるのを防ぐ。

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { ensureUtilitySchema, REORDER_BASE, REORDER_STEP } from '../_schema.js';
import { listItems } from '../_values.js';

export async function onRequestPut({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;
  const db = env.DB;
  await ensureUtilitySchema(db);

  const body = await readJson(request);
  const order = Array.isArray(body?.order) ? body.order.map(Number) : null;
  if (!order || order.length === 0 || order.some((id) => !Number.isInteger(id) || id <= 0)) {
    return jsonError(400, 'order は点検項目IDの配列で指定してください。');
  }

  const items = await listItems(db);
  const ids = new Set(items.map((i) => i.id));
  const unique = new Set(order);
  const sameSet = unique.size === order.length && order.length === ids.size
    && order.every((id) => ids.has(id));
  if (!sameSet) {
    return jsonError(409, '点検項目が変更されています。画面を読み込み直してから並び替えてください。');
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  const updates = [];
  order.forEach((id, index) => {
    const sortOrder = REORDER_BASE + index * REORDER_STEP;
    if (byId.get(id).sort_order !== sortOrder) updates.push({ id, sortOrder });
  });
  if (updates.length === 0) return json({ ok: true, changed: 0, items });

  const email = data.user.email;
  const now = nowIso();

  // 変更前の並びを丸ごと退避する（trouble_category と同じ「マスタ全体スナップショット」形式。
  // 並び順は画面から並び替え直せるため、レコード単位の復元対象にはしない）
  await writeMasterHistory(db, {
    masterName: 'utility_item',
    recordId: null,
    snapshot: items.map((i) => ({ id: i.id, section: i.section, name: i.name, sort_order: i.sort_order })),
    changedBy: email,
  });

  await db.batch(updates.map(({ id, sortOrder }) => db.prepare(
    `UPDATE utility_item
        SET sort_order = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`
  ).bind(sortOrder, email, now, id)));

  await writeAuditLog(db, {
    tableName: 'utility_item',
    recordId: (Number.isInteger(Number(body?.moved_id)) && byId.has(Number(body.moved_id)))
      ? Number(body.moved_id) : updates[0].id,
    action: 'update',
    changedBy: email,
    diff: { reorder: order.map((id) => byId.get(id).name), changed: updates.length },
  });

  return json({ ok: true, changed: updates.length, items: await listItems(db) });
}
