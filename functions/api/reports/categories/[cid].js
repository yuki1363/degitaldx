import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.cid);
  if (!id) return jsonError(400, '不正なIDです');

  const row = await db.prepare(`SELECT * FROM report_category WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!row) return jsonError(404, 'カテゴリが見つかりません');

  const body = await readJson(request);
  const { name, sort_order } = body ?? {};
  if (!name?.trim()) return jsonError(400, 'name は必須です');

  const now = nowIso();
  const userEmail = data.user.email;

  await writeMasterHistory(db, { masterName: 'report_category', recordId: id, snapshot: row, changedBy: userEmail });
  await db.prepare(`UPDATE report_category SET name=?, sort_order=?, updated_by=?, updated_at=? WHERE id=?`)
    .bind(name.trim(), sort_order ?? row.sort_order, userEmail, now, id).run();
  await writeAuditLog(db, { tableName: 'report_category', recordId: id, action: 'update', changedBy: userEmail, diff: { before: { name: row.name, sort_order: row.sort_order }, after: { name: name.trim(), sort_order } } });
  return json({ ok: true });
}

export async function onRequestDelete({ env, data, params }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.cid);
  if (!id) return jsonError(400, '不正なIDです');

  const row = await db.prepare(`SELECT * FROM report_category WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!row) return jsonError(404, 'カテゴリが見つかりません');

  const inUse = await db.prepare(`SELECT 1 FROM daily_report WHERE category_id = ? AND deleted_at IS NULL LIMIT 1`).bind(id).first();
  if (inUse) return jsonError(409, 'このカテゴリを使用している日報があるため削除できません');

  const now = nowIso();
  const userEmail = data.user.email;

  await writeMasterHistory(db, { masterName: 'report_category', recordId: id, snapshot: row, changedBy: userEmail });
  await db.prepare(`UPDATE report_category SET deleted_by=?, deleted_at=? WHERE id=?`).bind(userEmail, now, id).run();
  await writeAuditLog(db, { tableName: 'report_category', recordId: id, action: 'delete', changedBy: userEmail, diff: null });
  return json({ ok: true });
}
