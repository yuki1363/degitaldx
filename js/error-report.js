// 画面エラーの自動記録 — 全ページの先頭で読み込む（<head> の最初の <script src>。モジュールではない）。
//   現場の端末で起きたエラーは、利用者が知らせてくれない限り分からなかった。次の3つを
//   POST /api/client-errors へ自動で送り、管理者が管理画面「エラー記録」で見られるようにする。
//     ・画面のエラー（JavaScript の例外・処理の失敗〔未処理の Promise〕）
//     ・読み込めなかったスクリプト・スタイル
//     ・API のサーバーエラー（5xx。js/api.js が window.__reportClientError を呼ぶ）
//   利用者の操作は止めない（送信の失敗は無視する）。入力内容は送らない＝送るのはエラーの文・起きた場所・
//   ページのパス（検索語や本文が入るクエリは付けない）・アプリの版だけ。
//   送りすぎないよう、同じエラーは1回、1ページ表示につき5件、1端末1時間に20件まで。
//   電波が無いときは送らない（後からも送らない）。
(function () {
  'use strict';
  if (window.__reportClientError) return;
  var ENDPOINT = '/api/client-errors';
  var MAX_PER_PAGE = 5;
  var MAX_PER_HOUR = 20;
  var STORE_KEY = 'client-error:sent';
  var sentKeys = {};
  var sentCount = 0;
  // ブラウザが出すだけで、アプリの不具合ではないもの
  var IGNORE = [/^Script error\.?$/i, /ResizeObserver loop/i];

  function underHourlyLimit() {
    try {
      var now = Date.now();
      var list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
      list = list.filter(function (t) { return now - t < 3600000; });
      if (list.length >= MAX_PER_HOUR) return false;
      list.push(now);
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
      return true;
    } catch (e) { return true; } // 保存できない環境（プライベートモード等）は、ページごとの上限だけで抑える
  }

  // いま端末が使っている版（Service Worker のキャッシュ名 mainte-app-v1.2.3）。取れなければ空
  function appVersion() {
    try {
      if (!window.caches) return Promise.resolve('');
      return caches.keys().then(function (keys) {
        var names = keys.filter(function (k) { return k.indexOf('mainte-app-') === 0; }).sort();
        return names.length ? names[names.length - 1].replace('mainte-app-', '') : '';
      }).catch(function () { return ''; });
    } catch (e) { return Promise.resolve(''); }
  }

  function report(kind, message, extra) {
    try {
      var msg = String(message == null ? '' : message).slice(0, 500);
      if (!msg) return;
      for (var i = 0; i < IGNORE.length; i++) if (IGNORE[i].test(msg)) return;
      if (navigator.onLine === false) return;
      var source = extra && extra.source ? String(extra.source).slice(0, 300) : '';
      var key = kind + '|' + msg + '|' + source;
      if (sentKeys[key] || sentCount >= MAX_PER_PAGE) return;
      sentKeys[key] = true;
      sentCount++;
      if (!underHourlyLimit()) return;
      var stack = extra && extra.stack ? String(extra.stack).slice(0, 2000) : '';
      appVersion().then(function (version) {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: JSON.stringify({ kind: kind, message: msg, source: source, stack: stack, page: window.location.pathname, version: version }),
        });
      }).catch(function () { /* 送れなくても何もしない */ });
    } catch (e) { /* 記録の失敗で画面を止めない */ }
  }

  window.__reportClientError = report;

  // 画面のエラー。capture=true で、読み込めなかった <script> / <link>（window まで伝わらない）も拾う
  window.addEventListener('error', function (ev) {
    var t = ev && ev.target;
    if (t && t !== window && t.tagName) {
      var tag = String(t.tagName).toLowerCase();
      if (tag !== 'script' && tag !== 'link') return; // 写真のサムネイルなどは対象外（削除済みの添付で普通に起きる）
      var url = t.src || t.href || '';
      var path = url;
      try { path = new URL(url, window.location.href).pathname; } catch (e) { /* そのまま */ }
      report('resource', '読み込めませんでした: ' + path, { source: tag });
      return;
    }
    var where = ev && ev.filename ? ev.filename.replace(window.location.origin, '') + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0) : '';
    report('js', (ev && ev.message) || 'エラー', { source: where, stack: ev && ev.error && ev.error.stack });
  }, true);

  // 受け止められなかった処理の失敗（await の失敗など）。電波が無いだけの失敗（offline）は送らない
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    if (r && r.offline) return;
    var msg = r && r.message ? r.message : String(r);
    report('promise', msg, { stack: r && r.stack });
  });
})();
