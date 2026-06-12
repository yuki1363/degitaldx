import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { attachFiles } from '../_lib/storage.js';

async function getTrouble(db, id) {
  return db.prepare(`
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
    WHERE t.id = ? AND t.deleted_at IS NULL
  `).bind(id).first();
}

export async function onRequestGet({ params, env }) {
  const db = env.DB;
  const id = params.id;

  const trouble = await getTrouble(db, id);
  if (!trouble) return jsonError(404, 'トラブル記録が見つかりません');

  const [filesResult, historyResult] = await Promise.all([
    db.prepare(`
      SELECT * FROM files
      WHERE related_table = 'trouble_record' AND related_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).bind(id).all(),
    db.prepare(`
      SELECT * FROM audit_log
      WHERE table_name = 'trouble_record' AND record_id = ?
      ORDER BY changed_at ASC
    `).bind(String(id)).all(),
  ]);

  return json({
    trouble,
    files: filesResult.results ?? [],
    history: historyResult.results ?? [],
  });
}

export async function onRequestPut({ request, params, env, data }) {
  requireRole(data.user, 'editor');
  const db = env.DB;
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getTrouble(db, id);
  if (!existing) return jsonError(404, 'トラブル記録が見つかりません');

  const body = await readJson(request);
  const UPDATABLE = ['occurred_at', 'phenomenon', 'equipment_id', 'category_id', 'cause', 'countermeasure', 'custom_fields_json'];

  const setClauses = [];
  const binds = [];
  const diff = {};

  for (const field of UPDATABLE) {
    if (!(field in body)) continue;

    let value = body[field];

    if (field === 'phenomenon' && (!value || !value.trim())) {
      return jsonError(400, 'phenomenon（現象）は必須です');
    }
    if (field === 'occurred_at' && !value) {
      return jsonError(400, 'occurred_at は必須です');
    }

    let storedValue;
    if (field === 'phenomenon') {
      storedValue = value.trim();
    } else if (field === 'custom_fields_json') {
      storedValue = value ? JSON.stringify(value) : null;
    } else {
      storedValue = value ?? null;
    }

    const oldValue = existing[field];
    if (String(oldValue ?? '') !== String(storedValue ?? '')) {
      diff[field] = { from: oldValue, to: storedValue };
    }
    setClauses.push(`${field} = ?`);
    binds.push(storedValue);
  }

  // Handle file attachments
  if (Array.isArray(body.file_ids) && body.file_ids.length > 0) {
    await attachFiles(env, {
      fileIds: body.file_ids,
      relatedTable: 'trouble_record',
      relatedId: id,
      userEmail,
      now,
    });
  }

  if (setClauses.length > 0) {
    setClauses.push('updated_by = ?', 'updated_at = ?');
    binds.push(userEmail, now, id);

    await db.prepare(`
      UPDATE trouble_record SET ${setClauses.join(', ')} WHERE id = ?
    `).bind(...binds).run();
  }

  if (Object.keys(diff).length > 0) {
    await writeAuditLog(db, {
      tableName: 'trouble_record',
      recordId: String(id),
      action: 'update',
      changedBy: userEmail,
      diff,
    });
  }

  return json({ ok: true });
}

export async function onRequestDelete({ params, env, data }) {
  requireRole(data.user, 'editor');
  const db = env.DB;
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getTrouble(db, id);
  if (!existing) return jsonError(404, 'トラブル記録が見つかりません');

  await db.prepare(`
    UPDATE trouble_record SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ?
  `).bind(now, userEmail, now, userEmail, id).run();

  await writeAuditLog(db, {
    tableName: 'trouble_record',
    recordId: String(id),
    action: 'delete',
    changedBy: userEmail,
    diff: { deleted_at: now },
  });

  return json({ ok: true });
}
