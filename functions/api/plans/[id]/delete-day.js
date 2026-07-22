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
import { writeAuditLog } from '../../_lib/audit.js';
import { json, jsonError, readJson } from '../../_lib/http.js';
import { nowIso } from '../../_lib/util.js';
import { insertMaintenancePlan, addDays, buildCloneColumns } from '../index.js';

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

  // 単日予定は「1日だけ削除」＝全体削除と同じ（従来の削除と揃える）
  if (start === end) {
    await db.prepare(
      `UPDATE maintenance_plan SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ?`
    ).bind(now, userEmail, now, userEmail, id).run();
    await writeAuditLog(db, {
      tableName: 'maintenance_plan', recordId: String(id), action: 'delete',
      changedBy: userEmail, diff: { deleted_at: now, deleted_day: date, mode: 'single_day' },
    });
    return json({ ok: true, mode: 'deleted' });
  }

  // 先頭日を削除 → 開始日を1日進める
  if (date === start) {
    const newStart = addDays(date, 1);
    await db.prepare(
      `UPDATE maintenance_plan SET planned_date = ?, updated_by = ?, updated_at = ? WHERE id = ?`
    ).bind(newStart, userEmail, now, id).run();
    await writeAuditLog(db, {
      tableName: 'maintenance_plan', recordId: String(id), action: 'update',
      changedBy: userEmail,
      diff: { planned_date: { from: start, to: newStart }, deleted_day: date, mode: 'shrink_head' },
    });
    return json({ ok: true, mode: 'shrunk' });
  }

  // 末尾日を削除 → 終了日を1日戻す（開始日と同じになれば単日扱い＝NULLに戻す）
  if (date === end) {
    const newEnd = addDays(date, -1);
    const newEndVal = newEnd === start ? null : newEnd;
    await db.prepare(
      `UPDATE maintenance_plan SET planned_end_date = ?, updated_by = ?, updated_at = ? WHERE id = ?`
    ).bind(newEndVal, userEmail, now, id).run();
    await writeAuditLog(db, {
      tableName: 'maintenance_plan', recordId: String(id), action: 'update',
      changedBy: userEmail,
      diff: { planned_end_date: { from: end, to: newEndVal }, deleted_day: date, mode: 'shrink_tail' },
    });
    return json({ ok: true, mode: 'shrunk' });
  }

  // 期間の途中の日を削除 → その日の前後で2レコードに分割する
  const headEnd = addDays(date, -1);
  const headEndVal = headEnd === start ? null : headEnd;
  const tailStart = addDays(date, 1);
  const tailEndVal = tailStart === end ? null : end;

  await db.prepare(
    `UPDATE maintenance_plan SET planned_end_date = ?, updated_by = ?, updated_at = ? WHERE id = ?`
  ).bind(headEndVal, userEmail, now, id).run();

  const { cols, vals } = buildCloneColumns(plan, userEmail, now, tailStart, tailEndVal);
  const result = await insertMaintenancePlan(db, cols, vals);
  const newId = result.meta?.last_row_id;

  await writeAuditLog(db, {
    tableName: 'maintenance_plan', recordId: String(id), action: 'update',
    changedBy: userEmail,
    diff: { planned_end_date: { from: end, to: headEndVal }, deleted_day: date, mode: 'split', split_into: newId },
  });
  await writeAuditLog(db, {
    tableName: 'maintenance_plan', recordId: String(newId), action: 'create',
    changedBy: userEmail,
    diff: { planned_date: tailStart, planned_end_date: tailEndVal, split_from: Number(id), deleted_day: date, mode: 'split' },
  });

  return json({ ok: true, mode: 'split', new_id: newId });
}
