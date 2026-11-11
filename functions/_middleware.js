// ルートのミドルウェア — 開発用ファイル（CLAUDE.md・schema.sql・tests/ など）を配信しない（17）。
//   `_routes.json` の exclude（HTML ページ・css・アイコン・ホーム・sw.js・manifest.json のファイル名の完全一致）
//   以外のリクエストが通る。
//   許可リストにないパスは 404。判定は functions/api/_lib/blocked-paths.js。
//   /api/* は functions/api/_middleware.js が、/electrical/* は functions/electrical/_middleware.js が続けて担当する。
import { isBlockedPath } from './api/_lib/blocked-paths.js';

export async function onRequest(context) {
  const { pathname } = new URL(context.request.url);
  if (isBlockedPath(pathname)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  return context.next();
}
