import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const VALID_STATUSES = ['open', 'in_progress', 'waiting_parts', 'done'];
const SOURCE_TABLES = ['trouble_record', 'inspection_result'];

// GET /api/repairs
// Query: status, equipment_id, source_table+source_id（起票元による逆引き）
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const status = sp.get('status');
  const equipmentId = sp.get('equipment_id');
  const sourceTable = sp.get('source_table');
  const sourceId = sp.get('source_id');

  // 担当者は自由入力の assignee_name 列を使う（r.* に含まれる）。users JOIN は廃止。
  let sql = `
    SELECT
      r.*,
      e.name  AS equipment_name,
      e.code  AS equipment_code
    FROM repair_request r
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
  if (sourceTable && sourceId) {
    sql += ` AND r.source_table = ? AND r.source_id = ?`;
    binds.push(sourceTable, Number(sourceId));
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

  const { title, equipment_id, description, assignee_name, status = 'open', source_table, source_id } = body;

  if (!title || !title.trim()) return jsonError(400, 'title は必須です');
  if (!VALID_STATUSES.includes(status)) {
    return jsonError(400, `status は ${VALID_STATUSES.join(' / ')} のいずれかです`);
  }

  // 起票元（トラブル/点検）。許可テーブル以外は無視する。
  const srcTable = SOURCE_TABLES.includes(source_table) ? source_table : null;
  const srcId = srcTable && Number.isInteger(Number(source_id)) ? Number(source_id) : null;

  const now = nowIso();
  const userEmail = data.user.email;

  const result = await db
    .prepare(
      `INSERT INTO repair_request
         (title, equipment_id, description, assignee_name, status, source_table, source_id,
          created_by, created_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    )
    .bind(
      title.trim(),
      equipment_id ?? null,
      description ?? null,
      assignee_name?.trim() || null,
      status,
      srcTable,
      srcId,
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
    diff: { title: title.trim(), equipment_id, description, assignee_name: assignee_name?.trim() || null, status, source_table: srcTable, source_id: srcId },
  });

  return json({ id }, 201);
}
