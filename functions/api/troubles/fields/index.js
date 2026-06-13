// /api/troubles/fields — トラブル記録のカスタム項目定義（04 フォームビルダー）
//   GET  : 項目一覧（全ユーザー。トラブル入力フォームの描画に使う）
//   POST : 項目追加（admin。master_history に記録 → 復元可能）

import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

const INPUT_TYPES = ['text', 'number', 'select'];

/** 入力値の検証・正規化（[fid].js と共用） */
export function parseFieldInput(body) {
  const name = body?.name?.trim();
  if (!name) return { error: '項目名は必須です' };

  const input_type = body?.input_type || 'text';
  if (!INPUT_TYPES.includes(input_type)) return { error: '不正な input_type です' };

  let options_json = null;
  if (input_type === 'select') {
    const options = Array.isArray(body?.options)
      ? body.options.map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (options.length === 0) return { error: '選択式は選択肢を1つ以上指定してください' };
    options_json = JSON.stringify(options);
  }

  const sort_order = Number.isFinite(Number(body?.sort_order)) ? Number(body.sort_order) : 0;
  return { value: { name, input_type, options_json, sort_order } };
}

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM trouble_custom_field WHERE deleted_at IS NULL ORDER BY sort_order, id`
  ).all();
  return json({ fields: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const parsed = parseFieldInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(`
    INSERT INTO trouble_custom_field
      (name, input_type, options_json, sort_order, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(v.name, v.input_type, v.options_json, v.sort_order, userEmail, now, userEmail, now).run();

  const id = result.meta?.last_row_id;
  await writeMasterHistory(db, { masterName: 'trouble_custom_field', recordId: id, snapshot: v, changedBy: userEmail });
  await writeAuditLog(db, { tableName: 'trouble_custom_field', recordId: id, action: 'create', changedBy: userEmail, diff: v });
  return json({ id }, 201);
}
