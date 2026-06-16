// 05: 部品在庫 — CSVインポート
// POST /api/parts/import  フロントが CSV をパースして送った行データを取り込む（editor以上）
//
// mode: 'replace'（デフォルト）= 全置き換え（既存を全論理削除 → 再作成）
// mode: 'merge'               = 差分マージ（型番一致で更新・新規のみ追加・既存不変）

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

  const mode = body.mode === 'merge' ? 'merge' : 'replace';
  const { DB } = env;
  const userEmail = data.user.email;
  const now = nowIso();

  // 取り込む行を先に検証（部品名必須）
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

  if (mode === 'replace') {
    return doReplace(DB, userEmail, now, validRows, skipped, errors);
  } else {
    return doMerge(DB, userEmail, now, validRows, skipped, errors);
  }
}

// --- 全置き換えモード ---
async function doReplace(DB, userEmail, now, validRows, skipped, errors) {
  const before = await DB.prepare(
    `SELECT COUNT(*) AS n FROM parts_inventory WHERE deleted_at IS NULL`
  ).first();

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
        crypto.randomUUID(),
        cell(row.model_no),
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
  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: 0,
    action: 'update',
    changedBy: userEmail,
    diff: { mode: 'replace_all', deleted, inserted, skipped, total: validRows.length + skipped },
  });

  return json({ inserted, updated: 0, deleted, skipped, errors });
}

// --- 差分マージモード ---
async function doMerge(DB, userEmail, now, validRows, skipped, errors) {
  // 既存部品を型番（model_no）でインデックス化
  const { results: existing } = await DB.prepare(
    `SELECT id, model_no FROM parts_inventory WHERE deleted_at IS NULL AND model_no IS NOT NULL`
  ).all();
  const existingByModelNo = new Map((existing ?? []).map((r) => [r.model_no, r.id]));

  const statements = [];
  let inserted = 0;
  let updated = 0;

  for (const { row, name } of validRows) {
    const modelNo = cell(row.model_no);
    const existingId = modelNo ? existingByModelNo.get(modelNo) : null;

    if (existingId) {
      // UPDATE: 既存レコードを上書き
      statements.push(
        DB.prepare(
          `UPDATE parts_inventory SET
             name = ?1, line_name = ?2, equipment_name = ?3, location = ?4,
             quantity = ?5, safety_stock = ?6, importance = ?7,
             supplier = ?8, note = ?9, updated_by = ?10, updated_at = ?11
           WHERE id = ?12`
        ).bind(
          name,
          cell(row.line_name),
          cell(row.equipment_name),
          cell(row.location),
          num(row.quantity),
          num(row.safety_stock),
          normImportance(row.importance),
          cell(row.supplier),
          cell(row.note),
          userEmail,
          now,
          existingId
        )
      );
      updated++;
    } else {
      // INSERT: 新規追加
      statements.push(
        DB.prepare(
          `INSERT INTO parts_inventory
             (part_no, model_no, name, line_name, equipment_name, location, quantity, safety_stock,
              importance, supplier, note, unit, created_by, created_at, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?13, ?14)`
        ).bind(
          crypto.randomUUID(),
          modelNo,
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
      inserted++;
    }
  }

  if (statements.length > 0) {
    try {
      await DB.batch(statements);
    } catch (err) {
      return jsonError(500, `取り込みに失敗しました: ${err.message}`);
    }
  }

  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: 0,
    action: 'update',
    changedBy: userEmail,
    diff: { mode: 'merge', inserted, updated, skipped, total: validRows.length + skipped },
  });

  return json({ inserted, updated, deleted: 0, skipped, errors });
}
