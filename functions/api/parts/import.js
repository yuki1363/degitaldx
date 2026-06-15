// 05: 部品在庫 — CSVインポート（全置き換え）
// POST /api/parts/import   フロントが CSV をパースして送った行データで全件を置き換える（editor以上）
//
// 方針:
//   ・項目: line_name(設備名) / equipment_name(機器名) / name(部品名) / model_no(型番) /
//           location(在庫場所) / safety_stock(必要数) / quantity(在庫数) /
//           importance(重要度) / supplier(仕入れ先) / note(備考)
//   ・CSV にない項目は空欄で取り込む（部品名 name のみ必須）
//   ・「全置き換え」: 既存の部品を全件 論理削除 → CSV の内容で作り直す。
//     CSV が完全な正となる。削除と登録は batch で原子的に実行する
//     （途中で失敗しても既存データは変更されない）。
//   ・内部キー part_no はアプリ側で自動採番する

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

  // 取り込む行を先に検証（部品名必須）。有効行が0なら既存を消さずに中断する
  const validRows = [];
  const errors = [];
  let skipped = 0;
  for (let i = 0; i < body.rows.length; i++) {
    const row = body.rows[i] || {};
    const name = cell(row.name);
    if (!name) {
      skipped++;
      errors.push({ row: i + 1, reason: '部品名（name）が空のため取り込めません。' });
      continue;
    }
    validRows.push({ row, name });
  }

  if (validRows.length === 0) {
    return jsonError(400, '取り込める行がありません（部品名が必須です）。既存データは変更していません。');
  }

  // 既存件数を記録（監査用）
  const before = await DB.prepare(
    `SELECT COUNT(*) AS n FROM parts_inventory WHERE deleted_at IS NULL`
  ).first();

  // 全置き換え: 既存を全件論理削除 → CSV を一括登録（batch で原子的に実行）
  const statements = [];
  statements.push(
    DB.prepare(
      `UPDATE parts_inventory
          SET deleted_at = ?1, deleted_by = ?2, updated_at = ?1, updated_by = ?2
        WHERE deleted_at IS NULL`
    ).bind(now, userEmail)
  );
  for (const { row, name } of validRows) {
    statements.push(
      DB.prepare(
        `INSERT INTO parts_inventory
           (part_no, model_no, name, line_name, equipment_name, location, quantity, safety_stock,
            importance, supplier, note, unit, created_by, created_at, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?13, ?14)`
      ).bind(
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
        '個',
        userEmail,
        now
      )
    );
  }

  try {
    await DB.batch(statements);
  } catch (err) {
    return jsonError(500, `取り込みに失敗しました（既存データは変更されていません）: ${err.message}`);
  }

  const inserted = validRows.length;
  const deleted = before?.n || 0;

  // 全置き換えのサマリーを監査ログに1件記録
  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: 0,
    action: 'update',
    changedBy: userEmail,
    diff: { mode: 'replace_all', deleted, inserted, skipped, total: body.rows.length },
  });

  // updated はこの方式では発生しない。フロント互換のため 0 を返す
  return json({ inserted, updated: 0, deleted, skipped, errors });
}
