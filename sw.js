/* Service Worker — PWA基盤
 *
 * 方針:
 *   - 静的アセット: キャッシュ優先 + 裏で最新化（オフラインでもアプリが起動する）
 *   - /api/*     : ネットワークのみ（業務データはキャッシュしない。
 *                  オフライン時は offline:true の JSON エラーを返す）
 *   - /cdn-cgi/* : Cloudflare（Access ログイン等）の領域のため一切関与しない
 *   - アプリを更新したら CACHE_VERSION を上げる（旧キャッシュは activate で削除）
 *
 * オフライン入力（CLAUDE.md のオフライン考慮）は js/offline-queue.js が担う:
 *   点検・トラブルの新規保存がオフラインで失敗すると IndexedDB の送信キューに保存し、
 *   オンライン復帰時に自動送信する（写真Blob含む）。
 *
 * Web Push（js/notifications.js から購読）:
 *   push イベントでプッシュ通知を表示し、notificationclick でアプリの該当画面を開く。
 *   ペイロードは functions/api/_lib/notify.js が { title, body, url } のJSONで送る。
 */
const CACHE_VERSION = 'v1.8.0';
const CACHE_NAME = `mainte-app-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/api.js',
  '/js/auth.js',
  '/js/home-tabs.js',
  '/js/files.js',
  '/js/util.js',
  '/js/csv.js',
  '/js/draft.js',
  '/js/offline-queue.js',
  '/js/equip-names.js',
  '/js/equip-picker.js',
  '/js/qr-scan.js',
  '/js/ledger.js',
  '/js/labels.js',
  '/js/inspection.js',
  '/js/inspection-items.js',
  '/js/inspection-batch.js',
  '/js/inspection-report.js',
  '/js/plan.js',
  '/js/plan-annual.js',
  '/js/plan-import.js',
  '/js/plan-summary.js',
  '/js/plan-inspection-link.js',
  '/js/permit-fields.js',
  '/js/print-templates.js',
  '/js/excel-fill.js',
  '/js/hanko.js',
  '/js/xlsx-image.js',
  '/js/trouble.js',
  '/js/repair.js',
  '/js/parts.js',
  '/js/report.js',
  '/js/dashboard.js',
  '/js/admin.js',
  '/js/admin-files.js',
  '/js/chat.js',
  '/js/ai-assistant.js',
  '/js/nav.js',
  '/js/search.js',
  '/js/notifications.js',
  '/js/vendor/qrcode.mjs',
  '/js/vendor/jsqr.js',
  '/js/vendor/chart.umd.min.js',
  '/js/vendor/encoding.min.js',
  '/js/vendor/jszip.min.js',
  '/pages/ledger',
  '/pages/labels',
  '/pages/inspection',
  '/pages/inspection-batch',
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

// Web Push受信 → 通知を表示する。ペイロードが読めない/無い場合も最低限の通知は出す
// （プッシュサービスの仕様上、pushイベントを受けたら何かしら表示しないと
//   ブラウザから「サイレントプッシュ」とみなされ購読を無効化されることがあるため）。
self.addEventListener('push', (event) => {
  let data = { title: '設備保全アプリ', body: '新しい通知があります', url: '/pages/notifications' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch { /* JSONでなくても既定値で表示する */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/pages/notifications' },
    })
  );
});

// 通知タップ → 該当画面を開く（既に開いているタブがあればそこにフォーカスする）
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/pages/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
