// ログインユーザー情報・権限判定
//
// ログイン認証そのものは Cloudflare Access（入口認証）が行うため、
// フロントは GET /api/me で「自分が誰か・権限はどれか」を取得するだけ。
// ここでの権限判定は画面の出し分け（UX目的）であり、
// 実際の権限チェックは必ず Functions 側でも行う。

import { api } from '/js/api.js';

// 権限レベル: viewer（閲覧のみ） < editor（入力可） < admin（管理者）
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };

export const ROLE_LABELS = {
  viewer: '閲覧のみ',
  editor: '入力可',
  admin: '管理者',
};

let currentUser = null;
let vapidPublicKey = null;
let aiEnabled = false;

/** ログインユーザーを取得する（結果はモジュール内にキャッシュ） */
export async function getCurrentUser(force = false) {
  if (!currentUser || force) {
    const data = await api.get('/api/me');
    currentUser = data.user;
    vapidPublicKey = data.vapid_public_key || null;
    aiEnabled = Boolean(data.ai_enabled);
  }
  return currentUser;
}

/** Web Push の VAPID公開鍵（未構成なら null）。getCurrentUser() 実行後に使えるようになる */
export function getVapidPublicKey() {
  return vapidPublicKey;
}

/** Workers AI が構成されているか（未構成ならAI機能のボタンを出さない）。getCurrentUser() 実行後に使える */
export function getAiEnabled() {
  return aiEnabled;
}

/** user が role 以上の権限を持つか */
export function hasRole(user, role) {
  return (ROLE_LEVEL[user && user.role] || 0) >= (ROLE_LEVEL[role] || 99);
}
