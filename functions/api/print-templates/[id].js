// /api/print-templates/:id — 帳票テンプレートの更新・削除（admin のみ）
//   PUT    : 更新（許可列のみ）
//   DELETE : 論理削除

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { parseTemplateInput, attachTemplateImage } from './index.js';

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return jsonError(400, '不正なIDです。');

  const existing = await db.prepare(
    `SELECT * FROM print_templates WHERE id = ?1 AND deleted_at IS NULL`
  ).bind(id).first();
  if (!existing) return jsonError(404, 'テンプレートが見つかりません。');

  const parsed = parseTemplateInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(
    `UPDATE print_templates
        SET name = ?1, template_type = ?2, image_file_id = ?3, orientation = ?4, fields_json = ?5,
            updated_by = ?6, updated_at = ?7
      WHERE id = ?8`
  ).bind(v.name, v.template_type, v.image_file_id, v.orientation, v.fields_json, userEmail, now, id).run();

  await attachTemplateImage(db, { imageFileId: v.image_file_id, templateId: id, userEmail, now });

  await writeAuditLog(db, {
    tableName: 'print_templates',
    recordId: id,
    action: 'update',
    changedBy: userEmail,
    diff: {
      before: { name: existing.name, template_type: existing.template_type, orientation: existing.orientation, image_file_id: existing.image_file_id },
      after: { name: v.name, template_type: v.template_type, orientation: v.orientation, image_file_id: v.image_file_id },
    },
  });

  return json({ ok: true });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return jsonError(400, '不正なIDです。');

  const existing = await db.prepare(
    `SELECT id, name FROM print_templates WHERE id = ?1 AND deleted_at IS NULL`
  ).bind(id).first();
  if (!existing) return jsonError(404, 'テンプレートが見つかりません。');

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(
    `UPDATE print_templates SET deleted_by = ?1, deleted_at = ?2 WHERE id = ?3`
  ).bind(userEmail, now, id).run();

  await writeAuditLog(db, {
    tableName: 'print_templates',
    recordId: id,
    action: 'delete',
    changedBy: userEmail,
    diff: { name: existing.name },
  });

  return json({ ok: true });
}
