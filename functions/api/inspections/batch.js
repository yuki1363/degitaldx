// /api/inspections/batch — 点検まとめ入力（複数設備を一括登録）
//   POST : 複数設備の点検記録を一度に登録（editor 以上）
//          Body: { inspected_at, assignee_name, entries: [{ equipment_id, items, file_ids }] }
//          実施日時・担当者は全設備で共通。設備ごとに inspection_result を1件作成する。
//   検証は通常登録（index.js の validateInspectionInput）を流用。
//   全件を先に検証し、1件でもエラーがあれば何も保存しない（部分保存を避ける）。

import { json, jsonError, readJson } from '../_lib/http.js';
import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { notifyTeam } from '../_lib/notify.js';
import { nowIso } from '../_lib/util.js';
import { attachFiles } from '../_lib/storage.js';
import { validateInspectionInput } from './index.js';

export async function onRequestPost({ request, env, data, waitUntil }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const body = await readJson(request);
  if (!body || !Array.isArray(body.entries) || body.entries.length === 0) {
    return jsonError(400, '点検する設備を1つ以上選択してください。');
  }
  if (body.entries.length > 100) {
    return jsonError(400, '一度に登録できる設備は100件までです。');
  }

  const inspectedAt = body.inspected_at;
  const assigneeName = body.assignee_name ?? null;

  // 1) 全エントリを先に検証（1件でもエラーなら保存しない）
  const validated = [];
  const seenEquip = new Set();
  for (let i = 0; i < body.entries.length; i++) {
    const entry = body.entries[i] || {};
    if (seenEquip.has(Number(entry.equipment_id))) {
      return jsonError(400, `${i + 1}件目: 同じ設備が重複しています。`);
    }
    seenEquip.add(Number(entry.equipment_id));

    const parsed = await validateInspectionInput(env, {
      equipment_id: entry.equipment_id,
      assignee_name: assigneeName,
      inspected_at: inspectedAt,
      items: entry.items,
      note: entry.note,
    });
    if (parsed.error) {
      return jsonError(400, `${i + 1}件目の設備: ${parsed.error}`);
    }
    validated.push({ v: parsed.value, fileIds: entry.file_ids });
  }

  // 2) まとめて保存（各設備 = inspection_result 1件 + audit_log）
  const now = nowIso();
  const saved = [];
  for (const { v, fileIds } of validated) {
    const result = await env.DB.prepare(
      `INSERT INTO inspection_result
         (equipment_id, assignee_id, assignee_name, inspected_at, items_json, has_abnormal, note, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
      .bind(
        v.equipment_id, data.user.id, v.assignee_name, v.inspected_at,
        JSON.stringify(v.items), v.has_abnormal, v.note, data.user.email, now
      )
      .run();

    const id = result.meta.last_row_id;

    const attached = await attachFiles(env, {
      fileIds,
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
        assignee_name: v.assignee_name,
        inspected_at: v.inspected_at,
        item_count: v.items.length,
        has_abnormal: v.has_abnormal === 1,
        attached_files: attached,
        batch: true,
      },
    });

    if (v.has_abnormal === 1) {
      const eq = await env.DB.prepare(`SELECT code, name FROM equipment_ledger WHERE id = ?1`)
        .bind(v.equipment_id)
        .first();
      const eqName = eq ? `${eq.code} ${eq.name}` : `設備#${v.equipment_id}`;
      await notifyTeam(env, waitUntil, {
        type: 'inspection_abnormal',
        level: 'warning',
        title: `点検で異常検知: ${eqName}`,
        body: '点検記録に異常値（基準範囲外）または NG が含まれています。内容を確認してください。',
        relatedTable: 'inspection_result',
        relatedId: id,
        linkUrl: `/pages/inspection?id=${id}`,
        createdBy: data.user.email,
      });
    }

    saved.push({ id, equipment_id: v.equipment_id, has_abnormal: v.has_abnormal === 1 });
  }

  return json({ saved, count: saved.length }, 201);
}
