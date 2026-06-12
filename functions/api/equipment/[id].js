// /api/equipment/:id — 設備台帳（06）詳細・編集・削除
//   GET    : 詳細（関連資料・直近の点検履歴・変更履歴つき）
//   PUT    : 編集（editor 以上。変更差分を audit_log に記録）
//   DELETE : 論理削除（editor 以上）

import { json, jsonError, readJson } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';
import { listAttachedFiles } from '../_lib/storage.js';
import { parseEquipmentInput } from './index.js';

async function findEquipment(env, idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  return env.DB.prepare(
    `SELECT id, code, name, location, manufacturer, model, installed_on, status, note,
            created_by, created_at, updated_by, updated_at
       FROM equipment_ledger
      WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(id)
    .first();
}

export async function onRequestGet({ env, params }) {
  const equipment = await findEquipment(env, params.id);
  if (!equipment) return jsonError(404, '設備が見つかりません。');

  const [files, inspections, history] = await Promise.all([
    listAttachedFiles(env, 'equipment_ledger', equipment.id),
    env.DB.prepare(
      `SELECT r.id, r.inspected_at, r.has_abnormal, u.name AS assignee_name
         FROM inspection_result r
         JOIN users u ON u.id = r.assignee_id
        WHERE r.equipment_id = ?1 AND r.deleted_at IS NULL
        ORDER BY r.inspected_at DESC
        LIMIT 10`
    )
      .bind(equipment.id)
      .all()
      .then((r) => r.results),
    env.DB.prepare(
      `SELECT action, changed_by, changed_at, diff_json
         FROM audit_log
        WHERE table_name = 'equipment_ledger' AND record_id = ?1
        ORDER BY changed_at DESC, id DESC
        LIMIT 20`
    )
      .bind(equipment.id)
      .all()
      .then((r) => r.results),
  ]);

  return json({ equipment, files, inspections, history });
}

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const existing = await findEquipment(env, params.id);
  if (!existing) return jsonError(404, '設備が見つかりません。');

  const parsed = parseEquipmentInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  if (v.code !== existing.code) {
    const dup = await env.DB.prepare('SELECT id FROM equipment_ledger WHERE code = ?1 AND id != ?2')
      .bind(v.code, existing.id)
      .first();
    if (dup) return jsonError(409, `設備番号「${v.code}」は既に使われています。`);
  }

  // 変更された項目だけを差分として audit_log に残す
  const diff = {};
  for (const key of Object.keys(v)) {
    const before = existing[key] === undefined ? null : existing[key];
    if (before !== v[key]) diff[key] = { before, after: v[key] };
  }
  if (Object.keys(diff).length === 0) return json({ id: existing.id, unchanged: true });

  await env.DB.prepare(
    `UPDATE equipment_ledger
        SET code = ?1, name = ?2, location = ?3, manufacturer = ?4, model = ?5,
            installed_on = ?6, status = ?7, note = ?8, updated_by = ?9, updated_at = ?10
      WHERE id = ?11 AND deleted_at IS NULL`
  )
    .bind(
      v.code, v.name, v.location, v.manufacturer, v.model,
      v.installed_on, v.status, v.note, data.user.email, nowIso(), existing.id
    )
    .run();

  await writeAuditLog(env.DB, {
    tableName: 'equipment_ledger',
    recordId: existing.id,
    action: 'update',
    changedBy: data.user.email,
    diff,
  });

  return json({ id: existing.id });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const existing = await findEquipment(env, params.id);
  if (!existing) return jsonError(404, '設備が見つかりません。');

  await env.DB.prepare(
    `UPDATE equipment_ledger SET deleted_by = ?1, deleted_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`
  )
    .bind(data.user.email, nowIso(), existing.id)
    .run();

  await writeAuditLog(env.DB, {
    tableName: 'equipment_ledger',
    recordId: existing.id,
    action: 'delete',
    changedBy: data.user.email,
    diff: { code: existing.code, name: existing.name },
  });

  return json({ ok: true, id: existing.id });
}
