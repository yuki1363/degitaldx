// /api/* のキャッチオール — 未定義のエンドポイントに JSON の 404 を返す
//   （これが無いと Pages の SPA フォールバックにより index.html が 200 で返ってしまい、
// 　 フロント側でエラーに気づけない）
//   具体的なルート（me.js 等）が優先され、どれにも一致しない場合のみここに到達する。

import { jsonError } from './_lib/http.js';

export function onRequest({ request }) {
  const { pathname } = new URL(request.url);
  return jsonError(404, `APIが見つかりません: ${pathname}`);
}
