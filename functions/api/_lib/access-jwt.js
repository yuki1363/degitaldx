// Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）を検証する
//
// Access を通ったリクエストには、Access が署名した JWT が付く。
// メールアドレスのヘッダー（Cf-Access-Authenticated-User-Email）だけを信じると、
// Access の保護が外れた URL（プレビューURL等）ではヘッダーを書き換えるだけで
// なりすませるため、署名・aud・iss・有効期限を確かめてから JWT 内の email を使う。
//
// 有効化: 環境変数 ACCESS_TEAM_DOMAIN（例 yourteam.cloudflareaccess.com）と
//         ACCESS_AUD（Access アプリの「Application Audience (AUD) Tag」）の両方を設定する。
// 署名鍵は https://<チーム>.cloudflareaccess.com/cdn-cgi/access/certs から取得して
// しばらくメモリに保持する（鍵の切り替えで kid が見つからなければ取り直す）。
// npm 依存なし（Web Crypto API のみ）。

const CERTS_TTL_MS = 60 * 60 * 1000; // 鍵の保持時間（1時間）
const CLOCK_SKEW_SEC = 60;           // 時計ずれの許容
const REFETCH_MIN_MS = 60 * 1000;     // 鍵の取り直しの最小間隔

let certsCache = { issuer: null, keys: null, fetchedAt: 0 };

/** 設定されていれば正規化した issuer（https://xxx.cloudflareaccess.com）と aud を返す */
export function accessJwtConfig(env) {
  const domain = String(env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!domain || !aud) return null;
  const issuer = 'https://' + domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return { issuer, aud };
}

/** リクエストから JWT を取り出す（ヘッダー優先・無ければ CF_Authorization Cookie） */
export function getAccessToken(request) {
  const h = request.headers.get('Cf-Access-Jwt-Assertion');
  if (h) return h.trim();
  const cookie = request.headers.get('Cookie') || '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1] : null;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function loadKeys(issuer, force) {
  const fresh = certsCache.issuer === issuer && certsCache.keys &&
    Date.now() - certsCache.fetchedAt < CERTS_TTL_MS;
  if (fresh && !force) return certsCache.keys;
  // 未知の kid による取り直しは1分に1回まで（でたらめな kid を大量に送られても鍵取得を連打しない）
  if (fresh && force && Date.now() - certsCache.fetchedAt < REFETCH_MIN_MS) return certsCache.keys;
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs の取得に失敗しました（HTTP ${res.status}）`);
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  certsCache = { issuer, keys, fetchedAt: Date.now() };
  return keys;
}

async function findKey(issuer, kid) {
  let keys = await loadKeys(issuer, false);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    keys = await loadKeys(issuer, true); // 鍵が切り替わった直後
    jwk = keys.find((k) => k.kid === kid);
  }
  return jwk || null;
}

/**
 * JWT を検証し、正しければ payload を返す。不正なら null。
 * （鍵の取得失敗など検証そのものができないときは例外 → 呼び出し側で 500）
 */
export async function verifyAccessJwt(token, { issuer, aud }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header?.alg !== 'RS256' || !header.kid) return null;

  const jwk = await findKey(issuer, header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  let sigOk = false;
  try {
    sigOk = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return null;
  }
  if (!sigOk) return null;

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== issuer) return null;
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SEC > now) return null;
  return payload;
}
