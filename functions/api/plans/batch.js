// POST /api/plans/batch — 年間計画表からの一括登録（01 保全計画）
//   body: { items: [{ title, planned_date, plan_type, line_name, equipment_name,
//                      assignee_name, note, status }] }
//   選択した月ぶんの予定をまとめて作成する。1件でも不正なら何も登録しない（事前検証）。
//   登録は1トランザクション（D1 batch）で行い、途中で失敗しても一部だけ残らない。

import { requireRole } from '../_lib/auth.js';
import { auditStatement, LAST_INSERT_ID } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { insertMaintenancePlanStatement, runPlanBatch } from './index.js';

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

  // 各予定の列と値・監査用の内容を先に組み立てる
  const rows = items.map((it) => {
    const resolvedStatus = STATUSES.includes(it.status) ? it.status : 'pending';
    // 列名は固定の許可リストのみ（ユーザー入力を連結しない）。
    // unscheduled は「未定」登録のときだけ列に含める（未マイグレーション環境でも
    // 通常の月指定登録は動くようにするため）。
    const cols = ['title', 'planned_date', 'planned_end_date', 'plan_type', 'line_name',
      'equipment_name', 'assignee_name', 'status', 'note', 'recurrence_rule'];
    const vals = [
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
    ];
    if (it.unscheduled) { cols.push('unscheduled'); vals.push(1); }
    // annual_only=1 で年間計画表専用予定として登録（カレンダーには表示しない）
    if (it.annual_only) { cols.push('annual_only'); vals.push(1); }
    const inspector = it.inspector_name ? String(it.inspector_name).trim() : '';
    if (inspector) { cols.push('inspector_name'); vals.push(inspector); }
    cols.push('created_by', 'created_at', 'updated_by', 'updated_at');
    vals.push(userEmail, now, userEmail, now);
    const diff = {
      title: it.title, planned_date: it.planned_date, plan_type: it.plan_type,
      line_name: it.line_name, equipment_name: it.equipment_name,
      assignee_name: it.assignee_name, note: it.note, status: resolvedStatus, batch: true,
    };
    return { cols, vals, diff };
  });

  // 全件を1トランザクション（D1 batch）で登録する。途中で失敗すれば1件も残らないので、
  // 押し直し・オフライン送信キューの再送で一部だけ重複登録されることがない。
  // 各予定の直後に監査ログ（直前の INSERT の ID＝LAST_INSERT_ID）を入れる。
  const results = await runPlanBatch(db, (dropCols) => rows.flatMap((r) => [
    insertMaintenancePlanStatement(db, r.cols, r.vals, dropCols),
    auditStatement(db, { tableName: 'maintenance_plan', recordId: LAST_INSERT_ID, action: 'create', changedBy: userEmail, diff: r.diff }),
  ]));
  const ids = rows.map((_, i) => results[i * 2].meta?.last_row_id);

  return json({ created: ids.length, ids }, 201);
}
