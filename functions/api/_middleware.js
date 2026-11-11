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
import { ensurePerfIndexes } from './_lib/perf-indexes.js';

export async function onRequest(context) {
  return withSecurityHeaders(await handle(context));
}

async function handle(context) {
  try {
    const csrf = checkOrigin(context.request);
    if (csrf) return csrf;
    const { user, error } = await resolveUser(context.request, context.env);
    if (error) return error;
    context.data.user = user;
    // 読み取り行数を減らす索引を（無ければ）作る。1プロセスにつき1回だけ実行し、失敗しても処理は続ける
    await ensurePerfIndexes(context.env.DB).catch(() => {});
    return await context.next();
  } catch (err) {
    console.error('API error:', err && err.stack ? err.stack : err);
    return jsonError(500, 'サーバーエラーが発生しました。時間をおいて再度お試しください。');
  }
}

// CSRF対策（簡易）: 更新系メソッドは Origin ヘッダーが自サイトと一致するときだけ通す。
//   Cloudflare Access の認証はブラウザの Cookie/ヘッダーに依存するため、別サイトに置いた
//   フォーム等から（ログイン済みブラウザ経由で）API を叩かれる危険がある（CSRF）。
//   fetch は同一オリジンの POST/PUT/DELETE でも Origin ヘッダーを送るため、これで実害なく防げる。
//   GET/HEAD は副作用がないため対象外。Origin が無いリクエスト（一般的なブラウザのfetchでは
//   通常付く）は、古いUA等を誤って拒否しないよう素通りさせる（Access の認証自体は別途効く）。
function checkOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (origin === new URL(request.url).origin) return null;
  return jsonError(403, '不正なリクエスト元からの操作です。ページを再読み込みしてやり直してください。');
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
