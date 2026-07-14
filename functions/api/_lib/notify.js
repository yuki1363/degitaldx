// 通知の生成 — 部品在庫0・点検の異常値/NG・トラブル登録などの発生時に呼ぶ。
//   通知はチーム共有（確認は notifications.acknowledged_by/at で管理）。
//   通知作成はあくまで本処理の副作用なので、失敗しても本処理（点検保存等）は
//   止めない。エラーはログに残して握りつぶす（戻り値で成否を返す）。

import { nowIso } from './util.js';
import { sendWebPush } from './webpush.js';

/**
 * 通知を1件作成する。
 * @param {D1Database} db env.DB
 * @param {object} n
 * @param {string} n.type           parts_zero / inspection_abnormal / trouble
 * @param {'info'|'warning'|'alert'} [n.level]
 * @param {string} n.title          一覧に出す見出し（必須）
 * @param {string} [n.body]         補足説明
 * @param {string} [n.relatedTable] 関連レコードのテーブル名
 * @param {number} [n.relatedId]    関連レコードID
 * @param {string} [n.linkUrl]      クリック時の遷移先（例 /pages/parts?id=3）
 * @param {string} [n.createdBy]    発生のきっかけになった操作者
 * @returns {Promise<boolean>} 作成できたら true
 */
export async function createNotification(db, {
  type,
  level = 'info',
  title,
  body = null,
  relatedTable = null,
  relatedId = null,
  linkUrl = null,
  createdBy = 'system',
} = {}) {
  if (!type || !title) return false;
  try {
    await db
      .prepare(
        `INSERT INTO notifications
           (type, level, title, body, related_table, related_id, link_url, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(type, level, title, body, relatedTable, relatedId, linkUrl, createdBy, nowIso())
      .run();
    return true;
  } catch (err) {
    // 通知作成の失敗で本処理を巻き込まない
    console.error('createNotification failed:', err && err.stack ? err.stack : err);
    return false;
  }
}

// 購読中の全端末へ Web Push を送る。失効した購読（404/410）は掃除する。
// 1件ずつ送るため、他の購読者への送信は1件の失敗に引きずられない。
async function pushToAllSubscribers(env, notif) {
  const { results } = await env.DB
    .prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions`)
    .all();
  const payload = { title: notif.title, body: notif.body || '', url: notif.linkUrl || '/' };
  for (const sub of results ?? []) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    const result = await sendWebPush(subscription, payload, env);
    if (!result.ok && (result.status === 404 || result.status === 410)) {
      // ブラウザ側で購読が失効している合図。次回以降の無駄な送信を避けるため削除する
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?1`).bind(sub.id).run().catch(() => {});
    }
  }
}

/**
 * createNotification に加え、VAPID鍵が設定されていれば購読中の全端末へ Web Push も送る
 * （アプリを開いていなくても気づけるようにする）。呼び出し側は createNotification の代わりに
 * これを使う。Push配信は waitUntil で裏実行し、レスポンスを遅らせない・失敗しても本処理に影響しない。
 * @param {object} env Functions の env（env.DB・VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY）
 * @param {Function} [waitUntil] Pages Functions のコンテキストが渡す waitUntil（無ければ同期的に待つ）
 * @param {object} notif createNotification と同じ引数
 * @returns {Promise<boolean>}
 */
export async function notifyTeam(env, waitUntil, notif) {
  const created = await createNotification(env.DB, notif);
  if (created && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    const pushJob = pushToAllSubscribers(env, notif).catch((err) => {
      console.error('pushToAllSubscribers failed:', err && err.stack ? err.stack : err);
    });
    if (typeof waitUntil === 'function') waitUntil(pushJob);
    else await pushJob;
  }
  return created;
}
