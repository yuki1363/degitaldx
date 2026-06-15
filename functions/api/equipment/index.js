// /api/equipment — 設備台帳（06）一覧・登録
//   GET  : 一覧（?q= で設備番号・名称・場所を部分一致検索）
//   POST : 登録（editor 以上）

import { json, jsonError, readJson } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';

export const EQUIPMENT_STATUS = ['active', 'stopped', 'retired'];

/** リクエストボディから設備の入力値を取り出して検証する */
export function parseEquipmentInput(body) {
  if (!body) return { error: 'リクエストボディが不正です。' };
  const optional = (v, max) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    return s ? s.slice(0, max) : null;
  };

  const code = String(body.code || '').trim();
  const lineName = optional(body.line_name, 100);       // 設備名（共有）
  const equipmentName = optional(body.equipment_name, 100); // 機器名（共有）

  // 表示名(name)は各機能の見出し・検索に使う。明示があればそれを、無ければ
  // 「設備名＋機器名」から自動生成する（設備名・機器名に一本化したため）。
  let name = String(body.name || '').trim();
  if (!name) name = [lineName, equipmentName].filter(Boolean).join(' ');
  name = name.slice(0, 100);

  if (!code) return { error: '設備番号（code）は必須です。' };
  if (!name) return { error: '設備名は必須です。' };
  if (code.length > 50) return { error: '設備番号は50文字以内で入力してください。' };

  const status = body.status === undefined || body.status === '' ? 'active' : String(body.status);
  if (!EQUIPMENT_STATUS.includes(status)) {
    return { error: `status が不正です: ${status}` };
  }
  const installedOn = body.installed_on ? String(body.installed_on).trim() : null;
  if (installedOn && !/^\d{4}-\d{2}-\d{2}$/.test(installedOn)) {
    return { error: '設置日（installed_on）は YYYY-MM-DD 形式で入力してください。' };
  }
  return {
    value: {
      code,
      name,
      line_name: lineName,
      equipment_name: equipmentName,
      location: optional(body.location, 100),
      manufacturer: optional(body.manufacturer, 100),
      model: optional(body.model, 100),
      installed_on: installedOn,
      status,
      note: optional(body.note, 1000),
    },
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  const where = q
    ? `WHERE deleted_at IS NULL AND (code LIKE ?1 OR name LIKE ?1 OR location LIKE ?1)`
    : `WHERE deleted_at IS NULL`;
  const binds = q ? [`%${q}%`] : [];

  const run = async (cols) => {
    const stmt = env.DB.prepare(
      `SELECT ${cols} FROM equipment_ledger ${where} ORDER BY code LIMIT 300`
    );
    const r = await (binds.length ? stmt.bind(...binds) : stmt).all();
    return r.results;
  };

  let results;
  try {
    results = await run(
      'id, code, name, line_name, equipment_name, location, manufacturer, model, installed_on, status'
    );
  } catch {
    // line_name / equipment_name 列が未追加の環境でも一覧が開くようにフォールバック
    results = await run('id, code, name, location, manufacturer, model, installed_on, status');
  }
  return json({ equipment: results });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const parsed = parseEquipmentInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  // 設備番号の重複チェック（論理削除済みも含めて一意 = UNIQUE 制約と整合）
  const dup = await env.DB.prepare('SELECT id FROM equipment_ledger WHERE code = ?1')
    .bind(v.code)
    .first();
  if (dup) return jsonError(409, `設備番号「${v.code}」は既に使われています。`);

  const result = await env.DB.prepare(
    `INSERT INTO equipment_ledger
       (code, name, line_name, equipment_name, location, manufacturer, model, installed_on, status, note, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  )
    .bind(
      v.code, v.name, v.line_name, v.equipment_name, v.location, v.manufacturer, v.model,
      v.installed_on, v.status, v.note, data.user.email, nowIso()
    )
    .run();

  const id = result.meta.last_row_id;
  await writeAuditLog(env.DB, {
    tableName: 'equipment_ledger',
    recordId: id,
    action: 'create',
    changedBy: data.user.email,
    diff: v,
  });

  return json({ id }, 201);
}
