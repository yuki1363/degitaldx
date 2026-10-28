// 期限超過アラートの通知化 — 保全計画・業務依頼の期限超過を検知し、
// まだ通知していないものだけ notifications へ1件ずつ作成する。
//
//   呼び出し方: functions/api/notifications/index.js の GET から waitUntil で裏実行する
//   （チャットの10日自動削除・js/chat.js の cleanupOldMessages と同じ「1プロセス1時間に1回・
//    失敗しても本処理を止めない」方式）。通知センターは全ページで開かれるため、
//    アプリを使っていれば1時間以内に反映される。
//
//   冪等性: 同じ対象（related_table + related_id + type）に未確認の通知が既にあれば
//   作り直さない。確認済みになった後、再び期限超過になれば新しい通知を作る
//   （例: 業務依頼を再受付して再び期限を過ぎた場合）。

import { notifyTeam } from './notify.js';
import { deriveOverdue, annualMonthInFy, getAnnualFyState, getBatchPlanIds } from '../plans/index.js';
import { ensureRepairSchema, isOverdueRepair } from '../repairs/index.js';
import { ensureColumns } from './db-compat.js';

let lastCheckAt = 0;
const CHECK_INTERVAL_MS = 3600_000; // 1時間

// 同じ対象・同じ内容の通知を既に出したか（確認済みも含む）。期限（予定日・対応期限・予定月）は本文に
// 入れているので、本文の一致で「同じ期限についての通知」とみなす。未確認かどうかだけで判定すると、
// 誰かが確認した直後の1時間ごとのチェックで、期限超過が続く限り同じ通知とプッシュが出続けていた。
// 期限が変わる（予定日の変更・年間計画の年度が変わる）と本文が変わるので、新しい通知として出る。
async function hasNotificationFor(db, relatedTable, relatedId, type, body) {
  if (await hasUnacknowledgedNotification(db, relatedTable, relatedId, type)) return true;
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM notifications
        WHERE related_table = ?1 AND related_id = ?2 AND type = ?3 AND body = ?4
          AND deleted_at IS NULL
        LIMIT 1`
    )
    .bind(relatedTable, relatedId, type, body)
    .first();
  return !!row;
}

async function hasUnacknowledgedNotification(db, relatedTable, relatedId, type) {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM notifications
        WHERE related_table = ?1 AND related_id = ?2 AND type = ?3
          AND acknowledged_at IS NULL AND deleted_at IS NULL
        LIMIT 1`
    )
    .bind(relatedTable, relatedId, type)
    .first();
  return !!row;
}

async function notifyOverduePlans(env) {
  const db = env.DB;
  const { results } = await db
    .prepare(
      // 繰り返し予定は planned_date が開始日のままで status も常に pending のため、展開せずに判定すると
      // 開始日を基準に「期限超過」が出続ける（カレンダーは展開後に判定している）。通知の対象から外す
      `SELECT id, title, planned_date, planned_end_date, status, unscheduled, annual_only
         FROM maintenance_plan
        WHERE deleted_at IS NULL AND status = 'pending'
          AND (recurrence_rule IS NULL OR recurrence_rule = '')`
    )
    .all();
  // 年間計画は「最後に年度リセットした年度＋1」の年度に当てはめて判定する（plans/index.js の getAnnualFyState）
  const { current: fy } = await getAnnualFyState(db);
  // annual_only 列が入る前に一括登録した年間計画も月単位で判定する（年間計画表の一覧と同じ見分け方。
  // 日単位だと毎月1日の予定が2日に「期限超過」として通知されていた）
  const batchIds = await getBatchPlanIds(db);
  for (const p of results ?? []) {
    const isAnnual = !!p.annual_only || batchIds.has(String(p.id));
    const derived = deriveOverdue(p, { monthly: isAnnual, fy });
    if (derived.status !== 'overdue') continue;
    const limit = (p.planned_end_date || p.planned_date || '').slice(0, 10);
    // 年間計画（毎年共通のテンプレート）は登録年の日付ではなく、今の年度に当てはめた予定月で書く
    // （年度が変わると本文が変わる＝翌年度の超過は新しい通知になる）
    const body = isAnnual
      ? `予定月（${annualMonthInFy(limit, fy)}）を過ぎても未実施です`
      : `予定日（${limit}）を過ぎても未実施です`;
    if (await hasNotificationFor(db, 'maintenance_plan', p.id, 'plan_overdue', body)) continue;
    // waitUntil は渡さない（この関数自体が既に notifications GET の waitUntil 配下で動く
    // ため、ここでのPush送信はそのまま await して完了を待ってよい）
    await notifyTeam(env, null, {
      type: 'plan_overdue',
      level: 'warning',
      title: `期限超過: ${p.title}`,
      body,
      relatedTable: 'maintenance_plan',
      relatedId: p.id,
      linkUrl: `/pages/plan?id=${p.id}`,
      createdBy: 'system:overdue-check',
    });
  }
}

