// 05: 部品在庫 — 一覧取得 / 新規登録
// GET  /api/parts          一覧（検索・要発注フィルタ）
// POST /api/parts          新規登録（editor以上）
//
// 項目: ライン名(line_name) / 機器名(equipment_name) / 部品名(name) /
//       型番(model_no・重複可) / 在庫場所(location) / 必要数(safety_stock) /
//       在庫数(quantity) / 重要度(importance=高/中/低) / 仕入れ先(supplier) / 備考(note)
//   ・型番は重複可（ライン/機器ごとに別行）。内部の一意キー part_no は
//     アプリ側で自動採番する（画面には出さない内部キー）。

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const IMPORTANCE_VALUES = ['高', '中', '低'];

// 重要度を 高/中/低 のいずれかに正規化（該当なしは null）
export function normImportance(v) {
  const s = (v ?? '').toString().trim();
  return IMPORTANCE_VALUES.includes(s) ? s : null;
}

const trimOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const toInt = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);

export async function onRequestGet({ env, request }) {
  const { DB } = env;
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const lowStock = url.searchParams.get('low_stock') === '1';

  let where = 'deleted_at IS NULL';
  const binds = [];
  if (q) {
    where += ' AND (model_no LIKE ?1 OR name LIKE ?1 OR line_name LIKE ?1 OR equipment_name LIKE ?1)';
    binds.push(`%${q}%`);
  }
  if (lowStock) {
    // 要発注 = 在庫数 < 必要数
    where += ' AND quantity < safety_stock';
  }

  const stmt = DB.prepare(
    `SELECT * FROM parts_inventory
      WHERE ${where}
      ORDER BY line_name, equipment_name, name`
  );
  const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all();
  return json({ parts: results });
}

export async function onRequestPost({ env, data, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');

  const name = trimOrNull(body.name);
  if (!name) return jsonError(400, '部品名（name）は必須です。');

  const now = nowIso();
  const { DB } = env;
  const userEmail = data.user.email;
  const surrogate = crypto.randomUUID(); // 内部一意キー（画面非表示）

  const fields = {
    model_no: trimOrNull(body.model_no),
    line_name: trimOrNull(body.line_name),
    equipment_name: trimOrNull(body.equipment_name),
    location: trimOrNull(body.location),
    quantity: toInt(body.quantity, 0),
    safety_stock: toInt(body.safety_stock, 0),
    importance: normImportance(body.importance),
    supplier: trimOrNull(body.supplier),
    supplier_email: trimOrNull(body.supplier_email),
    note: trimOrNull(body.note),
  };

  const result = await DB.prepare(
    `INSERT INTO parts_inventory
       (part_no, model_no, name, line_name, equipment_name, location, quantity, safety_stock,
        importance, supplier, supplier_email, note, unit,
        created_by, created_at, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?14, ?15)`
  )
    .bind(
      surrogate,
      fields.model_no,
      name,
      fields.line_name,
      fields.equipment_name,
      fields.location,
      fields.quantity,
      fields.safety_stock,
      fields.importance,
      fields.supplier,
      fields.supplier_email,
      fields.note,
      '個',
      userEmail,
      now
    )
    .run();

  const newId = result.meta?.last_row_id;

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: newId,
    action: 'create',
    changedBy: userEmail,
    diff: { name, ...fields },
  });

  return json({ id: newId }, 201);
}
