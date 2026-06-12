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
  const equipmentId = sp.get('equipment_id');

  let sql = `
    SELECT
      p.*,
      u.name  AS assignee_name,
      e.name  AS equipment_name,
      e.code  AS equipment_code
    FROM maintenance_plan p
    LEFT JOIN users           u ON p.assignee_id = u.id
    LEFT JOIN equipment_ledger e ON p.equipment_id = e.id
    WHERE p.deleted_at IS NULL
  `;
  const binds = [];

  if (month) {
    sql += ` AND p.planned_date >= ? AND p.planned_date < ?`;
    const [y, m] = month.split('-').map(Number);
    const start = `${month}-01`;
    const endDate = new Date(y, m, 1); // first day of next month
    const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`;
    binds.push(start, end);
  }

  if (equipmentId) {
    sql += ` AND p.equipment_id = ?`;
    binds.push(equipmentId);
  }

  sql += ` ORDER BY p.planned_date ASC, p.id ASC`;

  const stmt = db.prepare(sql);
  const { results } = await stmt.bind(...binds).all();

  return json({ plans: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  requireRole(data.user, 'editor');
  const db = env.DB;
  const body = await readJson(request);

  const { title, planned_date, plan_type, equipment_id, recurrence_rule, assignee_id, status, note } = body;

  if (!title || !title.trim()) return jsonError(400, 'title は必須です');
  if (!planned_date) return jsonError(400, 'planned_date は必須です');
  if (!PLAN_TYPES.includes(plan_type)) return jsonError(400, `plan_type は ${PLAN_TYPES.join('/')} のいずれかです`);

  const resolvedStatus = STATUSES.includes(status) ? status : 'pending';
  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(`
    INSERT INTO maintenance_plan
      (title, planned_date, plan_type, equipment_id, recurrence_rule, assignee_id, status, note,
       created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    title.trim(),
    planned_date,
    plan_type,
    equipment_id ?? null,
    recurrence_rule ?? null,
    assignee_id ?? null,
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
    diff: { title, planned_date, plan_type, equipment_id, recurrence_rule, assignee_id, status: resolvedStatus, note },
  });

  return json({ id }, 201);
}
