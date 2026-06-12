// 05: 部品在庫 — CSVインポート（一括登録/更新）
// POST /api/parts/import   フロントが CSV をパースして送った行データを一括処理（editor以上）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

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
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < body.rows.length; i++) {
    const row = body.rows[i];
    const rowNum = i + 1;

    // 必須項目チェック
    if (!row.part_no || !row.name) {
      skipped++;
      errors.push({ row: rowNum, reason: 'part_no と name は必須です。' });
      continue;
    }

    const part_no      = String(row.part_no).trim();
    const name         = String(row.name).trim();
    const spec         = row.spec        ? String(row.spec).trim()        : null;
    const unit         = row.unit        ? String(row.unit).trim()        : '個';
    const quantity     = row.quantity    !== undefined && row.quantity !== '' ? Number(row.quantity)     : 0;
    const safety_stock = row.safety_stock !== undefined && row.safety_stock !== '' ? Number(row.safety_stock) : 0;
    const location     = row.location    ? String(row.location).trim()    : null;
    const supplier     = row.supplier    ? String(row.supplier).trim()    : null;
    const note         = row.note        ? String(row.note).trim()        : null;

    if (!part_no || !name) {
      skipped++;
      errors.push({ row: rowNum, reason: 'part_no または name が空です。' });
      continue;
    }

    try {
      // 既存部品を検索（論理削除されていないもの）
      const existing = await DB.prepare(
        `SELECT id FROM parts_inventory WHERE part_no = ?1 AND deleted_at IS NULL`
      )
        .bind(part_no)
        .first();

      if (existing) {
        // 更新: 非空のフィールドのみ上書き
        await DB.prepare(
          `UPDATE parts_inventory
              SET name         = CASE WHEN ?1 != '' THEN ?1 ELSE name END,
                  spec         = CASE WHEN ?2 IS NOT NULL THEN ?2 ELSE spec END,
                  unit         = CASE WHEN ?3 != '' THEN ?3 ELSE unit END,
                  safety_stock = ?4,
                  location     = CASE WHEN ?5 IS NOT NULL THEN ?5 ELSE location END,
                  supplier     = CASE WHEN ?6 IS NOT NULL THEN ?6 ELSE supplier END,
                  note         = CASE WHEN ?7 IS NOT NULL THEN ?7 ELSE note END,
                  updated_by   = ?8,
                  updated_at   = ?9
            WHERE id = ?10`
        )
          .bind(name, spec, unit, safety_stock, location, supplier, note, userEmail, now, existing.id)
          .run();
        updated++;
      } else {
        // 新規登録
        await DB.prepare(
          `INSERT INTO parts_inventory
             (part_no, name, spec, unit, quantity, safety_stock, location, supplier, note,
              created_by, created_at, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10, ?11)`
        )
          .bind(
            part_no, name, spec, unit, quantity, safety_stock,
            location, supplier, note, userEmail, now
          )
          .run();
        inserted++;
      }
    } catch (err) {
      skipped++;
      errors.push({ row: rowNum, reason: `DB エラー: ${err.message}` });
    }
  }

  // 一括インポートのサマリー監査ログを1件だけ記録
  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: 0,
    action: 'create',
    changedBy: userEmail,
    diff: { inserted, updated, skipped, total: body.rows.length },
  });

  return json({ inserted, updated, skipped, errors });
}
