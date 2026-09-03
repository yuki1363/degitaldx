// 13 ユーティリティ日報 — 一覧・登録
//   GET  /api/utility-reports?from=&to=&date=&limit=&with_values=1
//        → { reports: [...] }（with_values=1 のときは values 配列付き＝CSV出力用）
//   POST /api/utility-reports（editor以上）
//        body: { report_date, inspected_at, reporter_name, note, values }
//        同じ日の未削除レコードがあれば 409 + existing_id（1日1件ガード）

import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';
import { ensureUtilitySchema } from './_schema.js';
import { listItems, buildValues, toReport } from './_values.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestGet({ request, env, data }) {
  if (!data.user) return jsonError(401, '認証が必要です');
  const db = env.DB;
  await ensureUtilitySchema(db);

  const sp = new URL(request.url).searchParams;
  const from = sp.get('from');
  const to = sp.get('to');
  const date = sp.get('date');
  const withValues = sp.get('with_values') === '1';
  const limit = Math.min(Number(sp.get('limit')) || 200, 500);

  let sql = `SELECT id, report_date, inspected_at, reporter_name, has_abnormal, note,
                    values_json, created_by, created_at, updated_by, updated_at
               FROM utility_report
              WHERE deleted_at IS NULL`;
  const binds = [];
  if (date) {
    sql += ` AND report_date = ?`;
    binds.push(date);
  } else {
    if (from) { sql += ` AND report_date >= ?`; binds.push(from); }
    if (to) { sql += ` AND report_date <= ?`; binds.push(to); }
  }
  sql += ` ORDER BY report_date DESC, id DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await db.prepare(sql).bind(...binds).all();
  return json({ reports: (results ?? []).map((r) => toReport(r, { withValues })) });
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;
  const db = env.DB;
  await ensureUtilitySchema(db);

  const body = await readJson(request);
  if (!body) return jsonError(400, 'リクエストボディが不正です。');

  const reportDate = String(body.report_date || '').trim();
  if (!DATE_RE.test(reportDate)) return jsonError(400, 'report_date は YYYY-MM-DD 形式で指定してください。');

  // 1日1件ガード: 同じ日の未削除レコードがあれば編集へ誘導する
  const dup = await db.prepare(
    `SELECT id FROM utility_report WHERE report_date = ? AND deleted_at IS NULL`
  ).bind(reportDate).first();
  // 既存IDは error.detail に入れる（フロントの ApiError.detail から編集画面へ誘導する）
  if (dup) {
    return jsonError(409,
      `${reportDate} の日報はすでに登録されています。既存の記録を編集してください。`,
      { existing_id: dup.id });
  }

  const inspectedAt = body.inspected_at ? String(body.inspected_at) : nowIso();
  const reporterName = body.reporter_name ? String(body.reporter_name).trim().slice(0, 100) : null;
  const note = body.note ? String(body.note).trim().slice(0, 2000) : null;

  const items = await listItems(db);
  const built = buildValues(items, body.values);
  if (built.error) return built.error;

  const now = nowIso();
  const email = data.user.email;
  const res = await db.prepare(
    `INSERT INTO utility_report
       (report_date, inspected_at, reporter_name, has_abnormal, values_json, note,
        created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    reportDate, inspectedAt, reporterName, built.hasAbnormal,
    JSON.stringify(built.values), note, email, now, email, now
  ).run();

  const id = res.meta?.last_row_id;
  await writeAuditLog(db, {
    tableName: 'utility_report', recordId: id, action: 'create', changedBy: email,
    diff: { report_date: reportDate, has_abnormal: built.hasAbnormal, note },
  });
  return json({ id, has_abnormal: built.hasAbnormal }, 201);
}
