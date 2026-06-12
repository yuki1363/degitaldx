// /api/inspections/masters — 点検項目マスタ（02）一覧・追加
//   GET  : 一覧（?equipment_id= 必須）
//   POST : 追加（admin のみ。追加内容を master_history にも記録）

import { json, jsonError, readJson } from '../../_lib/http.js';
import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { nowIso } from '../../_lib/util.js';

export const INPUT_TYPES = ['ok_ng', 'number', 'select', 'text'];

/** 点検項目の入力値を検証する */
export function parseMasterInput(body) {
  if (!body) return { error: 'リクエストボディが不正です。' };
  const name = String(body.name || '').trim();
  if (!name) return { error: '項目名（name）は必須です。' };
  if (name.length > 100) return { error: '項目名は100文字以内で入力してください。' };

  const inputType = String(body.input_type || 'ok_ng');
  if (!INPUT_TYPES.includes(inputType)) return { error: `input_type が不正です: ${inputType}` };

  const unit = body.unit ? String(body.unit).trim().slice(0, 20) : null;

  let minValue = null;
  let maxValue = null;
  if (inputType === 'number') {
    if (body.min_value !== null && body.min_value !== undefined && body.min_value !== '') {
      minValue = Number(body.min_value);
      if (!Number.isFinite(minValue)) return { error: '下限値（min_value）が数値ではありません。' };
    }
    if (body.max_value !== null && body.max_value !== undefined && body.max_value !== '') {
      maxValue = Number(body.max_value);
      if (!Number.isFinite(maxValue)) return { error: '上限値（max_value）が数値ではありません。' };
    }
    if (minValue !== null && maxValue !== null && minValue > maxValue) {
      return { error: '下限値が上限値を上回っています。' };
    }
  }

  let optionsJson = null;
  if (inputType === 'select') {
    const options = Array.isArray(body.options)
      ? body.options.map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (options.length < 2 || options.length > 20) {
      return { error: '選択式の選択肢は2〜20件で指定してください。' };
    }
    optionsJson = JSON.stringify(options.map((o) => o.slice(0, 50)));
  }

  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;

  return {
    value: {
      name,
      input_type: inputType,
      unit,
      min_value: minValue,
      max_value: maxValue,
      options_json: optionsJson,
      sort_order: sortOrder,
    },
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const equipmentId = Number(url.searchParams.get('equipment_id'));
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) {
    return jsonError(400, 'equipment_id を指定してください。');
  }

  const { results } = await env.DB.prepare(
    `SELECT id, equipment_id, name, input_type, unit, min_value, max_value, options_json, sort_order
       FROM inspection_master
      WHERE equipment_id = ?1 AND deleted_at IS NULL
      ORDER BY sort_order, id`
  )
    .bind(equipmentId)
    .all();

  return json({ masters: results });
}

export async function onRequestPost({ request, env, data }) {
  // マスタの変更は管理者のみ（CLAUDE.md 09 マスタ管理）
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const body = await readJson(request);
  const equipmentId = Number(body && body.equipment_id);
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) {
    return jsonError(400, 'equipment_id を指定してください。');
  }
  const equipment = await env.DB.prepare(
    'SELECT id FROM equipment_ledger WHERE id = ?1 AND deleted_at IS NULL'
  )
    .bind(equipmentId)
    .first();
  if (!equipment) return jsonError(404, '対象の設備が見つかりません。');

  const parsed = parseMasterInput(body);
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const result = await env.DB.prepare(
    `INSERT INTO inspection_master
       (equipment_id, name, input_type, unit, min_value, max_value, options_json, sort_order,
        created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  )
    .bind(
      equipmentId, v.name, v.input_type, v.unit, v.min_value, v.max_value,
      v.options_json, v.sort_order, data.user.email, nowIso()
    )
    .run();

  const id = result.meta.last_row_id;
  const snapshot = { id, equipment_id: equipmentId, ...v };
  await writeMasterHistory(env.DB, {
    masterName: 'inspection_master',
    recordId: id,
    snapshot,
    changedBy: data.user.email,
  });
  await writeAuditLog(env.DB, {
    tableName: 'inspection_master',
    recordId: id,
    action: 'create',
    changedBy: data.user.email,
    diff: snapshot,
  });

  return json({ id }, 201);
}
