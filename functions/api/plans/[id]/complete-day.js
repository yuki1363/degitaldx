// POST /api/plans/:id/complete-day — 期間予定を「1日だけ」完了にする（editor以上）
//   body: { date: 'YYYY-MM-DD' }
//
//   複数日にまたがる予定（planned_date〜planned_end_date）は1レコードで保持しているため、
//   通常の完了操作（PUT /api/plans/:id { status:'done' }）は期間全体を完了にしてしまう。
//   現場では「その日の分だけ」完了にしたいことがあるため、delete-day と同じ分割方式で対応する:
//     - 単日予定（期間なし）        … 従来どおり全体を完了にする
//     - 期間の先頭/末尾/途中の日を指定 … その日だけを「完了済みの単日レコード」として切り出し、
//         残りの期間は未完了のまま存続させる（先頭/末尾なら開始日・終了日を詰め、
//         途中の日なら前後で2レコードに分割する）
//   期間全体をまとめて完了にしたい場合は従来どおり PUT /api/plans/:id { status:'done' } を使う。

import { requireRole } from '../../_lib/auth.js';
import { auditStatement, LAST_INSERT_ID } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { insertMaintenancePlanStatement, runPlanBatch, claimPlanForSplit, addDays, buildCloneColumns } from '../index.js';

export async function onRequestPost({ request, params, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const id = params.id;
  const userEmail = data.user.email;
  const now = nowIso();

  const plan = await db.prepare(
    `SELECT * FROM maintenance_plan WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first();
  if (!plan) return jsonError(404, '保全計画が見つかりません');
  if (plan.status === 'done') return jsonError(400, 'この予定はすでに完了しています');

  const body = await readJson(request);
  const date = String(body?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonError(400, 'date は YYYY-MM-DD 形式で指定してください');
  }

  const start = plan.planned_date.slice(0, 10);
  const end = (plan.planned_end_date || plan.planned_date).slice(0, 10);
  if (date < start || date > end) {
    return jsonError(400, '指定日はこの予定の期間内にありません');
  }

  // 同じ予定への同時操作を防ぐ（2回押しで完了済みの単日レコードが2件できる等）。確保できなければ 409
  if (!(await claimPlanForSplit(db, plan, userEmail, now))) {
    return jsonError(409, 'この予定は他の操作で更新されました。画面を更新してからやり直してください。');
  }
  // 以降の書き込みは1トランザクション（D1 batch）で行い、途中で失敗しても中途半端な状態を残さない
  const upd = (sql, ...binds) => db.prepare(sql).bind(...binds);
  const audit = (recordId, action, diff) => auditStatement(db, { tableName: 'maintenance_plan', recordId, action, changedBy: userEmail, diff });

  // 単日予定は「1日だけ完了」＝全体完了と同じ（従来の完了操作と揃える）
  if (start === end) {
    await db.batch([
      upd(`UPDATE maintenance_plan SET status = 'done', updated_by = ?, updated_at = ? WHERE id = ?`, userEmail, now, id),
      audit(String(id), 'update', { status: { from: plan.status, to: 'done' }, done_day: date, mode: 'single_day' }),
    ]);
    return json({ ok: true, mode: 'done' });
  }

  // その日だけを「完了済みの単日レコード」として切り出す（残りは未完了のまま存続）
  const doneCols = buildCloneColumns(plan, userEmail, now, date, null, 'done');
  const doneStatements = (dropCols) => [
    insertMaintenancePlanStatement(db, doneCols.cols, doneCols.vals, dropCols),
    audit(LAST_INSERT_ID, 'create', { planned_date: date, planned_end_date: null, status: 'done', split_from: Number(id), mode: 'split' }),
  ];

  if (date === start) {
    // 先頭日を完了 → 残り（既存レコード）は開始日を1日進めて未完了のまま継続
    const newStart = addDays(date, 1);
    const newEndVal = newStart === end ? null : end;
    const results = await runPlanBatch(db, (dropCols) => [
      ...doneStatements(dropCols),
      upd(`UPDATE maintenance_plan SET planned_date = ?, planned_end_date = ?, updated_by = ?, updated_at = ? WHERE id = ?`, newStart, newEndVal, userEmail, now, id),
      audit(String(id), 'update', { planned_date: { from: start, to: newStart }, done_day: date, mode: 'split_head' }),
    ]);
    return json({ ok: true, mode: 'split', done_id: results[0].meta?.last_row_id, tail_id: null });
  }

  if (date === end) {
    // 末尾日を完了 → 残り（既存レコード）は終了日を1日戻して未完了のまま継続
    const newEnd = addDays(date, -1);
    const newEndVal = newEnd === start ? null : newEnd;
    const results = await runPlanBatch(db, (dropCols) => [
      ...doneStatements(dropCols),
      upd(`UPDATE maintenance_plan SET planned_end_date = ?, updated_by = ?, updated_at = ? WHERE id = ?`, newEndVal, userEmail, now, id),
      audit(String(id), 'update', { planned_end_date: { from: end, to: newEndVal }, done_day: date, mode: 'split_tail' }),
    ]);
    return json({ ok: true, mode: 'split', done_id: results[0].meta?.last_row_id, tail_id: null });
  }

  // 期間途中の日を完了 → 前後は未完了のまま2レコードに分割する
  const headEnd = addDays(date, -1);
  const headEndVal = headEnd === start ? null : headEnd;
  const tailStart = addDays(date, 1);
  const tailEndVal = tailStart === end ? null : end;
  const tailCols = buildCloneColumns(plan, userEmail, now, tailStart, tailEndVal);

  const results = await runPlanBatch(db, (dropCols) => [
    ...doneStatements(dropCols),
    insertMaintenancePlanStatement(db, tailCols.cols, tailCols.vals, dropCols),
    audit(LAST_INSERT_ID, 'create', { planned_date: tailStart, planned_end_date: tailEndVal, split_from: Number(id), done_day: date, mode: 'split_middle' }),
    upd(`UPDATE maintenance_plan SET planned_end_date = ?, updated_by = ?, updated_at = ? WHERE id = ?`, headEndVal, userEmail, now, id),
    audit(String(id), 'update', { planned_end_date: { from: end, to: headEndVal }, done_day: date, mode: 'split_middle' }),
  ]);
  return json({ ok: true, mode: 'split', done_id: results[0].meta?.last_row_id, tail_id: results[2].meta?.last_row_id });
}
