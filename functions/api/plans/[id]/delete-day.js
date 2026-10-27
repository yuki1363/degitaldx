// POST /api/plans/:id/delete-day — 期間予定を「1日だけ」削除する（editor以上）
//   body: { date: 'YYYY-MM-DD' }
//
//   複数日にまたがる予定（planned_date〜planned_end_date）は1レコードで保持しているため、
//   通常の削除（DELETE /api/plans/:id）は期間全体を消してしまう。現場では「その日だけ」を
//   取り消したいことがあるため、指定日だけを期間から取り除く:
//     - 単日予定（期間なし）        … 従来どおり全体を論理削除
//     - 期間の先頭/末尾の日を指定   … 開始日／終了日をその分だけ詰める（1レコードのまま）
//     - 期間の途中の日を指定       … その日の前後で2レコードに分割する
//         前半＝既存レコードの終了日を詰める／後半＝同内容の新規レコードを作成
//   全期間をまとめて消したい場合は従来どおり DELETE /api/plans/:id を使う。

import { requireRole } from '../../_lib/auth.js';
import { auditStatement, LAST_INSERT_ID } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { insertMaintenancePlanStatement, runPlanBatch, guardedPlanUpdate, addDays, buildCloneColumns } from '../index.js';

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

  // 書き込みは1トランザクション（D1 batch）で行い、途中で失敗しても「期間を詰めたのに後半の予定が無い
  // （日程が消える）」状態を残さない。先頭の文は「読んだ時点の日程・状態のまま」のときだけ元の予定を
  // 書き換え（guardedPlanUpdate）、後続は直前の文が1行を変えたときだけ実行する（then）。同じ予定への
  // 同時操作（2回押し等）は後の側が先頭で0件になり、何も変えずに 409 になる。
  const guard = (setSql, ...binds) => guardedPlanUpdate(db, plan, setSql, binds);
  const then = { ifPrevChanged: true };
  const audit = (recordId, action, diff) => auditStatement(db, { tableName: 'maintenance_plan', recordId, action, changedBy: userEmail, diff }, then);
  const conflicted = (results) => (results[0].meta?.changes ?? 0) === 0;

  // 単日予定は「1日だけ削除」＝全体削除と同じ（従来の削除と揃える）
  if (start === end) {
    const results = await db.batch([
      guard('deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ?', now, userEmail, now, userEmail),
      audit(String(id), 'delete', { deleted_at: now, deleted_day: date, mode: 'single_day' }),
    ]);
    if (conflicted(results)) return jsonError(409, 'この予定は他の操作で更新されました。画面を更新してからやり直してください。');
    return json({ ok: true, mode: 'deleted' });
  }

  // 先頭日を削除 → 開始日を1日進める
  if (date === start) {
    const newStart = addDays(date, 1);
    const results = await db.batch([
      guard('planned_date = ?, updated_by = ?, updated_at = ?', newStart, userEmail, now),
      audit(String(id), 'update', { planned_date: { from: start, to: newStart }, deleted_day: date, mode: 'shrink_head' }),
    ]);
    if (conflicted(results)) return jsonError(409, 'この予定は他の操作で更新されました。画面を更新してからやり直してください。');
    return json({ ok: true, mode: 'shrunk' });
  }

  // 末尾日を削除 → 終了日を1日戻す（開始日と同じになれば単日扱い＝NULLに戻す）
  if (date === end) {
    const newEnd = addDays(date, -1);
    const newEndVal = newEnd === start ? null : newEnd;
    const results = await db.batch([
      guard('planned_end_date = ?, updated_by = ?, updated_at = ?', newEndVal, userEmail, now),
      audit(String(id), 'update', { planned_end_date: { from: end, to: newEndVal }, deleted_day: date, mode: 'shrink_tail' }),
    ]);
    if (conflicted(results)) return jsonError(409, 'この予定は他の操作で更新されました。画面を更新してからやり直してください。');
    return json({ ok: true, mode: 'shrunk' });
  }

  // 期間の途中の日を削除 → その日の前後で2レコードに分割する
  const headEnd = addDays(date, -1);
  const headEndVal = headEnd === start ? null : headEnd;
  const tailStart = addDays(date, 1);
  const tailEndVal = tailStart === end ? null : end;

  const { cols, vals } = buildCloneColumns(plan, userEmail, now, tailStart, tailEndVal);
  const results = await runPlanBatch(db, (dropCols) => [
    guard('planned_end_date = ?, updated_by = ?, updated_at = ?', headEndVal, userEmail, now),
    audit(String(id), 'update', { planned_end_date: { from: end, to: headEndVal }, deleted_day: date, mode: 'split' }),
    insertMaintenancePlanStatement(db, cols, vals, dropCols, then),
    audit(LAST_INSERT_ID, 'create', { planned_date: tailStart, planned_end_date: tailEndVal, split_from: Number(id), deleted_day: date, mode: 'split' }),
  ]);
  if (conflicted(results)) return jsonError(409, 'この予定は他の操作で更新されました。画面を更新してからやり直してください。');
  return json({ ok: true, mode: 'split', new_id: results[2].meta?.last_row_id });
}
