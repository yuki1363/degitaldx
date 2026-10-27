import { requireRole } from '../../_lib/auth.js';
import { auditStatement } from '../../_lib/audit.js';
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
  utility_report:    { displayCol: 'report_date',  dateCol: 'report_date' },
  electrical_inspection: { displayCol: 'equipment_type', dateCol: 'inspected_date' }, // 12 電気設備点検
  print_templates:   { displayCol: 'name',         dateCol: 'created_at'  },        // 09 帳票テンプレート
};
const PAGE_SIZE = 200;

export async function onRequestGet({ request, env, data }) {
  const denied = requireRole(data.user, 'admin');
  if (denied) return denied;

  const db = env.DB;
  const table = new URL(request.url).searchParams.get('table');
  if (!table || !ALLOWED_TABLES[table]) {
    return json({ tables: Object.keys(ALLOWED_TABLES), records: null });
  }

  // 200件ずつページ送りする（部品CSVの全置き換え等で大量に論理削除したとき、
  // 201件目以降が画面から復元できなかったため）。テーブル名・列名は ALLOWED_TABLES の固定値のみ。
  const offset = Math.max(0, Math.trunc(Number(new URL(request.url).searchParams.get('offset'))) || 0);
  const { displayCol, dateCol } = ALLOWED_TABLES[table];
  const { results } = await db.prepare(
    `SELECT id, ${displayCol} AS display, ${dateCol} AS date_val, deleted_by, deleted_at
     FROM ${table} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(PAGE_SIZE, offset).all();
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NOT NULL`).first();

  return json({
    tables: Object.keys(ALLOWED_TABLES), records: results ?? [], table,
    total: total?.n ?? 0, offset, limit: PAGE_SIZE,
  });
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

  // 復元すると重複になるものは止める（確認と復元は同じ UPDATE の条件で行い、同時操作でもすり抜けない）
  //   ・ユーティリティ日報は「1日1件」。同じ日の記録が既にあれば復元すると2件になる
  //   ・部品は CSV の全置き換えで同じ部品を作り直しているため、旧部品を復元すると同じ型番・部品名が
  //     2件になる（差分マージの型番照合も1件にしか当たらなくなる）
  let dupSql = '';
  let dupBinds = [];
  let dupMessage = '';
  if (table === 'utility_report') {
    dupSql = `AND NOT EXISTS (SELECT 1 FROM utility_report o WHERE o.report_date = ? AND o.deleted_at IS NULL AND o.id != ?)`;
    dupBinds = [existing.report_date, id];
    dupMessage = `${existing.report_date} のユーティリティ日報が既にあるため復元できません（1日1件）。先にそちらを削除してください。`;
  } else if (table === 'parts_inventory' && existing.model_no) {
    dupSql = `AND NOT EXISTS (SELECT 1 FROM parts_inventory o WHERE o.model_no = ? AND o.name IS ? AND o.deleted_at IS NULL AND o.id != ?)`;
    dupBinds = [existing.model_no, existing.name, id];
    dupMessage = `同じ型番・部品名の部品（${existing.model_no} ${existing.name || ''}）が既にあるため復元できません。CSVの全置き換えで作り直された部品の可能性があります。`;
  }

  const now = nowIso();
  const userEmail = data.user.email;

  // 復元と監査ログを1つの batch で（監査は復元できたときだけ。2回押しの2回目は何もしない）
  const results = await db.batch([
    db.prepare(`UPDATE ${table} SET deleted_by=NULL, deleted_at=NULL, updated_by=?, updated_at=? WHERE id=? AND deleted_at IS NOT NULL ${dupSql}`)
      .bind(userEmail, now, id, ...dupBinds),
    auditStatement(db, { tableName: table, recordId: id, action: 'restore', changedBy: userEmail, diff: null }, { ifPrevChanged: true }),
  ]);
  if ((results[0].meta?.changes ?? 0) === 0) {
    return jsonError(409, dupMessage || '既に復元されています。');
  }
  return json({ ok: true });
}
