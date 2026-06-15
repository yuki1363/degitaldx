import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const PLAN_TYPES = ['inspection', 'parts', 'construction', 'other'];
const STATUSES = ['pending', 'done', 'overdue'];

export async function onRequestGet({ request, env, data }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const month = sp.get('month');       // YYYY-MM

  // 設備名・担当者名は予定そのものに保存（自由入力）。旧FK用のJOINは廃止。
  let sql = `
    SELECT p.*
    FROM maintenance_plan p
    WHERE p.deleted_at IS NULL
  `;
  const binds = [];

  if (month) {
    // 期間が当月と重なる予定を取得（開始 < 翌月初日 かつ 終了 >= 当月初日）
    const [y, m] = month.split('-').map(Number);
    const start = `${month}-01`;
    const endDate = new Date(y, m, 1); // first day of next month
    const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`;
    sql += ` AND p.planned_date < ? AND COALESCE(p.planned_end_date, p.planned_date) >= ?`;
    binds.push(end, start);
  }

  sql += ` ORDER BY p.planned_date ASC, p.id ASC`;

  const stmt = db.prepare(sql);
  const { results } = await stmt.bind(...binds).all();

  return json({ plans: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const body = await readJson(request);

  const { title, planned_date, planned_end_date, plan_type, equipment_name, assignee_name, status, note } = body;

  if (!title || !title.trim()) return jsonError(400, 'title は必須です');
  if (!planned_date) return jsonError(400, 'planned_date は必須です');
  if (!PLAN_TYPES.includes(plan_type)) return jsonError(400, `plan_type は ${PLAN_TYPES.join('/')} のいずれかです`);
  if (planned_end_date && planned_end_date < planned_date) {
    return jsonError(400, '終了日は開始日以降にしてください');
  }

  const resolvedStatus = STATUSES.includes(status) ? status : 'pending';
  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(`
    INSERT INTO maintenance_plan
      (title, planned_date, planned_end_date, plan_type, equipment_name, assignee_name, status, note,
       created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    title.trim(),
    planned_date,
    planned_end_date ?? null,
    plan_type,
    equipment_name?.trim() || null,
    assignee_name?.trim() || null,
    resolvedStatus,
    note ?? null,
    userEmail,
    now,
    userEmail,
    now
  ).run();

  const id = result.meta?.last_row_id;

  await writeAuditLog(db, {
    tableName: 'maintenance_plan',
    recordId: String(id),
    action: 'create',
    changedBy: userEmail,
    diff: { title, planned_date, planned_end_date, plan_type, equipment_name, assignee_name, status: resolvedStatus, note },
  });

  return json({ id }, 201);
}
