// 05: 部品在庫 — CSVインポート
// POST /api/parts/import  フロントが CSV をパースして送った行データを取り込む（差分マージ=editor以上／全置き換え=admin）
//
// mode: 'replace'（デフォルト）= 全置き換え（既存を全論理削除 → 再作成）
// mode: 'merge'               = 差分マージ（型番一致で更新＝CSVで対応付けた列のみ・新規は追加・既存の他部品は不変）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { normImportance } from './index.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { normalizeJa } from '../_lib/normalize.js';

const cell = (v) => {
  if (v === undefined || v === null) return null;
  // 取込時に NFKC 正規化（旧システムの半角カナ等をここで統一する。検索・表示のゆれ防止）
  const s = normalizeJa(String(v)).trim();
  return s === '' ? null : s;
};
const num = (v) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s !== '' && Number.isFinite(Number(s)) ? Math.trunc(Number(s)) : 0;
};

// 差分マージで更新してよい列（name は必須のため常に更新）と、その値の変換
const MERGE_UPDATABLE = [
  ['line_name', cell],
  ['equipment_name', cell],
  ['location', cell],
  ['quantity', num],
  ['safety_stock', num],
  ['importance', (v) => normImportance(v)],
  ['supplier', cell],
  ['note', cell],
];

export async function onRequestPost({ env, data, request }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const body = await readJson(request);
  if (!body || !Array.isArray(body.rows)) {
    return jsonError(400, 'リクエストボディが不正です。rows 配列が必要です。');
  }

  const mode = body.mode === 'merge' ? 'merge' : 'replace';
  // 全置き換えは全部品を論理削除して作り直す（入出庫履歴との紐づきも切れる）ため管理者のみ。
  // 差分マージは既存部品を消さないので入力可（editor）でも実行できる。
  if (mode === 'replace') {
    const deniedReplace = requireRole(data.user, 'admin');
    if (deniedReplace) return deniedReplace;
  }
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
  // 置き換え前のID一覧を控える（監査ログに残す。件数だけだと後から追跡できないため）
  const { results: beforeRows } = await DB.prepare(
    `SELECT id FROM parts_inventory WHERE deleted_at IS NULL`
  ).all();
  const beforeIds = (beforeRows ?? []).map((r) => r.id);

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
  const deleted = beforeIds.length;
  await writeAuditLog(DB, {
    tableName: 'parts_inventory',
    recordId: 0,
    action: 'update',
    changedBy: userEmail,
    // 証跡用に論理削除した対象ID一覧も残す（肥大化しないよう最大100件まで）
    diff: { mode: 'replace_all', deleted, deleted_ids: beforeIds.slice(0, 100), inserted, skipped, total: validRows.length + skipped },
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
      // UPDATE: 既存レコードを上書き。ただし CSV で対応付けた列（＝行にキーがある列）だけを更新する。
      // 画面は対応付けていない列をキーごと送らないため、全列を更新すると未対応付けの列が
      // 0／空で上書きされ、型番と部品名だけのマージで在庫数・場所・仕入先などが消えてしまう。
      // 列名は固定リスト（MERGE_UPDATABLE）からのみ組み立てる（入力値を SQL に連結しない）。
      const sets = ['name = ?'];
      const binds = [name];
      for (const [col, conv] of MERGE_UPDATABLE) {
        if (!Object.prototype.hasOwnProperty.call(row, col)) continue;
        sets.push(`${col} = ?`);
        binds.push(conv(row[col]));
      }
      sets.push('updated_by = ?', 'updated_at = ?');
      binds.push(userEmail, now, existingId);
      statements.push(
        DB.prepare(`UPDATE parts_inventory SET ${sets.join(', ')} WHERE id = ?`).bind(...binds)
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
