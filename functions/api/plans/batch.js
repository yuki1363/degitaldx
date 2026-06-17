// POST /api/plans/batch — 年間計画表からの一括登録（01 保全計画）
//   body: { items: [{ title, planned_date, plan_type, line_name, equipment_name,
//                      assignee_name, note, status }] }
//   選択した月ぶんの予定をまとめて作成する。1件でも不正なら何も登録しない（事前検証）。

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const PLAN_TYPES = ['inspection', 'parts', 'construction', 'other'];
const STATUSES = ['pending', 'done', 'overdue'];
const MAX_ITEMS = 120; // 設備×12ヶ月を複数行ぶん想定した上限

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return jsonError(400, '登録する予定がありません');
  if (items.length > MAX_ITEMS) return jsonError(400, `一度に登録できるのは${MAX_ITEMS}件までです`);

  // 事前検証（1件でも不正なら登録しない）
  for (const it of items) {
    if (!it.title || !String(it.title).trim()) return jsonError(400, 'タイトルは必須です');
    if (!it.planned_date || !/^\d{4}-\d{2}-\d{2}$/.test(it.planned_date)) {
      return jsonError(400, 'planned_date（YYYY-MM-DD）が不正です');
    }
    if (!PLAN_TYPES.includes(it.plan_type)) {
      return jsonError(400, `plan_type は ${PLAN_TYPES.join('/')} のいずれかです`);
    }
  }

  const now = nowIso();
  const userEmail = data.user.email;
  const ids = [];

  for (const it of items) {
    const resolvedStatus = STATUSES.includes(it.status) ? it.status : 'pending';
    const result = await db.prepare(`
      INSERT INTO maintenance_plan
        (title, planned_date, planned_end_date, plan_type, line_name, equipment_name,
         assignee_name, status, note, recurrence_rule,
         created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(it.title).trim(),
      it.planned_date,
      null,
      it.plan_type,
      it.line_name?.trim() || null,
      it.equipment_name?.trim() || null,
      it.assignee_name?.trim() || null,
      resolvedStatus,
      it.note?.trim() || null,
      null, // 一括登録は各月の個別予定として作成する（繰り返しルールは付けない）
      userEmail, now, userEmail, now
    ).run();

    const id = result.meta?.last_row_id;
    ids.push(id);

    await writeAuditLog(db, {
      tableName: 'maintenance_plan',
      recordId: String(id),
      action: 'create',
      changedBy: userEmail,
      diff: {
        title: it.title, planned_date: it.planned_date, plan_type: it.plan_type,
        line_name: it.line_name, equipment_name: it.equipment_name,
        assignee_name: it.assignee_name, note: it.note, status: resolvedStatus, batch: true,
      },
    });
  }

  return json({ created: ids.length, ids }, 201);
}
