/* Service Worker — PWA基盤
 *
 * 方針:
 *   - 静的アセット: キャッシュ優先 + 裏で最新化（オフラインでもアプリが起動する）
 *   - /api/*     : ネットワークのみ（業務データはキャッシュしない。
 *                  オフライン時は offline:true の JSON エラーを返す）
 *   - /cdn-cgi/* : Cloudflare（Access ログイン等）の領域のため一切関与しない
 *   - アプリを更新したら CACHE_VERSION を上げる（旧キャッシュは activate で削除）
 *
 * 将来拡張（CLAUDE.md）: 入力中データの IndexedDB 一時保存とオンライン復帰時の
 * 自動同期は、入力フォームを実装するフェーズで追加する。
 */
const CACHE_VERSION = 'v0.47.0';
const CACHE_NAME = `mainte-app-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/api.js',
  '/js/auth.js',
  '/js/files.js',
  '/js/util.js',
  '/js/csv.js',
  '/js/equip-names.js',
  '/js/qr-scan.js',
  '/js/ledger.js',
  '/js/labels.js',
  '/js/inspection.js',
  '/js/inspection-report.js',
  '/js/plan.js',
  '/js/plan-annual.js',
  '/js/trouble.js',
  '/js/repair.js',
  '/js/parts.js',
  '/js/report.js',
  '/js/dashboard.js',
  '/js/admin.js',
  '/js/chat.js',
  '/js/comments.js',
  '/js/search.js',
  '/js/notifications.js',
  '/js/vendor/qrcode.mjs',
  '/pages/ledger',
  '/pages/labels',
  '/pages/inspection',
  '/pages/inspection-report',
  '/pages/plan',
  '/pages/plan-annual',
  '/pages/trouble',
  '/pages/repair',
  '/pages/parts',
  '/pages/report',
  '/pages/dashboard',
  '/pages/admin',
  '/pages/chat',
  '/pages/search',
  '/pages/notifications',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/cdn-cgi/')) return;

  // API: ネットワークのみ。オフライン時は JSON エラー（フロントで offline 判定に使う）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            JSON.stringify({
              error: { message: 'オフラインのため通信できません。', offline: true },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
          )
      )
    );
    return;
  }

  // 静的アセット: キャッシュ優先 + 裏で最新化（stale-while-revalidate）
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => undefined);

      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;
      // オフラインで未キャッシュのページに来た場合はアプリシェルへフォールバック
      if (request.mode === 'navigate') {
        const shell = await cache.match('/index.html');
        if (shell) return shell;
      }
      return new Response('オフラインのため表示できません。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })
  );
});
