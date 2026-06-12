// /api/inspections — 点検実施記録（02）一覧・登録
//   GET  : 一覧（?equipment_id= / ?from= / ?to= で絞り込み）
//   POST : 登録（editor 以上）
//          項目値はマスタと突合して検証し、異常値判定（上下限範囲外 / NG）は
//          サーバー側でも必ず行う（フロントの警告はUX目的）

import { json, jsonError, readJson } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { nowIso } from '../_lib/util.js';
import { attachFiles } from '../_lib/storage.js';

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/;

/**
 * 送信された項目値をマスタと突合して検証し、スナップショット（items_json の中身）を作る。
 * 戻り値: { error } または { items, hasAbnormal }
 */
export function buildItemsSnapshot(masters, submitted) {
  if (!Array.isArray(submitted) || submitted.length === 0) {
    return { error: '点検項目が1件もありません。' };
  }
  const masterMap = new Map(masters.map((m) => [m.id, m]));
  const seen = new Set();
  const items = [];
  let hasAbnormal = false;

  for (const raw of submitted) {
    const masterId = Number(raw && raw.master_id);
    const master = masterMap.get(masterId);
    if (!master) return { error: `点検項目（id=${raw && raw.master_id}）がマスタに存在しません。` };
    if (seen.has(masterId)) return { error: `点検項目「${master.name}」が重複しています。` };
    seen.add(masterId);

    let value = raw.value;
    let abnormal = false;

    switch (master.input_type) {
      case 'ok_ng': {
        value = String(value);
        if (value !== 'ok' && value !== 'ng') {
          return { error: `「${master.name}」は OK / NG を選択してください。` };
        }
        abnormal = value === 'ng';
        break;
      }
      case 'number': {
        value = Number(value);
        if (!Number.isFinite(value)) {
          return { error: `「${master.name}」は数値を入力してください。` };
        }
        const underMin = master.min_value !== null && value < master.min_value;
        const overMax = master.max_value !== null && value > master.max_value;
        abnormal = underMin || overMax;
        break;
      }
      case 'select': {
        value = String(value);
        const options = master.options_json ? JSON.parse(master.options_json) : [];
        if (!options.includes(value)) {
          return { error: `「${master.name}」の選択値が不正です。` };
        }
        break;
      }
      case 'text': {
        value = String(value === undefined || value === null ? '' : value).trim().slice(0, 500);
        break;
      }
      default:
        return { error: `「${master.name}」の入力種別が不明です。` };
    }

    if (abnormal) hasAbnormal = true;
    // 実施時点のマスタ内容ごと保存する（後からマスタを変えても記録は当時のまま）
    items.push({
      master_id: master.id,
      name: master.name,
      input_type: master.input_type,
      unit: master.unit,
      min_value: master.min_value,
      max_value: master.max_value,
      value,
      abnormal,
    });
  }

  return { items, hasAbnormal };
}

/** 登録・編集共通の入力検証（equipment / assignee / inspected_at / items） */
export async function validateInspectionInput(env, body) {
  if (!body) return { error: 'リクエストボディが不正です。' };

  const equipmentId = Number(body.equipment_id);
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) {
    return { error: 'equipment_id を指定してください。' };
  }
  const equipment = await env.DB.prepare(
    'SELECT id, name FROM equipment_ledger WHERE id = ?1 AND deleted_at IS NULL'
  )
    .bind(equipmentId)
    .first();
  if (!equipment) return { error: '対象の設備が見つかりません。' };

  const assigneeId = Number(body.assignee_id);
  if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
    return { error: '担当者（assignee_id）を指定してください。' };
  }
  const assignee = await env.DB.prepare(
    'SELECT id FROM users WHERE id = ?1 AND deleted_at IS NULL'
  )
    .bind(assigneeId)
    .first();
  if (!assignee) return { error: '担当者が見つかりません。' };

  const inspectedAt = String(body.inspected_at || '');
  if (!ISO_DATETIME.test(inspectedAt)) {
    return { error: '実施日時（inspected_at）は ISO 8601（UTC）で指定してください。' };
  }

  const { results: masters } = await env.DB.prepare(
    `SELECT id, name, input_type, unit, min_value, max_value, options_json
       FROM inspection_master
      WHERE equipment_id = ?1 AND deleted_at IS NULL`
  )
    .bind(equipmentId)
    .all();
  if (masters.length === 0) {
    return { error: 'この設備には点検項目が登録されていません。先に点検項目を追加してください。' };
  }

  const snapshot = buildItemsSnapshot(masters, body.items);
  if (snapshot.error) return { error: snapshot.error };

  return {
    value: {
      equipment_id: equipmentId,
      assignee_id: assigneeId,
      inspected_at: inspectedAt,
      note: body.note ? String(body.note).trim().slice(0, 1000) : null,
      items: snapshot.items,
      has_abnormal: snapshot.hasAbnormal ? 1 : 0,
    },
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const conditions = ['r.deleted_at IS NULL'];
  const binds = [];

  const equipmentId = Number(url.searchParams.get('equipment_id'));
  if (Number.isInteger(equipmentId) && equipmentId > 0) {
    binds.push(equipmentId);
    conditions.push(`r.equipment_id = ?${binds.length}`);
  }
  const from = url.searchParams.get('from');
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    binds.push(`${from}T00:00:00Z`);
    conditions.push(`r.inspected_at >= ?${binds.length}`);
  }
  const to = url.searchParams.get('to');
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    binds.push(`${to}T23:59:59Z`);
    conditions.push(`r.inspected_at <= ?${binds.length}`);
  }

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.equipment_id, e.code AS equipment_code, e.name AS equipment_name,
            r.assignee_id, u.name AS assignee_name,
            r.inspected_at, r.has_abnormal, r.note
       FROM inspection_result r
       JOIN equipment_ledger e ON e.id = r.equipment_id
       JOIN users u ON u.id = r.assignee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.inspected_at DESC, r.id DESC
      LIMIT 200`
  )
    .bind(...binds)
    .all();

  return json({ inspections: results });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const body = await readJson(request);
  const parsed = await validateInspectionInput(env, body);
  if (parsed.error) return jsonError(400, parsed.error);
  const v = parsed.value;

  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO inspection_result
       (equipment_id, assignee_id, inspected_at, items_json, has_abnormal, note, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(
      v.equipment_id, v.assignee_id, v.inspected_at,
      JSON.stringify(v.items), v.has_abnormal, v.note, data.user.email, now
    )
    .run();

  const id = result.meta.last_row_id;

  // 先にアップロード済みの写真・動画をこの記録に紐づける
  const attached = await attachFiles(env, {
    fileIds: body.file_ids,
    relatedTable: 'inspection_result',
    relatedId: id,
    userEmail: data.user.email,
    now,
  });

  await writeAuditLog(env.DB, {
    tableName: 'inspection_result',
    recordId: id,
    action: 'create',
    changedBy: data.user.email,
    diff: {
      equipment_id: v.equipment_id,
      assignee_id: v.assignee_id,
      inspected_at: v.inspected_at,
      item_count: v.items.length,
      has_abnormal: v.has_abnormal === 1,
      attached_files: attached,
    },
  });

  return json({ id, has_abnormal: v.has_abnormal === 1 }, 201);
}
