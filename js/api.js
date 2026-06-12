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
    throw new ApiError(
      response.status,
      err.message || `エラーが発生しました（HTTP ${response.status}）`,
      err.detail,
      err.offline === true
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
