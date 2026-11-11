// /electrical/* 専用のセキュリティヘッダー上書き
//
//   電気設備点検（12）は元アプリがグローバルCSS/固定ID/インライン onclick でページ全体を
//   所有する前提のため、他のページより緩い CSP（script-src に 'unsafe-inline' を含む）が必要。
//   ルートの `_headers`（/* ルール）は Pages Functions より前の静的配信レイヤーで付くため、
//   Cloudflare Pages の _headers に `/electrical/*` 用の別ルールを追記しても、同じ名前の
//   ヘッダーが2つマッチした場合は「上書き」ではなく値がカンマで連結されてしまい
//   （より具体的なパスが優先、ではない）、結果として両方の CSP が合成され、
//   電気設備点検の onclick がブロックされたままになる（実機で確認済みの挙動）。
//
//   そのため `_headers` 側では `/electrical/*` の特別ルールを書かず、ここで応答を一度
//   受け取ってから Content-Security-Policy だけを確実に1つの値へ上書きする
//   （Headers.set は追記ではなく置き換えなので、`_headers` が付けた値を完全に置き換えられる）。
export async function onRequest(context) {
  const res = await context.next();
  const headers = new Headers(res.headers);
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; " +
      "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
      "frame-ancestors 'none'"
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
