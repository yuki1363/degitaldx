// ホーム画面の初期化（index.html のインラインスクリプトを分離したもの）。
//   CSP の script-src から 'unsafe-inline' を外すため、ページに直接書いていたスクリプトを
//   このファイルへ移した（内容は変更していない）。
import { getCurrentUser, hasRole, ROLE_LABELS } from '/js/auth.js';
import { api } from '/js/api.js';
import { loadHomeTabs } from '/js/home-tabs.js';
import { showUpdateDialog } from '/js/update-notice.js';

// Service Worker の登録は全ページ共通の js/nav.js で行う（ホームを経由しない直接アクセスでもキャッシュされるように）。

// 更新のお知らせ（新しい版のあとの最初の表示だけ、ダイアログで出す。ログイン確認を待たずに出す）
showUpdateDialog();

// オフライン表示
const offlineBanner = document.getElementById('offline-banner');
const updateOnlineStatus = () => {
  offlineBanner.hidden = navigator.onLine;
};
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ログインユーザー表示（Cloudflare Access のメールアドレスと users テーブルの突合結果）
const notice = document.getElementById('auth-notice');
try {
  const user = await getCurrentUser();
  document.getElementById('user-name').textContent = user.name;
  document.getElementById('user-role').textContent = ROLE_LABELS[user.role] || user.role;
  document.getElementById('user-chip').hidden = false;
  showStorageAlertForAdmin(user);
  loadHomeTabs(document.getElementById('home-overview'));
  // デプロイ確認用: いま本番で動いている Functions のバージョンを表示する
  // （/api/me は SW にキャッシュされないので、UIキャッシュの新旧に関係なく最新が分かる）
  api.get('/api/me').then((r) => {
    if (r && r.version) document.getElementById('app-version').textContent = ' ・ ' + r.version;
  }).catch(() => {});
  // 管理者のみ管理タイルを有効化
  if (user.role === 'admin') {
    const tile = document.getElementById('tile-admin');
    tile.classList.remove('is-disabled');
    tile.removeAttribute('aria-disabled');
    tile.href = '/pages/admin';
    tile.querySelector('.badge-soon')?.remove();
  }
} catch (err) {
  if (err.offline) {
    // オフライン起動時はユーザー表示なしで続行（オンライン復帰時に再取得される）
    console.info('オフライン起動のためユーザー情報は未取得');
  } else {
    notice.textContent = err.message;
    notice.hidden = false;
  }
}

// 管理者向け: 保存容量の警告と、利用者からの容量報告の件数を表示
async function showStorageAlertForAdmin(user) {
  if (!hasRole(user, 'admin')) return;
  try {
    const [{ usage }, { reports }] = await Promise.all([
      api.get('/api/files/usage'),
      api.get('/api/files/report'),
    ]);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentReports = reports.filter(
      (r) => Date.parse(r.created_at) >= weekAgo
    ).length;
    if (!usage.warning && recentReports === 0) return;

    const gb = (bytes) => (bytes / 1_000_000_000).toFixed(2);
    const parts = [];
    if (usage.warning) {
      parts.push(
        `⚠ 保存容量が残りわずかです（${gb(usage.used_bytes)}GB / 上限 ${gb(usage.hard_limit_bytes)}GB・${usage.used_percent}%）。不要な動画・ファイルの整理を検討してください。`
      );
    }
    if (recentReports > 0) {
      parts.push(`利用者から容量に関する報告が ${recentReports} 件届いています（直近7日）。`);
    }
    const alert = document.getElementById('storage-alert');
    alert.textContent = parts.join(' ');
    alert.hidden = false;
  } catch {
    // 容量情報の取得失敗はホーム表示を妨げない
  }
}
