// 全ページ共通のナビゲーション
//   ヘッダーの「戻る（‹ = .back-link）」を「前のページへ戻る」(history.back) に統一する。
//   ・履歴がある場合: 直前に見ていたページへ戻る（例: 年間計画表→点検入力→‹ で年間計画表へ）
//   ・履歴が無い（直接アクセス・新規タブ）場合: 元の href（一覧/親ページ）へフォールバック
//   「ホーム（🏠 = .home-link）」は各HTMLのまま（/ へ遷移）。
//   ai-assistant.js が全ページで import するため、全ページで有効になる。
//   あわせて全ページ共通の「オフライン送信キューの自動同期」もここで起動する。

import { setupAutoSync } from '/js/offline-queue.js';

function setupBackNav() {
  const back = document.querySelector('.app-header .back-link');
  if (!back || back.dataset.navBound) return;
  back.dataset.navBound = '1';
  back.setAttribute('aria-label', '前のページへ戻る');
  back.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = back.getAttribute('href') || '/';
    }
  });
}

// 新バージョン検知: Service Worker が更新されたら「更新する」トーストを出す。
//   本アプリはキャッシュ優先表示のため、更新直後の1回は旧画面が出る。
//   新SWの有効化（controllerchange）を検知したら再読み込みを促し、
//   「再読み込みしてください」と口頭で案内する運用を不要にする。
function setupUpdateToast() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;                        // 初回インストール時は出さない
    if (document.getElementById('sw-update-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'sw-update-toast';
    toast.className = 'sw-toast';
    const msg = document.createElement('span');
    msg.textContent = '新しいバージョンがあります';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = '更新する';
    btn.addEventListener('click', () => window.location.reload());
    const close = document.createElement('button');
    close.className = 'btn btn-sm';
    close.textContent = 'あとで';
    close.addEventListener('click', () => toast.remove());
    toast.append(msg, btn, close);
    document.body.appendChild(toast);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { setupBackNav(); setupUpdateToast(); setupAutoSync(); });
} else {
  setupBackNav();
  setupUpdateToast();
  setupAutoSync();
}
