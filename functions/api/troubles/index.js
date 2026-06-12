import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { attachFiles } from '../_lib/storage.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const categoryId = sp.get('category_id');
  const equipmentId = sp.get('equipment_id');
  const from = sp.get('from');   // YYYY-MM-DD
  const to = sp.get('to');       // YYYY-MM-DD

  let sql = `
    SELECT
      t.*,
      tc.name AS category_name,
      e.name  AS equipment_name,
      e.code  AS equipment_code,
      u.name  AS reporter_name
    FROM trouble_record t
    LEFT JOIN trouble_category  tc ON t.category_id  = tc.id
    LEFT JOIN equipment_ledger   e ON t.equipment_id  = e.id
    LEFT JOIN users              u ON t.created_by    = u.email
    WHERE t.deleted_at IS NULL
  `;
  const binds = [];

  if (categoryId) {
    sql += ` AND t.category_id = ?`;
    binds.push(categoryId);
  }
  if (equipmentId) {
    sql += ` AND t.equipment_id = ?`;
    binds.push(equipmentId);
  }
  if (from) {
    sql += ` AND t.occurred_at >= ?`;
    binds.push(from);
  }
  if (to) {
    // to is inclusive: compare against start of next day
    sql += ` AND t.occurred_at < ?`;
    const toDate = new Date(to);
    toDate.setDate(toDate.getDate() + 1);
    binds.push(toDate.toISOString().slice(0, 10));
  }

  sql += ` ORDER BY t.occurred_at DESC, t.id DESC`;

  const { results } = await db.prepare(sql).bind(...binds).all();
  return json({ troubles: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  requireRole(data.user, 'editor');
  const db = env.DB;
  const body = await readJson(request);

  const { occurred_at, phenomenon, equipment_id, category_id, cause, countermeasure, custom_fields_json, file_ids } = body;

  if (!occurred_at) return jsonError(400, 'occurred_at は必須です');
  if (!phenomenon || !phenomenon.trim()) return jsonError(400, 'phenomenon（現象）は必須です');

  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db.prepare(`
    INSERT INTO trouble_record
      (occurred_at, phenomenon, equipment_id, category_id, cause, countermeasure, custom_fields_json,
       created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    occurred_at,
    phenomenon.trim(),
    equipment_id ?? null,
    category_id ?? null,
    cause ?? null,
    countermeasure ?? null,
    custom_fields_json ? JSON.stringify(custom_fields_json) : null,
    userEmail,
    now,
    userEmail,
    now
  ).run();

  const id = result.meta?.last_row_id;

  if (Array.isArray(file_ids) && file_ids.length > 0) {
    await attachFiles(env, {
      fileIds: file_ids,
      relatedTable: 'trouble_record',
      relatedId: id,
      userEmail,
      now,
    });
  }

  await writeAuditLog(db, {
    tableName: 'trouble_record',
    recordId: String(id),
    action: 'create',
    changedBy: userEmail,
    diff: { occurred_at, phenomenon: phenomenon.trim(), equipment_id, category_id, cause, countermeasure },
  });

  return json({ id }, 201);
}
