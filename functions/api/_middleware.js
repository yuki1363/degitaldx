// /api/* 共通ミドルウェア
//   1) Cloudflare Access のメールアドレスからログインユーザーを特定し、
//      context.data.user に格納する（未認証 401 / 未登録 403）
//   2) ハンドラ内の未捕捉エラーを JSON の 500 に変換する
//   3) 応答にセキュリティヘッダー（nosniff 等）を付ける
//
// 各エンドポイントは context.data.user を前提にでき、
// 入力系の操作では requireRole(data.user, 'editor') 等で権限チェックを行う。

import { resolveUser } from './_lib/auth.js';
import { jsonError } from './_lib/http.js';

export async function onRequest(context) {
  return withSecurityHeaders(await handle(context));
}

async function handle(context) {
  try {
    const { user, error } = await resolveUser(context.request, context.env);
    if (error) return error;
    context.data.user = user;
    return await context.next();
  } catch (err) {
    console.error('API error:', err && err.stack ? err.stack : err);
    return jsonError(500, 'サーバーエラーが発生しました。時間をおいて再度お試しください。');
  }
}

// API 応答のセキュリティヘッダー（静的ファイルはルートの _headers で付ける）。
//   nosniff: /api/files の応答をブラウザが Content-Type 以外（HTML等）と推測して実行しないように
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

function withSecurityHeaders(response) {
  let res = response;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  } catch {
    // Response.redirect() 等はヘッダーが変更不可のため複製してから付ける
    res = new Response(response.body, response);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  }
  return res;
}