async function notifyOverdueRepairs(env) {
  const db = env.DB;
  await ensureRepairSchema(db); // due_date列が無い旧DBでもクエリが落ちないようにする
  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT id, title, due_date FROM repair_request
        WHERE deleted_at IS NULL AND status != 'done' AND due_date IS NOT NULL AND due_date < ?1`
    )
    .bind(todayJst)
    .all();
  for (const r of results ?? []) {
    if (!isOverdueRepair(r)) continue; // 二重チェック（status='done'に変わっていた場合等）
    const body = `対応期限（${r.due_date}）を過ぎています`;
    if (await hasNotificationFor(db, 'repair_request', r.id, 'repair_overdue', body)) continue;
    await notifyTeam(env, null, {
      type: 'repair_overdue',
      level: 'warning',
      title: `対応期限超過: ${r.title}`,
      body,
      relatedTable: 'repair_request',
      relatedId: r.id,
      linkUrl: `/pages/repair?id=${r.id}`,
      createdBy: 'system:overdue-check',
    });
  }
}

// 工事連絡書の未印刷リマインド — 工事予定（plan_type='construction'）が3日以内に迫っているのに
// まだ帳票（工事連絡書）を印刷（出力）していない計画を検知して通知する。
//   ・対象: 未実施(status='pending')・日付未定でない・printed_at が未設定の工事予定で、
//           予定日（開始日）が「今日〜3日後」の範囲（JST基準）
//   ・重複防止: 同じ計画に未確認の通知か、同じ本文（同じ「あと◯日」）の通知があれば作らない
//              （確認しても1日1回だけ改めて知らせる。印刷すれば printed_at が入り、以降は対象外になる）
async function notifyUnprintedConstruction(env) {
  const db = env.DB;
  // printed_at/printed_by 列が無い旧DBでもクエリが落ちないよう自己修復する
  await ensureColumns(db, 'maintenance_plan_printed', [
    'ALTER TABLE maintenance_plan ADD COLUMN printed_at TEXT',
    'ALTER TABLE maintenance_plan ADD COLUMN printed_by TEXT',
  ]);
  const nowJstMs = Date.now() + 9 * 3600_000;
  const todayJst = new Date(nowJstMs).toISOString().slice(0, 10);
  const limitJst = new Date(nowJstMs + 3 * 86400_000).toISOString().slice(0, 10); // 3日後（両端含む）
  const { results } = await db
    .prepare(
      `SELECT id, title, planned_date
         FROM maintenance_plan
        WHERE deleted_at IS NULL AND status = 'pending'
          AND plan_type = 'construction'
          AND (unscheduled IS NULL OR unscheduled = 0)
          AND printed_at IS NULL
          AND substr(planned_date, 1, 10) >= ?1
          AND substr(planned_date, 1, 10) <= ?2`
    )
    .bind(todayJst, limitJst)
    .all();
  for (const p of results ?? []) {
    const dateStr = (p.planned_date || '').slice(0, 10);
    const days = Math.round(
      (new Date(dateStr + 'T00:00:00Z') - new Date(todayJst + 'T00:00:00Z')) / 86400_000
    );
    const whenText = days <= 0 ? '本日' : `あと${days}日`;
    // 本文に「あと◯日」が入るので、確認しても1日1回（日が変わったとき）だけ改めて知らせる
    const body = `工事予定日（${dateStr}）まで${whenText}です。工事連絡書がまだ印刷されていません`;
    if (await hasNotificationFor(db, 'maintenance_plan', p.id, 'plan_print_reminder', body)) continue;
    await notifyTeam(env, null, {
      type: 'plan_print_reminder',
      level: 'warning',
      title: `工事連絡書 未印刷: ${p.title}`,
      body,
      relatedTable: 'maintenance_plan',
      relatedId: p.id,
      linkUrl: `/pages/plan?id=${p.id}`,
      createdBy: 'system:print-reminder',
    });
  }
}

export async function checkOverdueAndNotify(env) {
  if (Date.now() - lastCheckAt < CHECK_INTERVAL_MS) return;
  lastCheckAt = Date.now();
  try {
    await notifyOverduePlans(env);
  } catch (err) {
    console.error('checkOverdueAndNotify (plans) failed:', err && err.stack ? err.stack : err);
  }
  try {
    await notifyOverdueRepairs(env);
  } catch (err) {
    console.error('checkOverdueAndNotify (repairs) failed:', err && err.stack ? err.stack : err);
  }
  try {
    await notifyUnprintedConstruction(env);
  } catch (err) {
    console.error('checkOverdueAndNotify (unprinted construction) failed:', err && err.stack ? err.stack : err);
  }
}
