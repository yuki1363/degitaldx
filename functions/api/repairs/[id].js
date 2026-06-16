import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { attachFiles } from '../_lib/storage.js';

const VALID_STATUSES = ['open', 'in_progress', 'waiting_parts', 'done'];

async function getRepair(db, id) {
  return db
    .prepare(
      `SELECT
         r.*,
         e.name  AS equipment_name,
         e.code  AS equipment_code
       FROM repair_request r
       LEFT JOIN equipment_ledger e ON r.equipment_id = e.id
       WHERE r.id = ?1 AND r.deleted_at IS NULL`
    )
    .bind(id)
    .first();
}

// GET /api/repairs/:id
export async function onRequestGet({ params, env }) {
  const db = env.DB;
  const id = params.id;

  const repair = await getRepair(db, id);
  if (!repair) return jsonError(404, '修理依頼が見つかりません');

  const [filesResult, historyResult] = await Promise.all([
    db
      .prepare(
        `SELECT id, file_name, content_type, size_bytes, created_by, created_at
           FROM files
          WHERE related_table = 'repair_request' AND related_id = ?1 AND deleted_at IS NULL
          ORDER BY created_at ASC`
      )
      .bind(id)
      .all(),
    db
      .prepare(
        `SELECT id, old_status, new_status, comment, changed_by, changed_at
           FROM repair_history
          WHERE request_id = ?1
          ORDER BY changed_at ASC`
      )
      .bind(id)
      .all(),
  ]);

  return json({
    repair,
    files: filesResult.results ?? [],
    history: historyResult.results ?? [],
  });
}

// PUT /api/repairs/:id — editor+
export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getRepair(db, id);
  if (!existing) return jsonError(404, '修理依頼が見つかりません');

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です');

  const UPDATABLE = ['title', 'equipment_id', 'description', 'assignee_name', 'status'];

  const setClauses = [];
  const binds = [];
  const diff = {};

  for (const field of UPDATABLE) {
    if (!(field in body)) continue;

    const value = body[field];

    if (field === 'title' && (!value || !String(value).trim())) {
      return jsonError(400, 'title は必須です');
    }
    if (field === 'status' && !VALID_STATUSES.includes(value)) {
      return jsonError(400, `status は ${VALID_STATUSES.join(' / ')} のいずれかです`);
    }

    const storedValue = field === 'title' ? String(value).trim() : (value ?? null);
    const oldValue = existing[field];

    if (String(oldValue ?? '') !== String(storedValue ?? '')) {
      diff[field] = { from: oldValue, to: storedValue };
    }

    setClauses.push(`${field} = ?`);
    binds.push(storedValue);
  }

  // ステータス変更があればrepair_historyに記録
  if (diff.status) {
    await db
      .prepare(
        `INSERT INTO repair_history (request_id, old_status, new_status, comment, changed_by, changed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(
        id,
        diff.status.from,
        diff.status.to,
        body.comment ?? null,
        userEmail,
        now
      )
      .run();
  }

  // ファイル添付
  if (Array.isArray(body.file_ids) && body.file_ids.length > 0) {
    await attachFiles(env, {
      fileIds: body.file_ids,
      relatedTable: 'repair_request',
      relatedId: id,
      userEmail,
      now,
    });
  }

  if (setClauses.length > 0) {
    setClauses.push('updated_by = ?', 'updated_at = ?');
    binds.push(userEmail, now, id);

    await db
      .prepare(`UPDATE repair_request SET ${setClauses.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
  }

  if (Object.keys(diff).length > 0) {
    await writeAuditLog(db, {
      tableName: 'repair_request',
      recordId: String(id),
      action: 'update',
      changedBy: userEmail,
      diff,
    });
  }

  return json({ ok: true });
}

// DELETE /api/repairs/:id — logical delete, editor+
export async function onRequestDelete({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getRepair(db, id);
  if (!existing) return jsonError(404, '修理依頼が見つかりません');

  await db
    .prepare(
      `UPDATE repair_request
          SET deleted_at = ?1, deleted_by = ?2, updated_at = ?3, updated_by = ?4
        WHERE id = ?5`
    )
    .bind(now, userEmail, now, userEmail, id)
    .run();

  await writeAuditLog(db, {
    tableName: 'repair_request',
    recordId: String(id),
    action: 'delete',
    changedBy: userEmail,
    diff: { deleted_at: now },
  });

  return json({ ok: true });
}
