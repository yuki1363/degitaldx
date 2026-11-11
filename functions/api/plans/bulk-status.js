// POST /api/plans/bulk-status — 年間計画表で選んだ予定を、まとめて「完了」／「未実施」にする（01 保全計画）
//   body: { ids: [1, 2, 3], status: 'done' | 'pending' }
//   ・editor 以上。繰り返し予定（recurrence_rule あり）・削除済み・すでにその状態の予定は変えない（skipped に数える）
//   ・更新と監査ログ（変更前→後の状態）は1つの batch（1トランザクション）。途中で失敗しても一部だけ残らない
//   ・1件ずつの PUT /api/plans/:id と違い、カレンダー登録元（source_plan_id）への完了の同期はしない
//     （年間計画表のタスクは登録元そのもののため）
import { requireRole } from '../_lib/auth.js';
import { auditStatement } from '../_lib/audit.js';
import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

const MAX_IDS = 100; // D1 の1クエリあたり bind 100 の上限・誤操作の巻き込みを抑える上限
const STATUSES = ['done', 'pending'];

export async function onRequestPost({ request, env, data }) {
  const denied = requireRole(data.user, 'editor');
  if (denied) return denied;

  const db = env.DB;
  const body = await readJson(request);
  const status = body?.status;
  if (!STATUSES.includes(status)) return jsonError(400, `status は ${STATUSES.join('/')} のどちらかです`);
  const raw = Array.isArray(body?.ids) ? body.ids : null;
  if (!raw || raw.length === 0) return jsonError(400, '対象の予定を選んでください');
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return jsonError(400, 'ids は正の整数の配列で指定してください');
  if (ids.length > MAX_IDS) return jsonError(400, `一度に変更できるのは${MAX_IDS}件までです`);

  // 変更前の状態（監査ログ用）。1つの bind（JSON配列）で読む
  const { results: before } = await db.prepare(
    `SELECT id, status FROM maintenance_plan
      WHERE id IN (SELECT value FROM json_each(?1))
        AND deleted_at IS NULL AND recurrence_rule IS NULL`
  ).bind(JSON.stringify(ids)).all();
  const fromOf = new Map((before ?? []).map((r) => [r.id, r.status]));

  const email = data.user.email;
  const now = nowIso();
  const stmts = [];
  for (const id of ids) {
    if (!fromOf.has(id)) continue;
    stmts.push(
      db.prepare(
        `UPDATE maintenance_plan SET status = ?1, updated_by = ?2, updated_at = ?3
          WHERE id = ?4 AND deleted_at IS NULL AND recurrence_rule IS NULL AND status != ?1`
      ).bind(status, email, now, id),
      auditStatement(db, {
        tableName: 'maintenance_plan', recordId: String(id), action: 'update', changedBy: email,
        diff: { status: { from: fromOf.get(id), to: status }, bulk: true },
      }, { ifPrevChanged: true }),
    );
  }
  let updated = 0;
  if (stmts.length > 0) {
    try {
      const results = await db.batch(stmts);
      updated = results.filter((_, i) => i % 2 === 0).reduce((a, r) => a + (r?.meta?.changes ?? 0), 0);
    } catch (err) {
      return jsonError(500, `まとめての更新に失敗しました（何も変更していません）: ${err.message}`);
    }
  }
  return json({ ok: true, status, updated, skipped: ids.length - updated });
}
