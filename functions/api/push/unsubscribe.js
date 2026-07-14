// POST /api/push/unsubscribe — Web Push購読を解除する（認証済み全員）
//   body: { endpoint }
//   個人の端末設定に近く、監査対象にしないため物理削除でよい。
//   自分の購読のみ解除できる（user_email が一致する行のみ削除）。

import { json, jsonError, readJson } from '../_lib/http.js';

export async function onRequestPost({ request, env, data }) {
  const db = env.DB;
  const body = await readJson(request);
  const endpoint = body?.endpoint;
  if (!endpoint) return jsonError(400, 'endpoint は必須です');

  await db
    .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_email = ?2`)
    .bind(endpoint, data.user.email)
    .run();

  return json({ ok: true });
}
