// GET /api/me — ログインユーザー情報
//   フロント（js/auth.js）が起動時に呼び、画面の出し分け（UX目的）に使う。
//   実際の権限チェックは各 API ハンドラ側で必ず行う。

import { json } from './_lib/http.js';

// デプロイ確認用のアプリ版。リリースのたびに sw.js の CACHE_VERSION と一緒に上げる。
// /api/me は Service Worker にキャッシュされない（middlewareで認証必須のAPI）ため、
// この値＝いま本番で動いている Functions のバージョン。UIキャッシュの新旧に関わらず、
// 「最新のコードがデプロイ済みか」をホーム画面下部の表示で確認できる。
export const APP_VERSION = 'v1.11.0';

export function onRequestGet({ data, env }) {
  // VAPID公開鍵は秘密ではないためそのまま返してよい（秘密鍵は絶対に返さない）。
  // 未設定（Web Push未構成）なら null → フロントは購読ボタンを出さない。
  // ai_enabled: Workers AI（[ai]バインディング）が構成されているか。未構成なら
  // フロントは「AIに原因・対策のヒントをもらう」ボタンを出さない（VAPID公開鍵と同じ考え方）。
  return json({
    user: data.user,
    version: APP_VERSION,
    vapid_public_key: env.VAPID_PUBLIC_KEY || null,
    ai_enabled: Boolean(env.AI),
  });
}
