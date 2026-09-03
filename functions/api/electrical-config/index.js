// 電気設備点検（12）の設定API（設備タイプごとのカスタム点検項目・既定）。
//   GET /api/electrical-config
//        → { main, battery, generator, defaults:{ main, battery, generator } }
//          （取り込み元アプリの exportConfig 形式。null=内蔵デフォルトを使う）
//   PUT /api/electrical-config   （admin のみ）
//        body: { equipment_type, config?, default? }
//        渡されたキー（config / default）だけ更新。変更前を master_history に退避（復元用）。

import { requireRole } from '../_lib/auth.js';
import { writeMasterHistory } from '../_lib/history.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureElectricalSchema, EQUIPMENT_TYPES } from '../electrical-inspections/index.js';

export async function onRequestGet({ env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  await ensureElectricalSchema(db);

  const { results } = await db.prepare(
    'SELECT equipment_type, config_json, default_json FROM electrical_config'
  ).all();
  const out = { main: null, battery: null, generator: null,
    defaults: { main: null, battery: null, generator: null } };
  for (const r of results ?? []) {
    if (!EQUIPMENT_TYPES.includes(r.equipment_type)) continue;
    try { out[r.equipment_type] = r.config_json ? JSON.parse(r.config_json) : null; } catch { /* keep null */ }
    try { out.defaults[r.equipment_type] = r.default_json ? JSON.parse(r.default_json) : null; } catch { /* keep null */ }
  }
  return json(out);
}

export async function onRequestPut({ env, request, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;
  const db = env.DB;
  await ensureElectricalSchema(db);

  const body = await readJson(request);
  const type = String(body?.equipment_type || '').trim();
  if (!EQUIPMENT_TYPES.includes(type)) return jsonError(400, 'equipment_type が不正です');

  const hasConfig = body && Object.prototype.hasOwnProperty.call(body, 'config');
  const hasDefault = body && Object.prototype.hasOwnProperty.call(body, 'default');
  if (!hasConfig && !hasDefault) return jsonError(400, 'config または default を指定してください');

  const before = await db.prepare(
    'SELECT config_json, default_json FROM electrical_config WHERE equipment_type = ?'
  ).bind(type).first();

  // 変更前スナップショットを master_history に残す（復元の第3層）
  await writeMasterHistory(db, {
    masterName: 'electrical_config',
    recordId: null,
    snapshot: { equipment_type: type, config_json: before?.config_json ?? null, default_json: before?.default_json ?? null },
    changedBy: data.user.email,
  });

  const newConfig = hasConfig ? (body.config == null ? null : JSON.stringify(body.config)) : (before?.config_json ?? null);
  const newDefault = hasDefault ? (body.default == null ? null : JSON.stringify(body.default)) : (before?.default_json ?? null);
  const now = nowIso();

  await db.prepare(
    `INSERT INTO electrical_config (equipment_type, config_json, default_json, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(equipment_type) DO UPDATE
       SET config_json = ?2, default_json = ?3, updated_by = ?4, updated_at = ?5`
  ).bind(type, newConfig, newDefault, data.user.email, now).run();

  return json({ ok: true });
}
