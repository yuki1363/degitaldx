// /api/* 共通ミドルウェア
//   1) Cloudflare Access のメールアドレスからログインユーザーを特定し、
//      context.data.user に格納する（未認証 401 / 未登録 403）
//   2) ハンドラ内の未捕捉エラーを JSON の 500 に変換する
//
// 各エンドポイントは context.data.user を前提にでき、
// 入力系の操作では requireRole(data.user, 'editor') 等で権限チェックを行う。

import { resolveUser } from './_lib/auth.js';
import { jsonError } from './_lib/http.js';

export async function onRequest(context) {
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
