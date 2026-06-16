// /api/inspections/:id — 点検実施記録（02）詳細・編集・削除
//   GET    : 詳細（項目値・添付ファイル・変更履歴つき）
//   PUT    : 編集（editor 以上。再検証・異常値再判定・差分を audit_log に記録）
//   DELETE : 論理削除（editor 以上）

import { json, jsonError, readJson } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';
import { attachFiles, listAttachedFiles } from '../_lib/storage.js';
import { validateInspectionInput } from './index.js';

async function findInspection(env, idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  return env.DB.prepare(
    `SELECT r.id, r.equipment_id, e.code AS equipment_code, e.name AS equipment_name,
            r.assignee_name,
            r.inspected_at, r.items_json, r.has_abnormal, r.note,
            r.created_by, r.created_at, r.updated_by, r.updated_at
       FROM inspection_result r
       JOIN equipment_ledger e ON e.id = r.equipment_id
      WHERE r.id = ?1 AND r.deleted_at IS NULL`
  )
    .bind(id)
    .first();
}

export async function onRequestGet({ env, params }) {
  const inspection = await findInspection(env, params.id);
  if (!inspection) return jsonError(404, '点検記録が見つかりません。');

  const [files, history] = await Promise.all([
    listAttachedFiles(env, 'inspection_result', inspection.id),
    env.DB.prepare(
      `SELECT action, changed_by, changed_at, diff_json
         FROM audit_log
        WHERE table_name = 'inspection_result' AND record_id = ?1
        ORDER BY changed_at DESC, id DESC
        LIMIT 20`
    )
      .bind(inspection.id)
      .all()
      .then((r) => r.results),
  ]);

  return json({
    inspection: { ...inspection, items: JSON.parse(inspection.items_json), items_json: undefined },
    files,
    history,
  });
}

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const existing = await findInspection(env, params.id);
  if (!existing) return jsonError(404, '点検記録が見つかりません。');

  const body = await readJson(request);
  // 設備は変更不可（記録の付け替えミス防止）。既存の equipment_id で再検証する
  const parsed = await validateInspectionInput(env, { ...body, equipment_id: existing.equipment_id });
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const now = nowIso();
  // 担当者は自由入力の assignee_name を更新（旧FK assignee_id はそのまま）。
  await env.DB.prepare(
    `UPDATE inspection_result
        SET assignee_name = ?1, inspected_at = ?2, items_json = ?3, has_abnormal = ?4,
            note = ?5, updated_by = ?6, updated_at = ?7
      WHERE id = ?8 AND deleted_at IS NULL`
  )
    .bind(
      v.assignee_name, v.inspected_at, JSON.stringify(v.items), v.has_abnormal,
      v.note, data.user.email, now, existing.id
    )
    .run();

  const attached = await attachFiles(env, {
    fileIds: body && body.file_ids,
    relatedTable: 'inspection_result',
    relatedId: existing.id,
    userEmail: data.user.email,
    now,
  });

  await writeAuditLog(env.DB, {
    tableName: 'inspection_result',
    recordId: existing.id,
    action: 'update',
    changedBy: data.user.email,
    diff: {
      before: {
        assignee_name: existing.assignee_name,
        inspected_at: existing.inspected_at,
        has_abnormal: existing.has_abnormal === 1,
        note: existing.note,
      },
      after: {
        assignee_name: v.assignee_name,
        inspected_at: v.inspected_at,
        has_abnormal: v.has_abnormal === 1,
        note: v.note,
      },
      attached_files: attached,
    },
  });

  return json({ id: existing.id, has_abnormal: v.has_abnormal === 1 });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const existing = await findInspection(env, params.id);
  if (!existing) return jsonError(404, '点検記録が見つかりません。');

  await env.DB.prepare(
    `UPDATE inspection_result SET deleted_by = ?1, deleted_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`
  )
    .bind(data.user.email, nowIso(), existing.id)
    .run();

  await writeAuditLog(env.DB, {
    tableName: 'inspection_result',
    recordId: existing.id,
    action: 'delete',
    changedBy: data.user.email,
    diff: { equipment_name: existing.equipment_name, inspected_at: existing.inspected_at },
  });

  return json({ ok: true, id: existing.id });
}
