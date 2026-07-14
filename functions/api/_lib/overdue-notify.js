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

import { createNotification } from './notify.js';
import { deriveOverdue } from '../plans/index.js';
import { ensureRepairSchema, isOverdueRepair } from '../repairs/index.js';

let lastCheckAt = 0;
const CHECK_INTERVAL_MS = 3600_000; // 1時間

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

async function notifyOverduePlans(db) {
  const { results } = await db
    .prepare(
      `SELECT id, title, planned_date, planned_end_date, status, unscheduled, annual_only
         FROM maintenance_plan WHERE deleted_at IS NULL AND status = 'pending'`
    )
    .all();
  for (const p of results ?? []) {
    const derived = deriveOverdue(p); // annual_only は自動で月単位判定（deriveOverdueの既定動作）
    if (derived.status !== 'overdue') continue;
    if (await hasUnacknowledgedNotification(db, 'maintenance_plan', p.id, 'plan_overdue')) continue;
    const limit = (p.planned_end_date || p.planned_date || '').slice(0, 10);
    await createNotification(db, {
      type: 'plan_overdue',
      level: 'warning',
      title: `期限超過: ${p.title}`,
      body: `予定日（${limit}）を過ぎても未実施です`,
      relatedTable: 'maintenance_plan',
      relatedId: p.id,
      linkUrl: `/pages/plan?id=${p.id}`,
      createdBy: 'system:overdue-check',
    });
  }
}

async function notifyOverdueRepairs(db) {
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
    if (await hasUnacknowledgedNotification(db, 'repair_request', r.id, 'repair_overdue')) continue;
    await createNotification(db, {
      type: 'repair_overdue',
      level: 'warning',
      title: `対応期限超過: ${r.title}`,
      body: `対応期限（${r.due_date}）を過ぎています`,
      relatedTable: 'repair_request',
      relatedId: r.id,
      linkUrl: `/pages/repair?id=${r.id}`,
      createdBy: 'system:overdue-check',
    });
  }
}

export async function checkOverdueAndNotify(env) {
  if (Date.now() - lastCheckAt < CHECK_INTERVAL_MS) return;
  lastCheckAt = Date.now();
  const db = env.DB;
  try {
    await notifyOverduePlans(db);
  } catch (err) {
    console.error('checkOverdueAndNotify (plans) failed:', err && err.stack ? err.stack : err);
  }
  try {
    await notifyOverdueRepairs(db);
  } catch (err) {
    console.error('checkOverdueAndNotify (repairs) failed:', err && err.stack ? err.stack : err);
  }
}
