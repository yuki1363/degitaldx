import { requireRole } from '../_lib/auth.js';
import { writeAuditLog } from '../_lib/audit.js';
import { json, jsonError, readJson, checkEditConflict } from '../_lib/http.js';
import { nowIso, isValidYmd } from '../_lib/util.js';

export async function onRequestGet({ params, env }) {
  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const report = await db.prepare(`
    SELECT dr.*, rc.name AS category_name, COALESCE(dr.reporter_name, u.name) AS reporter_name
    FROM daily_report dr
    LEFT JOIN report_category rc ON dr.category_id = rc.id
    LEFT JOIN users            u  ON dr.reporter_id = u.id
    WHERE dr.id = ? AND dr.deleted_at IS NULL
  `).bind(id).first();
  if (!report) return jsonError(404, '日報が見つかりません');

  const { results: files } = await db.prepare(
    `SELECT * FROM files WHERE related_table = 'daily_report' AND related_id = ? AND deleted_at IS NULL ORDER BY created_at`
  ).bind(id).all();

  // 変更履歴（他機能の詳細画面と同じ表示方式。共通監査設計）
  const { results: history } = await db.prepare(
    `SELECT action, changed_by, changed_at, diff_json
       FROM audit_log
      WHERE table_name = 'daily_report' AND record_id = ?1
      ORDER BY changed_at DESC, id DESC
      LIMIT 20`
  ).bind(id).all();

  return json({ report, files: files ?? [], history: history ?? [] });
}

export async function onRequestPut({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await db.prepare(`SELECT * FROM daily_report WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!existing) return jsonError(404, '日報が見つかりません');

  // 日報は「記録して確認するだけ」の共有記録のため、入力可（editor）なら誰でも
  // 編集・削除できる（作成者/管理者の区別なし。変更は audit_log で追跡）。

  const body = await readJson(request);
  const conflict = checkEditConflict(body, existing);
  if (conflict) return conflict; // 同時編集ガード
  const { report_date, body: bodyText, category_id, reporter_name } = body ?? {};
  if (!report_date) return jsonError(400, 'report_date は必須です');
  if (!isValidYmd(report_date)) return jsonError(400, 'report_date は YYYY-MM-DD の実在する日付で指定してください');
  const bodyValue = bodyText ? String(bodyText).trim() : '';
  const reporterName = reporter_name ? String(reporter_name).trim().slice(0, 100) : null;

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(`
    UPDATE daily_report
    SET report_date=?, category_id=?, body=?, reporter_name=?, updated_by=?, updated_at=?
    WHERE id=?
  `).bind(
    report_date,
    category_id ?? null,
    bodyValue,
    reporterName,
    userEmail, now, id
  ).run();

  // 変更した項目だけを「前→後」で記録する（詳細画面の変更履歴に何が変わったかを出すため。以前は新しい値だけを全項目書いていた）
  const diff = {};
  const sameStr = (a, b) => String(a ?? '') === String(b ?? '');
  if (!sameStr(existing.report_date, report_date)) diff.report_date = { from: existing.report_date, to: report_date };
  if (!sameStr(existing.category_id, category_id)) diff.category_id = { from: existing.category_id, to: category_id ?? null };
  if (!sameStr(existing.body, bodyValue)) diff.body = { from: existing.body, to: bodyValue };
  if (!sameStr(existing.reporter_name, reporterName)) diff.reporter_name = { from: existing.reporter_name, to: reporterName };
  await writeAuditLog(db, { tableName: 'daily_report', recordId: id, action: 'update', changedBy: userEmail, diff });
  return json({ ok: true });
}

export async function onRequestDelete({ params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = Number(params.id);
  if (!id) return jsonError(400, '不正なIDです');

  const existing = await db.prepare(`SELECT * FROM daily_report WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!existing) return jsonError(404, '日報が見つかりません');

  // 編集と同様、入力可（editor）なら誰でも削除できる（論理削除・audit_log 記録）。

  const now = nowIso();
  const userEmail = data.user.email;

  await db.prepare(`UPDATE daily_report SET deleted_by=?, deleted_at=? WHERE id=?`).bind(userEmail, now, id).run();
  await writeAuditLog(db, { tableName: 'daily_report', recordId: id, action: 'delete', changedBy: userEmail, diff: null });
  return json({ ok: true });
}
