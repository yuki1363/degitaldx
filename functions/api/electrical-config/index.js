// 電気設備点検（12）の設定API（設備タイプごとのカスタム点検項目・既定）。
//   GET /api/electrical-config
//        → { main, battery, generator, defaults:{ main, battery, generator } }
//          （取り込み元アプリの exportConfig 形式。null=内蔵デフォルトを使う）
//   PUT /api/electrical-config   （admin のみ）
//        body: { equipment_type, config?, default? }
//        渡されたキー（config / default）だけ更新。変更前を master_history に退避（復元用）。
//        expected_updated_at（任意）: 送った端末が知っている更新日時。サーバーの方が新しければ 409
//          （オフライン中に保存できず端末に残した設定を後で再送するとき、その間に他の管理者が
//          保存した新しい設定を黙って上書きしないため）。応答の updated_at が新しい更新日時

import { writeAuditLog } from '../_lib/audit.js';
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
    'SELECT equipment_type, config_json, default_json, updated_at FROM electrical_config'
  ).all();
  const out = { main: null, battery: null, generator: null,
    defaults: { main: null, battery: null, generator: null },
    updated_at: { main: null, battery: null, generator: null } };
  for (const r of results ?? []) {
    if (!EQUIPMENT_TYPES.includes(r.equipment_type)) continue;
    out.updated_at[r.equipment_type] = r.updated_at ?? null;
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
    'SELECT config_json, default_json, updated_at FROM electrical_config WHERE equipment_type = ?'
  ).bind(type).first();

  const checkExpected = Object.prototype.hasOwnProperty.call(body, 'expected_updated_at');
  const expected = checkExpected ? (body.expected_updated_at ?? null) : null;
  if (checkExpected && (before?.updated_at ?? null) !== expected) {
    return jsonError(409, '他の管理者が後から設定を保存しています。', { updated_at: before?.updated_at ?? null });
  }

  const newConfig = hasConfig ? (body.config == null ? null : JSON.stringify(body.config)) : (before?.config_json ?? null);
  const newDefault = hasDefault ? (body.default == null ? null : JSON.stringify(body.default)) : (before?.default_json ?? null);
  const now = nowIso();

  // expected_updated_at があるときは、確認から書き込みまでの間に他の人が保存していないことも条件にする
  const res = await db.prepare(
    `INSERT INTO electrical_config (equipment_type, config_json, default_json, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(equipment_type) DO UPDATE
       SET config_json = ?2, default_json = ?3, updated_by = ?4, updated_at = ?5
       WHERE ?6 = 0 OR electrical_config.updated_at IS ?7`
  ).bind(type, newConfig, newDefault, data.user.email, now, checkExpected ? 1 : 0, expected).run();
  if ((res.meta?.changes ?? 0) === 0) {
    return jsonError(409, '他の管理者が後から設定を保存しています。');
  }

  // 変更前スナップショットを master_history に残す（復元の第3層）
  await writeMasterHistory(db, {
    masterName: 'electrical_config',
    recordId: null,
    snapshot: { equipment_type: type, config_json: before?.config_json ?? null, default_json: before?.default_json ?? null },
    changedBy: data.user.email,
  });

  // 誰がいつどの設定を変えたかを監査ログにも残す（変更前の内容は master_history に退避済み）
  await writeAuditLog(db, {
    tableName: 'electrical_config',
    recordId: type,
    action: 'update',
    changedBy: data.user.email,
    diff: { equipment_type: type, changed: [hasConfig ? 'config' : null, hasDefault ? 'default' : null].filter(Boolean) },
  });

  return json({ ok: true, updated_at: now });
}
