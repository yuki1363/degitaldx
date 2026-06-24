// 全ページ共通のナビゲーション
//   ヘッダーの「戻る（‹ = .back-link）」を「前のページへ戻る」(history.back) に統一する。
//   ・履歴がある場合: 直前に見ていたページへ戻る（例: 年間計画表→点検入力→‹ で年間計画表へ）
//   ・履歴が無い（直接アクセス・新規タブ）場合: 元の href（一覧/親ページ）へフォールバック
//   「ホーム（🏠 = .home-link）」は各HTMLのまま（/ へ遷移）。
//   ai-assistant.js が全ページで import するため、全ページで有効になる。

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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupBackNav);
} else {
  setupBackNav();
}
