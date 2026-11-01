// 05: 部品に紐づける設備（複数）— /api/parts/:id/equipment
//   1つの部品を複数の機械で使う場合に、使う設備を追加で紐づける（主な設備＝設備名＋機器名は部品の編集で決める）。
//   POST   { equipment_id }  追加（editor 以上）。既に追加済みなら何もせず duplicate:true
//   DELETE ?equipment_id=    外す（editor 以上・論理削除）。主な設備は外せない
//   追加・削除は監査ログに残す（部品の update として）。同じ設備の二重追加は UNIQUE（部分インデックス）で防ぐ。

import { requireRole } from '../../_lib/auth.js';
import { auditStatement } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { describeEquipmentLink, ensurePartsEquipmentTable } from '../../_lib/equipment-link.js';

async function loadPart(db, id) {
  return db.prepare('SELECT id, name, line_name, equipment_name, equipment_id FROM parts_inventory WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id).first().catch(() => db.prepare('SELECT id, name, line_name, equipment_name FROM parts_inventory WHERE id = ?1 AND deleted_at IS NULL').bind(id).first());
}

export async function onRequestPost({ env, data, params, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const partId = Number(params.id);
  const body = await readJson(request);
  const equipmentId = Number(body?.equipment_id);
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) return jsonError(400, 'equipment_id を指定してください。');

  const part = await loadPart(db, partId);
  if (!part) return jsonError(404, '部品が見つかりません。');
  const eq = await db.prepare('SELECT id, code, name FROM equipment_ledger WHERE id = ?1 AND deleted_at IS NULL').bind(equipmentId).first();
  if (!eq) return jsonError(404, '設備が見つかりません。');
  if (!(await ensurePartsEquipmentTable(db))) return jsonError(503, '設備の紐づけ用の表を用意できませんでした。しばらくしてからもう一度お試しください。');

  const primary = await describeEquipmentLink(db, part);
  if (primary.equipment?.id === equipmentId) return jsonError(409, 'この設備は、部品の設備名・機器名で既に紐づいています（主な設備）。');

  const now = nowIso();
  const email = data.user.email;
  const live = await db.prepare('SELECT id FROM parts_equipment WHERE part_id = ?1 AND equipment_id = ?2 AND deleted_at IS NULL').bind(partId, equipmentId).first();
  if (live) return json({ ok: true, duplicate: true });

  // 外した行が残っていれば復活させる（行が増え続けないように）。無ければ追加。紐づけと監査は1つの batch
  const old = await db.prepare('SELECT id FROM parts_equipment WHERE part_id = ?1 AND equipment_id = ?2 AND deleted_at IS NOT NULL ORDER BY id DESC LIMIT 1').bind(partId, equipmentId).first();
  const write = old
    ? db.prepare('UPDATE parts_equipment SET deleted_at = NULL, deleted_by = NULL, updated_by = ?1, updated_at = ?2 WHERE id = ?3').bind(email, now, old.id)
    : db.prepare('INSERT INTO parts_equipment (part_id, equipment_id, created_by, created_at, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?3, ?4)').bind(partId, equipmentId, email, now);
  try {
    await db.batch([
      write,
      auditStatement(db, { tableName: 'parts_inventory', recordId: partId, action: 'update', changedBy: email, diff: { equipment_link_added: { id: eq.id, code: eq.code, name: eq.name } } }),
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return json({ ok: true, duplicate: true }); // 同時に同じ設備が追加された
    throw err;
  }
  return json({ ok: true, equipment: eq }, 201);
}

export async function onRequestDelete({ env, data, params, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const partId = Number(params.id);
  const equipmentId = Number(new URL(request.url).searchParams.get('equipment_id'));
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) return jsonError(400, 'equipment_id を指定してください。');

  const part = await loadPart(db, partId);
  if (!part) return jsonError(404, '部品が見つかりません。');
  const primary = await describeEquipmentLink(db, part);
  if (primary.equipment?.id === equipmentId) {
    return jsonError(400, '主な設備は、部品の編集で設備名・機器名を変えてください（ここでは外せません）。');
  }
  await ensurePartsEquipmentTable(db);
  const now = nowIso();
  const email = data.user.email;
  const live = await db.prepare('SELECT id FROM parts_equipment WHERE part_id = ?1 AND equipment_id = ?2 AND deleted_at IS NULL').bind(partId, equipmentId).first();
  if (!live) return jsonError(404, '紐づけが見つかりません。');
  await db.batch([
    db.prepare('UPDATE parts_equipment SET deleted_at = ?1, deleted_by = ?2, updated_at = ?1, updated_by = ?2 WHERE id = ?3 AND deleted_at IS NULL').bind(now, email, live.id),
    auditStatement(db, { tableName: 'parts_inventory', recordId: partId, action: 'update', changedBy: email, diff: { equipment_link_removed: { equipment_id: equipmentId } } }),
  ]);
  return json({ ok: true });
}
