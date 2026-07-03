import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson, checkEditConflict } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { attachFiles } from '../_lib/storage.js';
import { ensureTroubleColumns } from './index.js';

// trouble_record を UPDATE する。form_values_json 等の列が無い旧DBでは、該当の SET 句を外して再試行する。
async function updateTroubleRecord(db, fieldClauses, fieldBinds, id, userEmail, now) {
  let clauses = [...fieldClauses];
  let binds = [...fieldBinds];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (clauses.length === 0) return null; // 残る更新列が無ければ何もしない
    const sql = `UPDATE trouble_record SET ${[...clauses, 'updated_by = ?', 'updated_at = ?'].join(', ')} WHERE id = ?`;
    try {
      return await db.prepare(sql).bind(...binds, userEmail, now, id).run();
    } catch (err) {
      const m = /(?:has no column named|no such column):?\s*([A-Za-z_]\w*)/i.exec(String(err?.message || ''));
      const ci = m ? clauses.findIndex((c) => c.startsWith(`${m[1]} `)) : -1;
      if (ci === -1) throw err;
      clauses.splice(ci, 1);
      binds.splice(ci, 1);
    }
  }
  throw new Error('トラブル記録の更新に失敗しました（列の不一致）。');
}

async function getTrouble(db, id) {
  return db.prepare(`
    SELECT
      t.*,
      tc.name AS category_name,
      e.name  AS equipment_name,
      e.code  AS equipment_code,
      u.name  AS creator_name
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
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  await ensureTroubleColumns(db); // form_values_json 列を自動で用意（未マイグレーション対応）
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const existing = await getTrouble(db, id);
  if (!existing) return jsonError(404, 'トラブル記録が見つかりません');

  const body = await readJson(request);
  const conflict = checkEditConflict(body, existing);
  if (conflict) return conflict; // 同時編集ガード
  const UPDATABLE = ['occurred_at', 'phenomenon', 'equipment_id', 'category_id', 'cause', 'countermeasure', 'custom_fields_json', 'form_values_json', 'reporter_name'];

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
    } else if (field === 'custom_fields_json' || field === 'form_values_json') {
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
    // form_values_json 等の列が無い旧DBでは、該当列を外して再試行する
    await updateTroubleRecord(db, setClauses, binds, id, userEmail, now);
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
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
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
