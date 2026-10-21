// fetch ラッパー — すべての API 呼び出しはここを経由する
//
// 使い方:
//   import { api, ApiError } from '/js/api.js';
//   const data = await api.get('/api/me');
//   await api.post('/api/equipment', { name: '1号コンプレッサ' });

export class ApiError extends Error {
  constructor(status, message, detail = undefined, offline = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.offline = offline;
  }
}

// 再認証遷移（?reauth=付きURL）から戻ってきたら、URLからパラメータを掃除しておく。
// Service Worker の静的キャッシュはクエリ付きURLにヒットしないため、残すと次回以降
// キャッシュが効かなくなる。副作用の無い cosmetic な後始末。
try {
  const here = new URL(window.location.href);
  if (here.searchParams.has('reauth')) {
    here.searchParams.delete('reauth');
    window.history.replaceState(null, '', here.pathname + here.search + here.hash);
  }
} catch { /* SSR/権限制約などでは無視 */ }

const REAUTH_KEY = 'mainte-reauth-at';

// API へ到達できない失敗が「本当のオフライン」か「Cloudflare Access のセッション切れ」かを見分ける。
// オンライン（navigator.onLine === true）なのに GET が届かない場合、Access のログイン画面
// （別ドメイン）へリダイレクトされ CORS で fetch が弾かれた可能性が高い。この場合は
// トップレベル遷移で Access の再ログイン（ワンタイムPIN）へ誘導する。
//   - GET のみ対象（POST 等で再読み込みすると入力中データが消えるため）
//   - 直近15秒に一度だけ（再読み込みループ防止。サーバー障害時は誘導せずエラー表示に戻す）
//   - ?reauth= を付けて遷移する（sw.js が検知して介入せず、ネイティブ遷移で Access の
//     リダイレクトを確実に通す）
function tryReauthNavigate(method) {
  if (method !== 'GET') return false;
  if (navigator.onLine !== true) return false; // 本当にオフライン → 誘導しない
  const now = Date.now();
  let last = 0;
  try { last = Number(sessionStorage.getItem(REAUTH_KEY) || '0'); } catch { /* noop */ }
  if (now - last < 15000) return false; // 直近に試したばかり → ループ防止で今回は諦める
  try { sessionStorage.setItem(REAUTH_KEY, String(now)); } catch { /* プライベートモード等 */ }
  const to = new URL(window.location.href);
  to.searchParams.set('reauth', String(now));
  window.location.replace(to.toString());
  return true;
}

// 自動の再認証誘導を使い切ってもなお「オンラインなのにAPIに届かない」ときは、Access のログイン切れ
// の可能性が高い。メールアプリ内ブラウザ・PCにインストールしたPWAの窓などでは自動誘導が通らない
// ことがあるため、画面上部に「再ログイン」ボタンを出して手動で再認証できるようにする。
//   - Access 標準の /cdn-cgi/access/logout へ移動（sw.js は /cdn-cgi/ に介入しない）。
//     returnTo で今のページへ戻す（未対応の場合はログアウト表示になるので、アプリを開き直してもらう）
//   - 本当にオフライン（navigator.onLine === false）のときは出さない
function showReloginBanner() {
  if (navigator.onLine !== true) return;
  if (!document.body || document.getElementById('relogin-banner')) return;
  const back = new URL(window.location.href);
  back.searchParams.delete('reauth');
  const bar = document.createElement('div');
  bar.id = 'relogin-banner';
  bar.className = 'relogin-banner';
  bar.setAttribute('role', 'alert');
  const msg = document.createElement('span');
  msg.textContent = '🔑 ログインの有効期限が切れた可能性があります。';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm btn-primary';
  btn.textContent = '再ログインする';
  btn.addEventListener('click', () => {
    window.location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(back.toString())}`;
  });
  bar.append(msg, btn);
  document.body.prepend(bar);
}

async function request(path, { method = 'GET', body, headers } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    // オンラインなら Access セッション切れの可能性が高い → 再認証へ誘導
    if (tryReauthNavigate(method)) {
      throw new ApiError(0, '認証を確認しています。再読み込みします。', undefined, true);
    }
    showReloginBanner();
    throw new ApiError(0, 'ネットワークに接続できません。通信環境を確認してください。', undefined, true);
  }

  const contentType = response.headers.get('Content-Type') || '';

  // Cloudflare Access のセッション切れで API がログイン画面（HTML）へ
  // リダイレクトされた場合は、ページ全体を再読み込みして再認証させる
  if (response.redirected && contentType.includes('text/html')) {
    window.location.reload();
    throw new ApiError(401, '認証セッションの有効期限が切れました。再読み込みします。');
  }

  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const err = data && data.error ? data.error : {};
    const offline = err.offline === true;
    // Service Worker が返す offline:true（Access リダイレクトの CORS 失敗を含む）も
    // オンラインなら再認証へ誘導する
    if (offline && tryReauthNavigate(method)) {
      throw new ApiError(response.status, '認証を確認しています。再読み込みします。', undefined, true);
    }
    if (offline) showReloginBanner();
    throw new ApiError(
      response.status,
      err.message || `エラーが発生しました（HTTP ${response.status}）`,
      err.detail,
      offline
    );
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};
