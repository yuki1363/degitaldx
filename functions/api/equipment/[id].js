// /api/equipment/:id — 設備台帳（06）詳細・編集・削除
//   GET    : 詳細（関連資料・直近の点検履歴・変更履歴つき）
//   PUT    : 編集（editor 以上。変更差分を audit_log に記録）
//   DELETE : 論理削除（editor 以上）

import { json, jsonError, readJson } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';
import { listAttachedFiles } from '../_lib/storage.js';
import { parseEquipmentInput } from './index.js';

async function findEquipment(env, idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  const run = (cols) =>
    env.DB.prepare(
      `SELECT ${cols} FROM equipment_ledger WHERE id = ?1 AND deleted_at IS NULL`
    )
      .bind(id)
      .first();
  // 列の追加（マイグレーション）が部分的にしか適用されていない環境でも詳細が
  // 開けるよう、列の多い順に段階的にフォールバックする。
  const colsFull =
    `id, code, name, line_name, equipment_name, location, manufacturer, model, serial_no, manufactured_on, installed_on, status, note,
     created_by, created_at, updated_by, updated_at`;
  const colsNoMfg =
    `id, code, name, line_name, equipment_name, location, manufacturer, model, installed_on, status, note,
     created_by, created_at, updated_by, updated_at`;
  const colsBase =
    `id, code, name, location, manufacturer, model, installed_on, status, note,
     created_by, created_at, updated_by, updated_at`;
  try {
    return await run(colsFull);
  } catch {
    try {
      return await run(colsNoMfg);
    } catch {
      return run(colsBase);
    }
  }
}

