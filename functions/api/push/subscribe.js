// POST /api/push/subscribe — Web Push購読を登録する（認証済み全員・viewerでも可）
//   body: PushSubscription をそのままJSON化したもの { endpoint, keys: { p256dh, auth } }
//   同じ endpoint は UNIQUE 制約により1件に保たれる（再購読時は上書き）。

import { json, jsonError, readJson } from '../_lib/http.js';
import { nowIso } from '../_lib/util.js';

export async function onRequestPost({ request, env, data }) {
  const db = env.DB;
  const body = await readJson(request);
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return jsonError(400, 'endpoint / keys.p256dh / keys.auth は必須です');
  }

  await db
    .prepare(
      `INSERT INTO push_subscriptions (user_email, endpoint, p256dh, auth, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET user_email = ?1, p256dh = ?3, auth = ?4`
    )
    .bind(data.user.email, endpoint, p256dh, auth, nowIso())
    .run();

  return json({ ok: true }, 201);
}
