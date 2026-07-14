// Web Push の送信 — VAPID署名（RFC 8292）＋ メッセージ暗号化（RFC 8291 aes128gcm）を
// Web Crypto API（crypto.subtle）のみで実装する（npm依存なし・ビルド工程なしの方針を維持）。
//
//   VAPID鍵は1回だけ生成し、Cloudflareの環境変数に設定する（README/CLAUDE.md参照）:
//     VAPID_PUBLIC_KEY  … 非公開鍵ではない。ブラウザの subscribe() にも使う（平文でよい）
//     VAPID_PRIVATE_KEY … "d.x.y"（EC P-256 JWKの各値をbase64urlで.区切り）。必ずCloudflareの
//                         暗号化環境変数（Secret）として設定すること
//     VAPID_SUBJECT     … 任意。JWTのsubクレーム（例 mailto:admin@example.com）。未設定なら既定値
//
//   実装は RFC 8291 の記載どおり:
//     1. ECDH鍵合意（自前の使い捨てEC鍵 × 購読先のp256dh）
//     2. HKDF（購読先のauthシークレットと合わせて2段階）でCEK（AES鍵）とnonceを導出
//     3. AES-128-GCMで暗号化し、aes128gcm形式のヘッダ（salt+recordSize+keyid）を前置して送信

const ENCODER = new TextEncoder();

// ---- base64url ヘルパ ----
function b64uToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// VAPID_PRIVATE_KEY（"d.x.y"）から署名用のECDSA秘密鍵（CryptoKey）と、対応する公開鍵JWKを作る
async function importVapidPrivateKey(vapidPrivateKeyStr) {
  const [d, x, y] = vapidPrivateKeyStr.split('.');
  if (!d || !x || !y) throw new Error('VAPID_PRIVATE_KEY の形式が不正です（d.x.y の3つ組で指定してください）');
  const jwk = { kty: 'EC', crv: 'P-256', d, x, y, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// VAPID JWT（ES256）を生成する。aud は購読先エンドポイントのオリジン（例 https://fcm.googleapis.com）
async function buildVapidJwt({ audience, subject, privateKey }) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 最大12時間（RFC 8292の上限）
    sub: subject,
  };
  const headerB64 = bytesToB64u(ENCODER.encode(JSON.stringify(header)));
  const payloadB64 = bytesToB64u(ENCODER.encode(JSON.stringify(payload)));
  const unsigned = `${headerB64}.${payloadB64}`;
  // Web Crypto の ECDSA 署名は IEEE P1363 形式（r||s 64byte）で返る。JWTのES256もこの形式そのまま使える
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, ENCODER.encode(unsigned));
  const sigB64 = bytesToB64u(new Uint8Array(sig));
  return `${unsigned}.${sigB64}`;
}

// HKDF の1段（HMAC-SHA256をExtract/Expandの両方に使う。RFC 8291はこの手続きを2回連鎖させる）
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
  return new Uint8Array(sig);
}

/**
 * RFC 8291（aes128gcm）でメッセージを暗号化し、送信用バイト列を組み立てる。
 * sendWebPush から使うほか、暗号化ロジック単体のテスト（自己検証）にも使う。
 * @param {string} uaPublicB64u 購読先の p256dh（ブラウザのECDH公開鍵・base64url）
 * @param {string} authB64u     購読先の auth シークレット（base64url）
 * @param {object} payloadObj   通知内容（JSON化して暗号化する）
 * @returns {Promise<Uint8Array>} aes128gcm 形式のボディ（HTTPリクエストのbodyにそのまま使う）
 */
export async function encryptAes128Gcm(uaPublicB64u, authB64u, payloadObj) {
  const plaintext = ENCODER.encode(JSON.stringify(payloadObj));
  const uaPublicBytes = b64uToBytes(uaPublicB64u); // 購読先（ブラウザ）のECDH公開鍵（65byte生点）
  const authSecret = b64uToBytes(authB64u);        // 購読先のauthシークレット（16byte）

  const uaPublicKey = await crypto.subtle.importKey(
    'raw', uaPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  // 使い捨てのサーバー側ECDH鍵ペア（メッセージごとに新規生成する）
  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const ecdhSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256
  );
  const ecdhSecret = new Uint8Array(ecdhSecretBits);

  // 1段目: ECDH共有秘密 + authシークレット → IKM（"WebPush: info"にuaPublic/asPublicを含める）
  const keyInfo = concatBytes(
    ENCODER.encode('WebPush: info\0'), uaPublicBytes, asPublicRaw
  );
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const ikm = (await hmacSha256(prkKey, concatBytes(keyInfo, new Uint8Array([1])))).slice(0, 32);

  // 2段目: ランダムsalt + IKM → CEK（AES鍵）・NONCE
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cekInfo = ENCODER.encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = ENCODER.encode('Content-Encoding: nonce\0');
  const cek = (await hmacSha256(prk, concatBytes(cekInfo, new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concatBytes(nonceInfo, new Uint8Array([1])))).slice(0, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // 末尾に区切り0x02（このレコードで最後、を意味する。1レコードのみ送るため常に0x02）
  const paddedPlaintext = concatBytes(plaintext, new Uint8Array([2]));
  const cipherBits = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPlaintext);
  const ciphertext = new Uint8Array(cipherBits); // AES-GCMの出力は末尾に16byte認証タグを含む

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096); // record size（十分大きい値。1レコードのみ使用）
  const header = concatBytes(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concatBytes(header, ciphertext);
}

/**
 * 1件の購読先へWeb Pushを送信する。
 * @param {{endpoint:string, keys:{p256dh:string, auth:string}}} subscription
 * @param {object} payloadObj 通知内容（JSON化してtitle/body/url等を渡す）
 * @param {{VAPID_PUBLIC_KEY:string, VAPID_PRIVATE_KEY:string, VAPID_SUBJECT?:string}} env
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function sendWebPush(subscription, payloadObj, env) {
  try {
    const vapidPublicKeyB64u = env.VAPID_PUBLIC_KEY;
    const vapidPrivateKeyStr = env.VAPID_PRIVATE_KEY;
    if (!vapidPublicKeyB64u || !vapidPrivateKeyStr) return { ok: false, error: 'VAPID鍵が未設定です' };

    const endpointUrl = new URL(subscription.endpoint);
    const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
    const subject = env.VAPID_SUBJECT || 'mailto:admin@example.com';

    const vapidPrivateKey = await importVapidPrivateKey(vapidPrivateKeyStr);
    const jwt = await buildVapidJwt({ audience, subject, privateKey: vapidPrivateKey });

    const body = await encryptAes128Gcm(subscription.keys.p256dh, subscription.keys.auth, payloadObj);

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: '86400',
        Authorization: `vapid t=${jwt}, k=${vapidPublicKeyB64u}`,
      },
      body,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
