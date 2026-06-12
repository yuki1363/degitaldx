import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const VALID_STATUSES = ['open', 'in_progress', 'waiting_parts', 'done'];

// GET /api/repairs
// Query: status, equipment_id
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const status = sp.get('status');
  const equipmentId = sp.get('equipment_id');

  let sql = `
    SELECT
      r.*,
      u.name  AS assignee_name,
      e.name  AS equipment_name,
      e.code  AS equipment_code
    FROM repair_request r
    LEFT JOIN users           u ON r.assignee_id  = u.id
    LEFT JOIN equipment_ledger e ON r.equipment_id = e.id
    WHERE r.deleted_at IS NULL
  `;
  const binds = [];

  if (status) {
    sql += ` AND r.status = ?`;
    binds.push(status);
  }
  if (equipmentId) {
    sql += ` AND r.equipment_id = ?`;
    binds.push(equipmentId);
  }

  sql += ` ORDER BY r.created_at DESC`;

  const { results } = await db.prepare(sql).bind(...binds).all();
  return json({ repairs: results ?? [] });
}

// POST /api/repairs — editor+
export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です');

  const { title, equipment_id, description, assignee_id, status = 'open' } = body;

  if (!title || !title.trim()) return jsonError(400, 'title は必須です');
  if (!VALID_STATUSES.includes(status)) {
    return jsonError(400, `status は ${VALID_STATUSES.join(' / ')} のいずれかです`);
  }

  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db
    .prepare(
      `INSERT INTO repair_request
         (title, equipment_id, description, assignee_id, status,
          created_by, created_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      title.trim(),
      equipment_id ?? null,
      description ?? null,
      assignee_id ?? null,
      status,
      userEmail,
      now,
      userEmail,
      now
    )
    .run();

  const id = result.meta?.last_row_id;

  // ステータス変更履歴を記録（初期ステータス）
  await db
    .prepare(
      `INSERT INTO repair_history (request_id, old_status, new_status, changed_by, changed_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(id, null, status, userEmail, now)
    .run();

  await writeAuditLog(db, {
    tableName: 'repair_request',
    recordId: String(id),
    action: 'create',
    changedBy: userEmail,
    diff: { title: title.trim(), equipment_id, description, assignee_id, status },
  });

  return json({ id }, 201);
}
