import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const PLAN_TYPES = ['inspection', 'parts', 'construction', 'other'];
const STATUSES = ['pending', 'done', 'overdue'];

async function getPlan(db, id) {
  return db.prepare(`
    SELECT
      p.*,
      u.name  AS assignee_name,
      e.name  AS equipment_name,
      e.code  AS equipment_code
    FROM maintenance_plan p
    LEFT JOIN users            u ON p.assignee_id = u.id
    LEFT JOIN equipment_ledger e ON p.equipment_id = e.id
    WHERE p.id = ? AND p.deleted_at IS NULL
  `).bind(id).first();
}

export async function onRequestGet({ params, env }) {
  const db = env.DB;
  const plan = await getPlan(db, params.id);
  if (!plan) return jsonError(404, '保全計画が見つかりません');
  return json({ plan });
}

export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const id = params.id;

  const existing = await getPlan(db, id);
  if (!existing) return jsonError(404, '保全計画が見つかりません');

  const body = await readJson(request);
  const now = nowIso();
  const userEmail = data.user.email;

  const UPDATABLE = ['title', 'planned_date', 'plan_type', 'equipment_id', 'recurrence_rule', 'assignee_id', 'status', 'note'];
  const setClauses = [];
  const binds = [];
  const diff = {};

  for (const field of UPDATABLE) {
    if (!(field in body)) continue;
    let value = body[field];

    if (field === 'plan_type' && !PLAN_TYPES.includes(value)) {
      return jsonError(400, `plan_type は ${PLAN_TYPES.join('/')} のいずれかです`);
    }
    if (field === 'status' && !STATUSES.includes(value)) {
      return jsonError(400, `status は ${STATUSES.join('/')} のいずれかです`);
    }
    if (field === 'title' && (!value || !value.trim())) {
      return jsonError(400, 'title は必須です');
    }

    const oldValue = existing[field];
    const newValue = (field === 'title') ? value.trim() : (value ?? null);
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      diff[field] = { from: oldValue, to: newValue };
    }
    setClauses.push(`${field} = ?`);
    binds.push(newValue);
  }

  if (setClauses.length === 0) return jsonError(400, '更新するフィールドがありません');

  setClauses.push('updated_by = ?', 'updated_at = ?');
  binds.push(userEmail, now, id);

  await db.prepare(`
    UPDATE maintenance_plan SET ${setClauses.join(', ')} WHERE id = ?
  `).bind(...binds).run();

  if (Object.keys(diff).length > 0) {
    await writeAuditLog(db, {
      tableName: 'maintenance_plan',
      recordId: String(id),
      action: 'update',
      changedBy: userEmail,
      diff,
    });
  }

  return json({ ok: true });
}

export async function onRequestDelete({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getPlan(db, id);
  if (!existing) return jsonError(404, '保全計画が見つかりません');

  await db.prepare(`
    UPDATE maintenance_plan SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ?
  `).bind(now, userEmail, now, userEmail, id).run();

  await writeAuditLog(db, {
    tableName: 'maintenance_plan',
    recordId: String(id),
    action: 'delete',
    changedBy: userEmail,
    diff: { deleted_at: now },
  });

  return json({ ok: true });
}
