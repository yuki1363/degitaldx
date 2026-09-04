// 13 ユーティリティ日報 — 詳細・編集・削除
//   GET    /api/utility-reports/:id  → { report, history }
//   PUT    /api/utility-reports/:id  （editor以上・expected_updated_at で同時編集ガード）
//   DELETE /api/utility-reports/:id  （editor以上・論理削除）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson, checkEditConflict } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureUtilitySchema } from './_schema.js';
import { listItems, buildValues, toReport } from './_values.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function findReport(db, id) {
  return db.prepare(
    `SELECT * FROM utility_report WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first();
}

export async function onRequestGet({ params, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  await ensureUtilitySchema(db);

  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const row = await findReport(db, id);
  if (!row) return jsonError(404, 'ユーティリティ日報が見つかりません');

  const { results: history } = await db.prepare(
    `SELECT action, changed_by, changed_at, diff_json
       FROM audit_log
      WHERE table_name = 'utility_report' AND record_id = ?
      ORDER BY changed_at DESC, id DESC
      LIMIT 20`
  ).bind(id).all();

  return json({ report: toReport(row), history: history ?? [] });
}

export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  await ensureUtilitySchema(db);

  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await findReport(db, id);
  if (!existing) return jsonError(404, 'ユーティリティ日報が見つかりません');

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');
  const conflict = checkEditConflict(body, existing); // 同時編集ガード
  if (conflict) return conflict;

  const reportDate = String(body.report_date || '').trim();
  if (!DATE_RE.test(reportDate)) return jsonError(400, 'report_date は YYYY-MM-DD 形式で指定してください。');

  // 日付を他の日へ変更する場合も1日1件を守る（自分自身は除外）
  const dup = await db.prepare(
    `SELECT id FROM utility_report WHERE report_date = ? AND id <> ? AND deleted_at IS NULL`
  ).bind(reportDate, id).first();
  if (dup) {
    return jsonError(409, `${reportDate} の日報はすでに登録されています。`, { existing_id: dup.id });
  }

  const items = await listItems(db);
  const built = buildValues(items, body.values);
  if (built.error) return built.error;

  const inspectedAt = body.inspected_at ? String(body.inspected_at) : existing.inspected_at;
  const reporterName = body.reporter_name ? String(body.reporter_name).trim().slice(0, 100) : null;
  const note = body.note ? String(body.note).trim().slice(0, 2000) : null;
  const now = nowIso();
  const email = data.user.email;

  await db.prepare(
    `UPDATE utility_report
        SET report_date = ?, inspected_at = ?, reporter_name = ?, has_abnormal = ?,
            values_json = ?, note = ?, updated_by = ?, updated_at = ?
      WHERE id = ?`
  ).bind(
    reportDate, inspectedAt, reporterName, built.hasAbnormal,
    JSON.stringify(built.values), note, email, now, id
  ).run();

  await writeAuditLog(db, {
    tableName: 'utility_report', recordId: id, action: 'update', changedBy: email,
    diff: { report_date: reportDate, has_abnormal: built.hasAbnormal, note },
  });
  return json({ ok: true, has_abnormal: built.hasAbnormal });
}

export async function onRequestDelete({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  await ensureUtilitySchema(db);

  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await findReport(db, id);
  if (!existing) return jsonError(404, 'ユーティリティ日報が見つかりません');

  const now = nowIso();
  const email = data.user.email;
  await db.prepare(
    `UPDATE utility_report SET deleted_by = ?, deleted_at = ? WHERE id = ?`
  ).bind(email, now, id).run();

  await writeAuditLog(db, {
    tableName: 'utility_report', recordId: id, action: 'delete', changedBy: email, diff: null,
  });
  return json({ ok: true });
}
