// 13 ユーティリティ日報 — 点検項目マスタ 一覧・追加
//   GET  /api/utility-reports/items   （認証済み全員）
//   POST /api/utility-reports/items   （admin のみ。追加内容を master_history にも記録）

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { ensureUtilitySchema, INPUT_TYPES } from '../_schema.js';
import { listItems } from '../_values.js';

/** 項目マスタの入力値を検証する（02 点検の parseMasterInput と同じ流儀） */
export function parseItemInput(body) {
  if (!body) return { error: 'リクエストボディが不正です。' };

  const name = String(body.name || '').trim();
  if (!name) return { error: '項目名（name）は必須です。' };
  if (name.length > 100) return { error: '項目名は100文字以内で入力してください。' };

  const inputType = String(body.input_type || 'number');
  if (!INPUT_TYPES.includes(inputType)) return { error: `input_type が不正です: ${inputType}` };

  const section = body.section ? String(body.section).trim().slice(0, 50) : '';
  const unit = body.unit ? String(body.unit).trim().slice(0, 20) : null;

  let minValue = null;
  let maxValue = null;
  if (inputType === 'number') {
    for (const [key, raw] of [['min_value', body.min_value], ['max_value', body.max_value]]) {
      if (raw === null || raw === undefined || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${key} が数値ではありません。` };
      if (key === 'min_value') minValue = n; else maxValue = n;
    }
    if (minValue !== null && maxValue !== null && minValue > maxValue) {
      return { error: '下限値が上限値を上回っています。' };
    }
  }

  let optionsJson = null;
  let alertOptionsJson = null;
  if (inputType === 'select' || inputType === 'multi') {
    const options = Array.isArray(body.options)
      ? body.options.map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (options.length < 2 || options.length > 20) {
      return { error: '選択肢は2〜20件で指定してください。' };
    }
    const trimmed = options.map((o) => o.slice(0, 50));
    optionsJson = JSON.stringify(trimmed);

    if (inputType === 'select' && Array.isArray(body.alert_options)) {
      const alerts = body.alert_options.map((o) => String(o).trim()).filter(Boolean);
      const invalid = alerts.find((a) => !trimmed.includes(a));
      if (invalid) return { error: `異常扱いの選択肢が選択肢にありません: ${invalid}` };
      if (alerts.length) alertOptionsJson = JSON.stringify(alerts);
    }
  }

  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;

  return {
    value: {
      section, name, input_type: inputType, unit,
      min_value: minValue, max_value: maxValue,
      options_json: optionsJson, alert_options_json: alertOptionsJson,
      sort_order: sortOrder,
    },
  };
}

export async function onRequestGet({ env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  await ensureUtilitySchema(db);
  return json({ items: await listItems(db) });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;
  const db = env.DB;
  await ensureUtilitySchema(db);

  const parsed = parseItemInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const now = nowIso();
  const email = data.user.email;
  const res = await db.prepare(
    `INSERT INTO utility_item
       (section, name, input_type, unit, min_value, max_value,
        options_json, alert_options_json, sort_order, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    v.section, v.name, v.input_type, v.unit, v.min_value, v.max_value,
    v.options_json, v.alert_options_json, v.sort_order, email, now, email, now
  ).run();

  const id = res.meta?.last_row_id;
  await writeAuditLog(db, {
    tableName: 'utility_item', recordId: id, action: 'create', changedBy: email, diff: v,
  });
  await writeMasterHistory(db, {
    masterName: 'utility_item', recordId: id, snapshot: { id, ...v }, changedBy: email,
  });
  return json({ id }, 201);
}
