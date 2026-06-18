// /api/print-templates — 帳票テンプレート（工事連絡書・トラブル報告書）
//   GET  : 一覧（認証済みユーザー全員。印刷ダイアログ・管理画面の両方で使用）
//   POST : 作成（admin のみ）
//
// 既存のExcel用紙を画像化してアップロード（image_file_id）し、その上にデータ差込欄を
// 位置指定（fields_json）で重ねて印刷する。管理は admin、印刷は editor が行う。

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export const TEMPLATE_TYPES = ['construction_notice', 'trouble_report'];
export const ORIENTATIONS = ['portrait', 'landscape'];

/** リクエストボディからテンプレートの入力値を検証して取り出す（POST/PUT 共通） */
export function parseTemplateInput(body) {
  if (!body) return { error: 'リクエストボディが不正です。' };

  const name = String(body.name || '').trim();
  if (!name) return { error: 'テンプレート名（name）は必須です。' };
  if (name.length > 100) return { error: 'テンプレート名は100文字以内で入力してください。' };

  if (!TEMPLATE_TYPES.includes(body.template_type)) {
    return { error: `template_type は ${TEMPLATE_TYPES.join('/')} のいずれかです。` };
  }
  const orientation = ORIENTATIONS.includes(body.orientation) ? body.orientation : 'portrait';

  let imageFileId = null;
  if (body.image_file_id !== undefined && body.image_file_id !== null && body.image_file_id !== '') {
    imageFileId = Number(body.image_file_id);
    if (!Number.isInteger(imageFileId) || imageFileId <= 0) {
      return { error: 'image_file_id が不正です。' };
    }
  }

  // fields は配列（文字列でも配列でも受け、配列以外は拒否）。保存は JSON 文字列
  let fieldsJson = '[]';
  const raw = body.fields_json !== undefined ? body.fields_json : body.fields;
  if (raw !== undefined && raw !== null && raw !== '') {
    let parsed;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { return { error: 'fields_json が不正なJSONです。' }; }
    } else {
      parsed = raw;
    }
    if (!Array.isArray(parsed)) return { error: 'fields_json は配列である必要があります。' };
    fieldsJson = JSON.stringify(parsed);
  }

  return { value: { name, template_type: body.template_type, orientation, image_file_id: imageFileId, fields_json: fieldsJson } };
}

/** 背景用紙画像を print_templates レコードに紐づける（誤って他レコードに奪われないように） */
export async function attachTemplateImage(db, { imageFileId, templateId, userEmail, now }) {
  if (!imageFileId) return;
  await db.prepare(
    `UPDATE files SET related_table = 'print_templates', related_id = ?1, updated_by = ?2, updated_at = ?3
       WHERE id = ?4 AND deleted_at IS NULL`
  ).bind(templateId, userEmail, now, imageFileId).run();
}

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, template_type, image_file_id, orientation, fields_json, created_at, updated_at
       FROM print_templates
      WHERE deleted_at IS NULL
      ORDER BY template_type, name`
  ).all();
  return json({ templates: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const parsed = parseTemplateInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const db = env.DB;
  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(
    `INSERT INTO print_templates
       (name, template_type, image_file_id, orientation, fields_json, created_by, created_at, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?7)`
  ).bind(v.name, v.template_type, v.image_file_id, v.orientation, v.fields_json, userEmail, now).run();

  const id = result.meta?.last_row_id;
  await attachTemplateImage(db, { imageFileId: v.image_file_id, templateId: id, userEmail, now });

  await writeAuditLog(db, {
    tableName: 'print_templates',
    recordId: id,
    action: 'create',
    changedBy: userEmail,
    diff: { name: v.name, template_type: v.template_type, orientation: v.orientation, image_file_id: v.image_file_id },
  });

  return json({ id }, 201);
}
