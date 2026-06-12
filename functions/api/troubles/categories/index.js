import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

export async function onRequestGet({ env }) {
  const db = env.DB;
  const { results } = await db.prepare(`
    SELECT * FROM trouble_category
    WHERE deleted_at IS NULL
    ORDER BY sort_order ASC, id ASC
  `).all();
  return json({ categories: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  requireRole(data.user, 'admin');
  const db = env.DB;
  const body = await readJson(request);

  const { name, sort_order } = body;
  if (!name || !name.trim()) return jsonError(400, 'name は必須です');

  const now = nowIso();
  const userEmail = data.user.email;

  // Snapshot of current categories before change
  const { results: snapshot } = await db.prepare(`
    SELECT * FROM trouble_category WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC
  `).all();

  await writeMasterHistory(db, {
    masterName: 'trouble_category',
    recordId: null,
    snapshot,
    changedBy: userEmail,
  });

  const result = await db.prepare(`
    INSERT INTO trouble_category (name, sort_order, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    name.trim(),
    sort_order ?? 0,
    userEmail,
    now,
    userEmail,
    now
  ).run();

  const id = result.meta?.last_row_id;

  await writeAuditLog(db, {
    tableName: 'trouble_category',
    recordId: String(id),
    action: 'create',
    changedBy: userEmail,
    diff: { name: name.trim(), sort_order: sort_order ?? 0 },
  });

  return json({ id }, 201);
}
