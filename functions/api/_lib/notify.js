// 通知の生成 — 部品在庫0・点検の異常値/NG・トラブル登録などの発生時に呼ぶ。
//   通知はチーム共有（確認は notifications.acknowledged_by/at で管理）。
//   通知作成はあくまで本処理の副作用なので、失敗しても本処理（点検保存等）は
//   止めない。エラーはログに残して握りつぶす（戻り値で成否を返す）。

import { nowIso } from './util.js';

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
