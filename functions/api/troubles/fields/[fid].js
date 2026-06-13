// /api/troubles/fields/:fid — カスタム項目の編集・削除（admin）
//   変更前の内容を master_history に保存 → 管理画面から復元可能

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { parseFieldInput } from './index.js';

async function findField(env, idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  return env.DB.prepare(
    `SELECT id, name, input_type, options_json, sort_order
       FROM trouble_custom_field
      WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first();
}

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const existing = await findField(env, params.fid);
  if (!existing) return jsonError(404, 'カスタム項目が見つかりません');

  const parsed = parseFieldInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const now = nowIso();
  const userEmail = data.user.email;

  await writeMasterHistory(env.DB, {
    masterName: 'trouble_custom_field',
    recordId: existing.id,
    snapshot: existing,
    changedBy: userEmail,
  });

  await env.DB.prepare(`
    UPDATE trouble_custom_field
       SET name = ?, input_type = ?, options_json = ?, sort_order = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL
  `).bind(v.name, v.input_type, v.options_json, v.sort_order, userEmail, now, existing.id).run();

  const diff = {};
  for (const key of Object.keys(v)) {
    const before = existing[key] === undefined ? null : existing[key];
    if (before !== v[key]) diff[key] = { before, after: v[key] };
  }
  await writeAuditLog(env.DB, { tableName: 'trouble_custom_field', recordId: existing.id, action: 'update', changedBy: userEmail, diff });
  return json({ id: existing.id });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const existing = await findField(env, params.fid);
  if (!existing) return jsonError(404, 'カスタム項目が見つかりません');

  const now = nowIso();
  const userEmail = data.user.email;

  await writeMasterHistory(env.DB, {
    masterName: 'trouble_custom_field',
    recordId: existing.id,
    snapshot: existing,
    changedBy: userEmail,
  });

  await env.DB.prepare(
    `UPDATE trouble_custom_field SET deleted_by = ?, deleted_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).bind(userEmail, now, existing.id).run();

  await writeAuditLog(env.DB, { tableName: 'trouble_custom_field', recordId: existing.id, action: 'delete', changedBy: userEmail, diff: { name: existing.name } });
  return json({ ok: true, id: existing.id });
}
