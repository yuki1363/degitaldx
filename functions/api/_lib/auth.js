// 認証・権限判定の共通モジュール
//
// ログイン認証は Cloudflare Access（入口認証）が行う。
// Functions 側では Access が付与するヘッダーのメールアドレスを読み取り、
// users テーブルと突合してアプリ上のユーザー・権限を特定する。
// ※ このヘッダーは Access の保護下でのみ信頼できる（README のセキュリティ節を参照）

import { jsonError } from './http.js';

const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

// 権限レベル: viewer（閲覧のみ） < editor（入力可） < admin（管理者）
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };

/**
 * リクエストからログインユーザーを特定する。
 * 戻り値: { user } または { error: Response }
 *
 * ローカル開発（wrangler pages dev）では Access ヘッダーが無いため、
 * .dev.vars の DEV_USER_EMAIL を代わりに使う（本番では設定しないこと）。
 */
export async function resolveUser(request, env) {
  const email =
    request.headers.get(ACCESS_EMAIL_HEADER) || env.DEV_USER_EMAIL || null;

  if (!email) {
    return {
      error: jsonError(
        401,
        '認証情報が確認できません。Cloudflare Access 経由でアクセスしてください。'
      ),
    };
  }

  const user = await env.DB.prepare(
    `SELECT id, email, name, group_name, role
       FROM users
      WHERE lower(email) = lower(?1) AND deleted_at IS NULL`
  )
    .bind(email)
    .first();

  if (!user) {
    return {
      error: jsonError(
        403,
        'このメールアドレスは利用登録されていません。管理者にユーザー登録を依頼してください。',
        { email }
      ),
    };
  }

  return { user };
}

/** user が role 以上の権限を持つか */
export function hasRole(user, role) {
  return (ROLE_LEVEL[user?.role] || 0) >= (ROLE_LEVEL[role] || 99);
}

/**
 * 権限ガード。不足していればエラーレスポンスを返し、足りていれば null を返す。
 * 使い方（各ハンドラの先頭で）:
 *   const denied = requireRole(data.user, 'editor');
 *   if (denied) return denied;
 */
export function requireRole(user, role) {
  if (!hasRole(user, role)) {
    return jsonError(403, 'この操作を行う権限がありません。');
  }
  return null;
}
