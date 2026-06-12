import { requireRole } from '../../_lib/auth.js';
import { writeAuditLog } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';

const ALLOWED_TABLES = {
  trouble_record:    { displayCol: 'phenomenon',  dateCol: 'occurred_at' },
  repair_request:    { displayCol: 'title',        dateCol: 'created_at'  },
  parts_inventory:   { displayCol: 'name',         dateCol: 'created_at'  },
  inspection_result: { displayCol: 'inspected_at', dateCol: 'inspected_at'},
  daily_report:      { displayCol: 'body',         dateCol: 'report_date' },
  maintenance_plan:  { displayCol: 'title',        dateCol: 'planned_date'},
  equipment_ledger:  { displayCol: 'name',         dateCol: 'created_at'  },
};

export async function onRequestGet({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const table = new URL(request.url).searchParams.get('table');
  if (!table || !ALLOWED_TABLES[table]) {
    return json({ tables: Object.keys(ALLOWED_TABLES), records: null });
  }

  const { displayCol, dateCol } = ALLOWED_TABLES[table];
  const { results } = await db.prepare(
    `SELECT id, ${displayCol} AS display, ${dateCol} AS date_val, deleted_by, deleted_at
     FROM ${table} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`
  ).all();

  return json({ tables: Object.keys(ALLOWED_TABLES), records: results ?? [], table });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const { table, id } = body ?? {};
  if (!table || !ALLOWED_TABLES[table]) return jsonError(400, '対象テーブルが不正です');
  if (!id) return jsonError(400, 'id は必須です');

  const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`).bind(id).first();
  if (!existing) return jsonError(404, '削除済みレコードが見つかりません');

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(`UPDATE ${table} SET deleted_by=NULL, deleted_at=NULL, updated_by=?, updated_at=? WHERE id=?`)
    .bind(userEmail, now, id).run();

  await writeAuditLog(db, { tableName: table, recordId: id, action: 'restore', changedBy: userEmail, diff: null });
  return json({ ok: true });
}
