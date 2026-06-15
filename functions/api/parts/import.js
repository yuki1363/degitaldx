// 05: 部品在庫 — CSVインポート（一括登録）
// POST /api/parts/import   フロントが CSV をパースして送った行データを一括登録（editor以上）
//
// 方針:
//   ・項目: line_name / equipment_name / name / model_no(型番) / location /
//           safety_stock(必要数) / quantity(在庫数) / importance(重要度) / supplier / note
//   ・CSV にない項目は空欄で取り込む（部品名 name のみ必須）
//   ・型番(model_no)は重複可。ライン/機器ごとに別行として常に新規登録する
//     （内部キー part_no はアプリ側で自動採番）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { normImportance } from './index.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const cell = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const num = (v) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s !== '' && Number.isFinite(Number(s)) ? Math.trunc(Number(s)) : 0;
};

export async function onRequestPost({ env, data, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const body = await readJson(request);
  if (!body || !Array.isArray(body.rows)) {
    return jsonError(400, 'リクエストボディが不正です。rows 配列が必要です。');
  }

  const { DB } = env;
  const userEmail = data.user.email;
  const now = nowIso();

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < body.rows.length; i++) {
    const row = body.rows[i] || {};
    const rowNum = i + 1;

    const name = cell(row.name);
    if (!name) {
      skipped++;
      errors.push({ row: rowNum, reason: '部品名（name）が空のため取り込めません。' });
      continue;
    }

    try {
      await DB.prepare(
        `INSERT INTO parts_inventory
           (part_no, model_no, name, line_name, equipment_name, location, quantity, safety_stock,
            importance, supplier, note, unit, created_by, created_at, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?13, ?14)`
      )
        .bind(
          crypto.randomUUID(),       // 内部一意キー（自動採番）
          cell(row.model_no),        // 型番（重複可）
          name,
          cell(row.line_name),
          cell(row.equipment_name),
          cell(row.location),
          num(row.quantity),
          num(row.safety_stock),
          normImportance(row.importance),
          cell(row.supplier),
          cell(row.note),
          '個'
        )
        .run();
      inserted++;
    } catch (err) {
      skipped++;
      errors.push({ row: rowNum, reason: `DB エラー: ${err.message}` });
    }
  }

  // 一括インポートのサマリーを監査ログに1件記録
  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: 0,
    action: 'create',
    changedBy: userEmail,
    diff: { inserted, skipped, total: body.rows.length },
  });

  // updated は廃止（常に新規登録）。フロント互換のため 0 を返す
  return json({ inserted, updated: 0, skipped, errors });
}
