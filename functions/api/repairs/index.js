import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureColumns } from '../_lib/db-compat.js';
import { beginIdempotent, dedupeStatement, isDedupeConflict, resolveRaceDuplicate, DEDUPE_CONFLICT_MESSAGE } from '../_lib/request-dedupe.js';

const VALID_STATUSES = ['open', 'in_progress', 'waiting_parts', 'done'];
const SOURCE_TABLES = ['trouble_record', 'inspection_result'];
const PRIORITY_VALUES = ['高', '中', '低'];

// 優先度を 高/中/低 のいずれかに正規化（部品在庫05の重要度と同じ値セット。未指定/不正値は既定の '中'）
export function normPriority(v) {
  const s = (v ?? '').toString().trim();
  return PRIORITY_VALUES.includes(s) ? s : '中';
}

// 対応期限（YYYY-MM-DD）の検証。空・未指定は null、形式不正は { error }
export function parseDueDate(v) {
  if (v === undefined || v === null || v === '') return { value: null };
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: '対応期限（due_date）は YYYY-MM-DD 形式で指定してください' };
  return { value: s };
}

// 期限超過か（表示専用の派生値。status 列は書き換えない）
export function isOverdueRepair(r) {
  if (!r || !r.due_date || r.status === 'done') return false;
  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return r.due_date.slice(0, 10) < todayJst;
}

// priority/due_date 列が無い旧DBでも保存が壊れないよう自己修復する（POST/PUT入口で呼ぶ）
export async function ensureRepairSchema(db) {
  await ensureColumns(db, 'repair_request_priority_due', [
    'ALTER TABLE repair_request ADD COLUMN priority TEXT',
    'ALTER TABLE repair_request ADD COLUMN due_date TEXT',
  ]);
}

// GET /api/repairs
// Query: status, equipment_id, source_table+source_id（起票元による逆引き）
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp = new URL(request.url).searchParams;
  const status = sp.get('status');
  const equipmentId = sp.get('equipment_id');
  const sourceTable = sp.get('source_table');
  const sourceId = sp.get('source_id');
  // 件数の上限（既定500・最大3000）。一覧画面は期間指定が無く毎回全件を読みに行くため、
  // D1の読み取り枠を無制限に消費しないようにする（equipment/index.js と同じ truncated 方式）
  const limit = Math.min(Math.max(1, Math.trunc(Number(sp.get('limit'))) || 500), 3000);

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

  sql += ` ORDER BY r.created_at DESC LIMIT ?`;
  binds.push(limit + 1);

  const { results } = await db.prepare(sql).bind(...binds).all();
  const rows = results ?? [];
  const truncated = rows.length > limit;
  const repairs = (truncated ? rows.slice(0, limit) : rows).map((r) => ({ ...r, is_overdue: isOverdueRepair(r) }));
  return json({ repairs, truncated, limit });
}

// POST /api/repairs — editor+
export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  await ensureRepairSchema(db); // priority/due_date 列を自動で用意（未マイグレーションでも保存できるように）
  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です');

  const { title, equipment_id, description, assignee_name, status = 'open', source_table, source_id, priority } = body;

  if (!title || !title.trim()) return jsonError(400, 'title は必須です');
  if (!VALID_STATUSES.includes(status)) {
    return jsonError(400, `status は ${VALID_STATUSES.join(' / ')} のいずれかです`);
  }
  const dueDate = parseDueDate(body.due_date);
  if (dueDate.error) return jsonError(400, dueDate.error);

  // 起票元（トラブル/点検）。許可テーブル以外は無視する。
  const srcTable = SOURCE_TABLES.includes(source_table) ? source_table : null;
  const srcId = srcTable && Number.isInteger(Number(source_id)) ? Number(source_id) : null;

  // 同じ識別番号（client_request_id）が登録済みなら、二重に作らず最初の依頼を返す
  const idem = await beginIdempotent(db, body, 'repair_request');
  if (idem.error) return jsonError(400, idem.error);
  if (idem.dup?.conflict) return jsonError(409, DEDUPE_CONFLICT_MESSAGE);
  if (idem.dup) return json({ id: idem.dup.record_id, duplicate: true });

  const now = nowIso();
  const userEmail = data.user.email;
  const priorityValue = normPriority(priority);

  const insertStmt = db
    .prepare(
      `INSERT INTO repair_request
         (title, equipment_id, description, assignee_name, status, source_table, source_id,
          priority, due_date, created_by, created_at, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
    .bind(
      title.trim(),
      equipment_id ?? null,
      description ?? null,
      assignee_name?.trim() || null,
      status,
      srcTable,
      srcId,
      priorityValue,
      dueDate.value,
      userEmail,
      now,
      userEmail,
      now
    );
  let id;
  if (idem.key) {
    // 依頼と識別番号は同じ batch（同時に2回届いたら片方は丸ごと取り消される）
    try {
      const results = await db.batch([insertStmt, dedupeStatement(db, idem.key, 'repair_request', userEmail, now)]);
      id = results[0].meta?.last_row_id;
    } catch (err) {
      const existingId = isDedupeConflict(err) ? await resolveRaceDuplicate(db, idem.key, 'repair_request') : null;
      if (!existingId) throw err;
      return json({ id: existingId, duplicate: true });
    }
  } else {
    id = (await insertStmt.run()).meta?.last_row_id;
  }

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
    diff: { title: title.trim(), equipment_id, description, assignee_name: assignee_name?.trim() || null, status, priority: priorityValue, due_date: dueDate.value, source_table: srcTable, source_id: srcId },
  });

  return json({ id }, 201);
}
