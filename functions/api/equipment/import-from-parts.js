// /api/equipment/import-from-parts — 在庫の設備名・機器名から設備台帳へ一括登録（editor以上）
//   POST : 在庫(parts_inventory)にある (設備名, 機器名) の組み合わせのうち、
//          まだ設備台帳に無いものを設備として一括作成する。
//          ・設備番号(code)は INV-0001 形式で自動採番（既存コードと重複しない番号を採る）
//          ・表示名(name)は「設備名＋機器名」から自動生成
//          ・既に台帳にある (設備名, 機器名) は重複作成しない

import { json, jsonError } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';

const comboKey = (line, equip) => `${line || ''}${equip || ''}`;

export async function onRequestPost({ env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const { DB } = env;
  const now = nowIso();
  const userEmail = data.user.email;

  // 在庫にある (設備名, 機器名) の組み合わせ（設備名ありのものだけ）
  const { results: combos } = await DB.prepare(
    `SELECT DISTINCT line_name, equipment_name
       FROM parts_inventory
      WHERE deleted_at IS NULL AND line_name IS NOT NULL AND TRIM(line_name) <> ''`
  ).all();

  // 既に台帳にある (設備名, 機器名) は除外する
  const { results: existing } = await DB.prepare(
    `SELECT line_name, equipment_name FROM equipment_ledger WHERE deleted_at IS NULL`
  ).all();
  const existingSet = new Set((existing ?? []).map((r) => comboKey(r.line_name, r.equipment_name)));

  // 設備番号の自動採番（既存コードと重複しない INV-NNNN を採る）
  const { results: codeRows } = await DB.prepare(`SELECT code FROM equipment_ledger`).all();
  const codeSet = new Set((codeRows ?? []).map((r) => r.code));
  let seq = 1;
  const nextCode = () => {
    let c;
    do {
      c = `INV-${String(seq).padStart(4, '0')}`;
      seq += 1;
    } while (codeSet.has(c));
    codeSet.add(c);
    return c;
  };

  const toCreate = (combos ?? []).filter((c) => !existingSet.has(comboKey(c.line_name, c.equipment_name)));
  if (toCreate.length === 0) {
    return json({ created: 0, message: '新規に追加する設備はありません（すべて登録済みです）。' });
  }

  const stmts = toCreate.map((c) => {
    const name = [c.line_name, c.equipment_name].filter(Boolean).join(' ').slice(0, 100);
    return DB.prepare(
      `INSERT INTO equipment_ledger
         (code, name, line_name, equipment_name, status, created_by, created_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?5, ?6)`
    ).bind(nextCode(), name, c.line_name, c.equipment_name, userEmail, now);
  });

  try {
    await DB.batch(stmts);
  } catch (err) {
    return jsonError(500, `一括登録に失敗しました: ${err.message}`);
  }

  await writeAuditLog(DB, {
    tableName: 'equipment_ledger',
    recordId: 0,
    action: 'create',
    changedBy: userEmail,
    diff: { mode: 'import_from_parts', created: toCreate.length },
  });

  return json({ created: toCreate.length });
}
