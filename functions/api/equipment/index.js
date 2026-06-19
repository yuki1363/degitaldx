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

  // code の必須チェックは POST 側で auto-generate できるため省略可（PUT は呼び出し元でチェック）
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
  const manufacturedOn = body.manufactured_on ? String(body.manufactured_on).trim() : null;
  if (manufacturedOn && !/^\d{4}-\d{2}$/.test(manufacturedOn)) {
    return { error: '製造年月（manufactured_on）は YYYY-MM 形式で入力してください。' };
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
      serial_no: optional(body.serial_no, 100),
      manufactured_on: manufacturedOn,
      installed_on: installedOn,
      status,
      note: optional(body.note, 1000),
    },
  };
}

const EQ_CODE_RE = /^(\d+)-(\d+)$/;

/**
 * 設備（line_name）ごとの連番コード「NN-MM」を採番する。
 *   - 同じ設備に既存の機器があれば、その設備番号(NN)の続き番号(MM)を付ける
 *   - 新しい設備なら、設備番号(NN)を「最大+1」にして MM=01 から始める
 * UNIQUE 制約（論理削除済みも対象）と衝突しないよう、MM は同一設備の全行の最大+1 にする。
 */
export async function computeNextEquipmentCode(db, lineName) {
  const { results } = await db.prepare(
    'SELECT code, line_name, deleted_at FROM equipment_ledger'
  ).all();

  let maxSetubi = 0;
  const maxKikiBySetubi = new Map();   // 設備番号NN -> その設備の最大 機器番号MM（全行・削除含む）
  let setubiOfLine = null;             // 指定 line_name の既存 設備番号（有効行から）

  for (const r of results || []) {
    const m = EQ_CODE_RE.exec(r.code || '');
    if (!m) continue;
    const nn = Number(m[1]);
    const mm = Number(m[2]);
    if (nn > maxSetubi) maxSetubi = nn;
    if (mm > (maxKikiBySetubi.get(nn) || 0)) maxKikiBySetubi.set(nn, mm);
    if (!r.deleted_at && lineName && (r.line_name || '') === lineName) {
      setubiOfLine = setubiOfLine === null ? nn : Math.min(setubiOfLine, nn);
    }
  }

  const nn = setubiOfLine !== null ? setubiOfLine : maxSetubi + 1;
  const mm = (maxKikiBySetubi.get(nn) || 0) + 1;
  return `${String(nn).padStart(2, '0')}-${String(mm).padStart(2, '0')}`;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  const cond = q
    ? `e.deleted_at IS NULL AND (e.code LIKE ?1 OR e.name LIKE ?1 OR e.location LIKE ?1)`
    : `e.deleted_at IS NULL`;
  const binds = q ? [`%${q}%`] : [];

  // 設備ごとの画像ファイル数（content_type が image/* のもの）
  const imgCountSub = `(SELECT COUNT(*) FROM files f
      WHERE f.related_table = 'equipment_ledger' AND f.related_id = e.id
        AND f.deleted_at IS NULL AND f.content_type LIKE 'image/%') AS image_count`;

  const run = async (cols) => {
    const stmt = env.DB.prepare(
      `SELECT ${cols} FROM equipment_ledger e WHERE ${cond} ORDER BY e.code LIMIT 300`
    );
    const r = await (binds.length ? stmt.bind(...binds) : stmt).all();
    return r.results;
  };

  let results;
  try {
    results = await run(
      `e.id, e.code, e.name, e.line_name, e.equipment_name, e.location, e.manufacturer, e.model, e.installed_on, e.status, ${imgCountSub}`
    );
  } catch {
    try {
      // line_name / equipment_name 列が未追加の環境でも一覧が開くようにフォールバック
      results = await run(
        `e.id, e.code, e.name, e.location, e.manufacturer, e.model, e.installed_on, e.status, ${imgCountSub}`
      );
    } catch {
      // files テーブルも未作成の環境向け最終フォールバック
      const stmt2 = env.DB.prepare(
        `SELECT id, code, name, location, manufacturer, model, installed_on, status
           FROM equipment_ledger WHERE deleted_at IS NULL ORDER BY code LIMIT 300`
      );
      results = (await stmt2.all()).results;
    }
  }
  return json({ equipment: results });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const parsed = parseEquipmentInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  // code が空なら設備（line_name）ごとの連番を自動採番する
  if (!v.code) {
    v.code = await computeNextEquipmentCode(env.DB, v.line_name);
  }

  // 設備番号の重複チェック（論理削除済みも含めて一意 = UNIQUE 制約と整合）
  const dup = await env.DB.prepare('SELECT id FROM equipment_ledger WHERE code = ?1')
    .bind(v.code)
    .first();
  if (dup) return jsonError(409, `設備番号「${v.code}」は既に使われています。`);

  const result = await env.DB.prepare(
    `INSERT INTO equipment_ledger
       (code, name, line_name, equipment_name, location, manufacturer, model, serial_no, manufactured_on, installed_on, status, note, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
  )
    .bind(
      v.code, v.name, v.line_name, v.equipment_name, v.location, v.manufacturer, v.model,
      v.serial_no, v.manufactured_on, v.installed_on, v.status, v.note, data.user.email, nowIso()
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