export async function onRequestGet({ env, params }) {
  const equipment = await findEquipment(env, params.id);
  if (!equipment) return jsonError(404, '設備が見つかりません。');

  // 関連情報（資料・点検履歴・変更履歴）はそれぞれ独立して取得し、
  // 一部の取得に失敗しても詳細ページ自体は必ず開けるようにする
  // （テーブルのスキーマ差異などで 1 クエリが失敗しても 500 にしない）。
  const safe = async (fn) => {
    try {
      const r = await fn();
      return r || [];
    } catch (err) {
      console.error('equipment detail subquery failed:', err && err.stack ? err.stack : err);
      return [];
    }
  };

  const [files, inspections, troubles, repairs, plans, history, parts] = await Promise.all([
    safe(() => listAttachedFiles(env, 'equipment_ledger', equipment.id)),
    safe(() =>
      env.DB.prepare(
        `SELECT r.id, r.inspected_at, r.has_abnormal, r.assignee_name
           FROM inspection_result r
          WHERE r.equipment_id = ?1 AND r.deleted_at IS NULL
          ORDER BY r.inspected_at DESC
          LIMIT 10`
      )
        .bind(equipment.id)
        .all()
        .then((r) => r.results)
    ),
    // トラブル履歴（04）— equipment_id で確実に紐づく
    safe(() =>
      env.DB.prepare(
        `SELECT t.id, t.occurred_at, t.phenomenon, tc.name AS category_name
           FROM trouble_record t
           LEFT JOIN trouble_category tc ON t.category_id = tc.id
          WHERE t.equipment_id = ?1 AND t.deleted_at IS NULL
          ORDER BY t.occurred_at DESC, t.id DESC
          LIMIT 10`
      )
        .bind(equipment.id)
        .all()
        .then((r) => r.results)
    ),
    // 業務依頼履歴（03）— equipment_id で確実に紐づく
    safe(() =>
      env.DB.prepare(
        `SELECT r.id, r.title, r.status, r.created_at
           FROM repair_request r
          WHERE r.equipment_id = ?1 AND r.deleted_at IS NULL
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 10`
      )
        .bind(equipment.id)
        .all()
        .then((r) => r.results)
    ),
    // 今後の保全計画（01）— 計画は自由入力の設備名・機器名で保存されるため、
    // 設備台帳の line_name / equipment_name と一致する未完了の予定を予定日順で拾う。
    safe(() => {
      if (!equipment.line_name && !equipment.equipment_name) return [];
      return env.DB.prepare(
        `SELECT id, title, plan_type, planned_date, planned_end_date, status
           FROM maintenance_plan
          WHERE deleted_at IS NULL AND status != 'done'
            AND COALESCE(line_name, '') = COALESCE(?1, '')
            AND COALESCE(equipment_name, '') = COALESCE(?2, '')
          ORDER BY planned_date ASC, id ASC
          LIMIT 10`
      )
        .bind(equipment.line_name || '', equipment.equipment_name || '')
        .all()
        .then((r) => r.results);
    }),
    safe(() =>
      env.DB.prepare(
        `SELECT action, changed_by, changed_at, diff_json
           FROM audit_log
          WHERE table_name = 'equipment_ledger' AND record_id = ?1
          ORDER BY changed_at DESC, id DESC
          LIMIT 20`
      )
        .bind(equipment.id)
        .all()
        .then((r) => r.results)
    ),
    // 関連部品（05）— 設備名・機器名で照合（部品在庫↔設備台帳の紐づけ）
    safe(() => {
      if (!equipment.line_name) return [];
      return env.DB.prepare(
        `SELECT id, name, model_no, quantity, safety_stock, importance
           FROM parts_inventory
          WHERE deleted_at IS NULL
            AND COALESCE(line_name, '') = COALESCE(?1, '')
            AND COALESCE(equipment_name, '') = COALESCE(?2, '')
          ORDER BY name ASC
          LIMIT 20`
      )
        .bind(equipment.line_name || '', equipment.equipment_name || '')
        .all()
        .then((r) => r.results);
    }),
  ]);

  return json({ equipment, files, inspections, troubles, repairs, plans, history, parts });
}

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const existing = await findEquipment(env, params.id);
  if (!existing) return jsonError(404, '設備が見つかりません。');

  const parsed = parseEquipmentInput(await readJson(request));
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  if (v.code !== existing.code) {
    const dup = await env.DB.prepare('SELECT id FROM equipment_ledger WHERE code = ?1 AND id != ?2')
      .bind(v.code, existing.id)
      .first();
    if (dup) return jsonError(409, `設備番号「${v.code}」は既に使われています。`);
  }

  // 変更された項目だけを差分として audit_log に残す
  const diff = {};
  for (const key of Object.keys(v)) {
    const before = existing[key] === undefined ? null : existing[key];
    if (before !== v[key]) diff[key] = { before, after: v[key] };
  }
  if (Object.keys(diff).length === 0) return json({ id: existing.id, unchanged: true });

  await env.DB.prepare(
    `UPDATE equipment_ledger
        SET code = ?1, name = ?2, line_name = ?3, equipment_name = ?4, location = ?5, manufacturer = ?6, model = ?7,
            serial_no = ?8, manufactured_on = ?9, installed_on = ?10, status = ?11, note = ?12,
            updated_by = ?13, updated_at = ?14
      WHERE id = ?15 AND deleted_at IS NULL`
  )
    .bind(
      v.code, v.name, v.line_name, v.equipment_name, v.location, v.manufacturer, v.model,
      v.serial_no, v.manufactured_on, v.installed_on, v.status, v.note, data.user.email, nowIso(), existing.id
    )
    .run();

  await writeAuditLog(env.DB, {
    tableName: 'equipment_ledger',
    recordId: existing.id,
    action: 'update',
    changedBy: data.user.email,
    diff,
  });

  return json({ id: existing.id });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const existing = await findEquipment(env, params.id);
  if (!existing) return jsonError(404, '設備が見つかりません。');

  await env.DB.prepare(
    `UPDATE equipment_ledger SET deleted_by = ?1, deleted_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`
  )
    .bind(data.user.email, nowIso(), existing.id)
    .run();

  await writeAuditLog(env.DB, {
    tableName: 'equipment_ledger',
    recordId: existing.id,
    action: 'delete',
    changedBy: data.user.email,
    diff: { code: existing.code, name: existing.name },
  });

  return json({ ok: true, id: existing.id });
}
