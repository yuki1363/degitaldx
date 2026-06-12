import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { writeMasterHistory } from '../../_lib/history.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

async function getCategory(db, cid) {
  return db.prepare(`
    SELECT * FROM trouble_category WHERE id = ? AND deleted_at IS NULL
  `).bind(cid).first();
}

async function snapshotAll(db) {
  const { results } = await db.prepare(`
    SELECT * FROM trouble_category WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC
  `).all();
  return results ?? [];
}

export async function onRequestPut({ request, params, env, data }) {
  requireRole(data.user, 'admin');
  const db = env.DB;
  const cid = params.cid;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getCategory(db, cid);
  if (!existing) return jsonError(404, 'カテゴリが見つかりません');

  const body = await readJson(request);
  const { name, sort_order } = body;

  if ('name' in body && (!name || !name.trim())) {
    return jsonError(400, 'name は必須です');
  }

  const snapshot = await snapshotAll(db);
  await writeMasterHistory(db, {
    masterName: 'trouble_category',
    recordId: String(cid),
    snapshot,
    changedBy: userEmail,
  });

  const setClauses = [];
  const binds = [];
  const diff = {};

  if ('name' in body) {
    const newName = name.trim();
    if (newName !== existing.name) diff.name = { from: existing.name, to: newName };
    setClauses.push('name = ?');
    binds.push(newName);
  }
  if ('sort_order' in body) {
    const newOrder = sort_order ?? 0;
    if (newOrder !== existing.sort_order) diff.sort_order = { from: existing.sort_order, to: newOrder };
    setClauses.push('sort_order = ?');
    binds.push(newOrder);
  }

  if (setClauses.length === 0) return jsonError(400, '更新するフィールドがありません');

  setClauses.push('updated_by = ?', 'updated_at = ?');
  binds.push(userEmail, now, cid);

  await db.prepare(`
    UPDATE trouble_category SET ${setClauses.join(', ')} WHERE id = ?
  `).bind(...binds).run();

  if (Object.keys(diff).length > 0) {
    await writeAuditLog(db, {
      tableName: 'trouble_category',
      recordId: String(cid),
      action: 'update',
      changedBy: userEmail,
      diff,
    });
  }

  return json({ ok: true });
}

export async function onRequestDelete({ params, env, data }) {
  requireRole(data.user, 'admin');
  const db = env.DB;
  const cid = params.cid;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getCategory(db, cid);
  if (!existing) return jsonError(404, 'カテゴリが見つかりません');

  // Check if any active trouble_record references this category
  const inUse = await db.prepare(`
    SELECT id FROM trouble_record WHERE category_id = ? AND deleted_at IS NULL LIMIT 1
  `).bind(cid).first();

  if (inUse) {
    return jsonError(409, 'このカテゴリはトラブル記録で使用中のため削除できません');
  }

  const snapshot = await snapshotAll(db);
  await writeMasterHistory(db, {
    masterName: 'trouble_category',
    recordId: String(cid),
    snapshot,
    changedBy: userEmail,
  });

  await db.prepare(`
    UPDATE trouble_category SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ?
  `).bind(now, userEmail, now, userEmail, cid).run();

  await writeAuditLog(db, {
    tableName: 'trouble_category',
    recordId: String(cid),
    action: 'delete',
    changedBy: userEmail,
    diff: { deleted_at: now },
  });

  return json({ ok: true });
}
