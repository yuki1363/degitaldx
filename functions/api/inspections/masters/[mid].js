// /api/inspections/masters/:mid — 点検項目マスタ（02）編集・削除
//   PUT    : 編集（admin。変更前の内容を master_history に保存 → 復元可能）
//   DELETE : 論理削除（admin。同上）

import { json, jsonError, readJson } from '../../_lib/http.js';
import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { nowIso } from '../../_lib/util.js';
import { parseMasterInput } from './index.js';

async function findMaster(env, idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  return env.DB.prepare(
    `SELECT id, equipment_id, name, input_type, unit, min_value, max_value, options_json, sort_order
       FROM inspection_master
      WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(id)
    .first();
}

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const existing = await findMaster(env, params.mid);
  if (!existing) return jsonError(404, '点検項目が見つかりません。');

  const parsed = parseMasterInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  // 変更前スナップショットを保存（旧バージョンへの復元用）
  await writeMasterHistory(env.DB, {
    masterName: 'inspection_master',
    recordId: existing.id,
    snapshot: existing,
    changedBy: data.user.email,
  });

  await env.DB.prepare(
    `UPDATE inspection_master
        SET name = ?1, input_type = ?2, unit = ?3, min_value = ?4, max_value = ?5,
            options_json = ?6, sort_order = ?7, updated_by = ?8, updated_at = ?9
      WHERE id = ?10 AND deleted_at IS NULL`
  )
    .bind(
      v.name, v.input_type, v.unit, v.min_value, v.max_value,
      v.options_json, v.sort_order, data.user.email, nowIso(), existing.id
    )
    .run();

  const diff = {};
  for (const key of Object.keys(v)) {
    const before = existing[key] === undefined ? null : existing[key];
    if (before !== v[key]) diff[key] = { before, after: v[key] };
  }
  await writeAuditLog(env.DB, {
    tableName: 'inspection_master',
    recordId: existing.id,
    action: 'update',
    changedBy: data.user.email,
    diff,
  });

  return json({ id: existing.id });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const existing = await findMaster(env, params.mid);
  if (!existing) return jsonError(404, '点検項目が見つかりません。');

  await writeMasterHistory(env.DB, {
    masterName: 'inspection_master',
    recordId: existing.id,
    snapshot: existing,
    changedBy: data.user.email,
  });

  await env.DB.prepare(
    `UPDATE inspection_master SET deleted_by = ?1, deleted_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`
  )
    .bind(data.user.email, nowIso(), existing.id)
    .run();

  await writeAuditLog(env.DB, {
    tableName: 'inspection_master',
    recordId: existing.id,
    action: 'delete',
    changedBy: data.user.email,
    diff: { name: existing.name },
  });

  return json({ ok: true, id: existing.id });
}
