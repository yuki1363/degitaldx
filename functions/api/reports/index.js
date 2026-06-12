import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const categoryId  = sp.get('category_id');
  const reporterId  = sp.get('reporter_id');
  const from        = sp.get('from');
  const to          = sp.get('to');
  const date        = sp.get('date');

  let sql = `
    SELECT
      dr.*,
      rc.name AS category_name,
      u.name  AS reporter_name
    FROM daily_report dr
    LEFT JOIN report_category rc ON dr.category_id = rc.id
    LEFT JOIN users            u  ON dr.reporter_id = u.id
    WHERE dr.deleted_at IS NULL
  `;
  const binds = [];

  if (date) {
    sql += ` AND dr.report_date = ?`;
    binds.push(date);
  } else {
    if (from) { sql += ` AND dr.report_date >= ?`; binds.push(from); }
    if (to)   { sql += ` AND dr.report_date <= ?`; binds.push(to); }
  }
  if (categoryId) { sql += ` AND dr.category_id = ?`; binds.push(categoryId); }
  if (reporterId) { sql += ` AND dr.reporter_id = ?`; binds.push(reporterId); }

  sql += ` ORDER BY dr.report_date DESC, dr.id DESC`;

  const { results } = await db.prepare(sql).bind(...binds).all();
  return json({ reports: results ?? [] });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { report_date, body: bodyText, category_id, linked_records_json } = body ?? {};

  if (!report_date) return jsonError(400, 'report_date は必須です');
  if (!bodyText?.trim()) return jsonError(400, '本文は必須です');

  const userEmail = data.user.email;
  const userRow = await db.prepare(`SELECT id FROM users WHERE email = ? AND deleted_at IS NULL`).bind(userEmail).first();
  if (!userRow) return jsonError(403, 'ユーザーが見つかりません');

  const now = nowIso();

  const result = await db.prepare(`
    INSERT INTO daily_report
      (reporter_id, report_date, category_id, body, linked_records_json,
       created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userRow.id,
    report_date,
    category_id ?? null,
    bodyText.trim(),
    linked_records_json ? JSON.stringify(linked_records_json) : null,
    userEmail, now, userEmail, now
  ).run();

  const id = result.meta?.last_row_id;
  await writeAuditLog(db, {
    tableName: 'daily_report',
    recordId: id,
    action: 'create',
    changedBy: userEmail,
    diff: { report_date, category_id, body: bodyText.trim() },
  });
  return json({ id }, 201);
}
