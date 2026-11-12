// 全ページ共通のナビゲーション
//   ヘッダーの「戻る（‹ = .back-link）」を「前のページへ戻る」(history.back) に統一する。
//   ・履歴がある場合: 直前に見ていたページへ戻る（例: 年間計画表→点検入力→‹ で年間計画表へ）
//   ・履歴が無い（直接アクセス・新規タブ）場合: 元の href（一覧/親ページ）へフォールバック
//   「ホーム（🏠 = .home-link）」は各HTMLのまま（/ へ遷移）。
//   各ページが <script type="module" src="/js/nav.js"> で読み込むため、全ページで有効になる。
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

// register() だけではブラウザ既定の更新チェック（ページ遷移のたびに実施されるが
// 前回チェックから24時間はスキップされる）に頼ることになり、デプロイ直後にアプリを
// 開いても新バージョンが検知されず「新しいバージョンがあります」が出ないことがある
// （registration.update() は24時間の間隔を無視して即座にチェックする）。
// ページ読み込み時とタブ復帰時に明示的にチェックし、検知を早める。
async function checkForSwUpdate() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  } catch { /* オフライン等での失敗は無視（次のチェック機会に任せる） */ }
}

// Service Worker の登録（PWA: オフラインでもアプリが起動する）。
//   以前はホーム（home-init.js）でだけ登録していたため、QR（設備・部品）から各ページを直接開いた端末や、
//   ホームを一度も開いていない端末ではオフライン用のキャッシュが作られなかった。全ページ共通のここで行う
//   （同じ /sw.js を何度登録しても1つに揃うので、ページごとに呼んで構わない）。
//   読み込みの邪魔をしないよう、ページの読み込みが終わってから登録する。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service Worker の登録に失敗:', err);
  });
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

registerServiceWorker();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { setupBackNav(); setupUpdateToast(); setupAutoSync(); checkForSwUpdate(); });
} else {
  setupBackNav();
  setupUpdateToast();
  setupAutoSync();
  checkForSwUpdate();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForSwUpdate();
});
