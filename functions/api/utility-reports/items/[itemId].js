// 13 ユーティリティ日報 — 点検項目マスタ 更新・削除（admin のみ）
//   PUT    /api/utility-reports/items/:itemId
//   DELETE /api/utility-reports/items/:itemId （論理削除）
//   変更前の内容は master_history に退避し、管理画面から旧バージョンへ戻せるようにする。

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { ensureUtilitySchema } from '../_schema.js';
import { toItem } from '../_values.js';
import { parseItemInput } from './index.js';

async function findItem(db, id) {
  return db.prepare(
    `SELECT * FROM utility_item WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first();
}

export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;
  const db = env.DB;
  await ensureUtilitySchema(db);

  const id = Number(params.itemId);
  if (!id) return jsonError(400, '不正なIDです');
  const existing = await findItem(db, id);
  if (!existing) return jsonError(404, '点検項目が見つかりません');

  const parsed = parseItemInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const now = nowIso();
  const email = data.user.email;

  // 変更前のスナップショットを先に退避する（復元用）
  await writeMasterHistory(db, {
    masterName: 'utility_item', recordId: id, snapshot: toItem(existing), changedBy: email,
  });

  await db.prepare(
    `UPDATE utility_item
        SET section = ?, name = ?, input_type = ?, unit = ?, min_value = ?, max_value = ?,
            options_json = ?, alert_options_json = ?, sort_order = ?, updated_by = ?, updated_at = ?
      WHERE id = ?`
  ).bind(
    v.section, v.name, v.input_type, v.unit, v.min_value, v.max_value,
    v.options_json, v.alert_options_json, v.sort_order, email, now, id
  ).run();

  await writeAuditLog(db, {
    tableName: 'utility_item', recordId: id, action: 'update', changedBy: email, diff: v,
  });
  return json({ ok: true });
}

export async function onRequestDelete({ params, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;
  const db = env.DB;
  await ensureUtilitySchema(db);

  const id = Number(params.itemId);
  if (!id) return jsonError(400, '不正なIDです');
  const existing = await findItem(db, id);
  if (!existing) return jsonError(404, '点検項目が見つかりません');

  const now = nowIso();
  const email = data.user.email;

  await writeMasterHistory(db, {
    masterName: 'utility_item', recordId: id, snapshot: toItem(existing), changedBy: email,
  });
  await db.prepare(
    `UPDATE utility_item SET deleted_by = ?, deleted_at = ? WHERE id = ?`
  ).bind(email, now, id).run();
  await writeAuditLog(db, {
    tableName: 'utility_item', recordId: id, action: 'delete', changedBy: email, diff: null,
  });
  return json({ ok: true });
}
