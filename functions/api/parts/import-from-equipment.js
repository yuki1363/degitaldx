// /api/parts/import-from-equipment — 設備台帳から部品在庫へ一括登録（editor以上）
//   POST : 設備台帳にある (line_name, equipment_name) の組み合わせのうち、
//          まだ部品在庫に1件も登録されていないものをプレースホルダーとして一括作成する。
//          ・部品名は「（部品を登録してください）」で作成後に個別編集
//          ・既に部品が1件でも存在する (line_name, equipment_name) は追加しない

import { json, jsonError } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';

const comboKey = (line, equip) => `${line || ''}||${equip || ''}`;

export async function onRequestPost({ env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const { DB } = env;
  const now = nowIso();
  const userEmail = data.user.email;

  // 設備台帳にある (line_name, equipment_name) の組み合わせ（設備名ありのものだけ）
  const { results: equipment } = await DB.prepare(
    `SELECT DISTINCT line_name, equipment_name
       FROM equipment_ledger
      WHERE deleted_at IS NULL AND line_name IS NOT NULL AND TRIM(line_name) <> ''`
  ).all();

  // 既に部品在庫に1件以上ある (line_name, equipment_name) の組み合わせ
  const { results: existing } = await DB.prepare(
    `SELECT DISTINCT line_name, equipment_name FROM parts_inventory WHERE deleted_at IS NULL`
  ).all();
  const existingSet = new Set((existing ?? []).map((r) => comboKey(r.line_name, r.equipment_name)));

  const toCreate = (equipment ?? []).filter(
    (e) => !existingSet.has(comboKey(e.line_name, e.equipment_name))
  );

  if (toCreate.length === 0) {
    return json({ created: 0, message: '新規に追加する設備はありません（すべての設備に部品が登録済みです）。' });
  }

  const stmts = toCreate.map((e) =>
    DB.prepare(
      `INSERT INTO parts_inventory
         (part_no, name, line_name, equipment_name, unit, quantity, safety_stock,
          created_by, created_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, '個', 0, 0, ?5, ?6, ?5, ?6)`
    ).bind(
      crypto.randomUUID(), // 内部一意キー part_no（画面非表示・NOT NULL 制約を満たす）
      '（部品を登録してください）',
      e.line_name,
      e.equipment_name || null,
      userEmail,
      now
    )
  );

  try {
    await DB.batch(stmts);
  } catch (err) {
    return jsonError(500, `一括登録に失敗しました: ${err.message}`);
  }

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: 0,
    action: 'create',
    changedBy: userEmail,
    diff: { mode: 'import_from_equipment', created: toCreate.length },
  });

  return json({ created: toCreate.length });
}
