// Access JWT 検証（functions/api/_lib/access-jwt.js）の単体テスト。サーバー不要・npm test の最初に実行する。
//   テスト用のRSA鍵でJWTを作り、証明書取得(fetch)を差し替えて resolveUser の判定を確かめる。
import { resolveUser } from '../functions/api/_lib/auth.js';
const { subtle } = globalThis.crypto;
const kp = await subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' }, true, ['sign','verify']);
const kp2 = await subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' }, true, ['sign','verify']);
const jwk = { ...(await subtle.exportKey('jwk', kp.publicKey)), kid:'k1' };
let fetches = 0;
globalThis.fetch = async (url) => { fetches++; if (url !== 'https://team.cloudflareaccess.com/cdn-cgi/access/certs') throw new Error('bad url '+url); return new Response(JSON.stringify({ keys:[jwk] })); };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function sign(payload, { kid='k1', key=kp.privateKey, alg='RS256' } = {}) {
  const h = b64u(JSON.stringify({ alg, kid })), p = b64u(JSON.stringify(payload));
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const now = Math.floor(Date.now()/1000);
const base = { aud:['AUD1'], iss:'https://team.cloudflareaccess.com', email:'a@x.jp', exp: now+600, iat: now };
const env = { ACCESS_TEAM_DOMAIN:'team.cloudflareaccess.com/', ACCESS_AUD:'AUD1', DEV_USER_EMAIL:'admin@x.jp',
  DB:{ prepare:()=>({ bind:(e)=>({ first: async()=> ['a@x.jp','admin@x.jp'].includes(e.toLowerCase()) ? { email:e, role:'admin' } : null }) }) } };
const req = (h) => new Request('https://app/api/me', { headers: h });
const st = async (h, e=env) => { const r = await resolveUser(req(h), e); return r.user ? 'OK:'+r.user.email : r.error.status; };
const cases = [
  ['valid header', { 'Cf-Access-Jwt-Assertion': await sign(base) }, 'OK:a@x.jp'],
  ['valid cookie', { Cookie: 'x=1; CF_Authorization=' + await sign(base) }, 'OK:a@x.jp'],
  ['forged email header only', { 'Cf-Access-Authenticated-User-Email':'admin@x.jp' }, 401],
  ['no token (DEV_USER_EMAIL ignored)', {}, 401],
  ['wrong aud', { 'Cf-Access-Jwt-Assertion': await sign({ ...base, aud:['OTHER'] }) }, 401],
  ['string aud ok', { 'Cf-Access-Jwt-Assertion': await sign({ ...base, aud:'AUD1' }) }, 'OK:a@x.jp'],
  ['wrong iss', { 'Cf-Access-Jwt-Assertion': await sign({ ...base, iss:'https://evil.cloudflareaccess.com' }) }, 401],
  ['expired', { 'Cf-Access-Jwt-Assertion': await sign({ ...base, exp: now-120 }) }, 401],
  ['nbf future', { 'Cf-Access-Jwt-Assertion': await sign({ ...base, nbf: now+600 }) }, 401],
  ['other key', { 'Cf-Access-Jwt-Assertion': await sign(base, { key: kp2.privateKey }) }, 401],
  ['unknown kid', { 'Cf-Access-Jwt-Assertion': await sign(base, { kid:'zz' }) }, 401],
  ['alg none', { 'Cf-Access-Jwt-Assertion': (await sign(base)).split('.').slice(0,2).join('.')+'.' }, 401],
  ['tampered payload', { 'Cf-Access-Jwt-Assertion': (()=>{})() }, 401],
  ['garbage', { 'Cf-Access-Jwt-Assertion': 'abc.def.ghi' }, 401],
  ['unregistered email', { 'Cf-Access-Jwt-Assertion': await sign({ ...base, email:'z@x.jp' }) }, 403],
];
// tampered: swap payload email keeping signature
{ const t = (await sign(base)).split('.'); t[1] = b64u(JSON.stringify({ ...base, email:'admin@x.jp' })); cases[12][1] = { 'Cf-Access-Jwt-Assertion': t.join('.') }; }
let bad = 0;
for (const [n,h,exp] of cases) { const got = await st(h); const ok = got === exp; if (!ok) bad++; console.log(ok?'✅':'❌', n, got); }
const legacyEnv = { ...env, ACCESS_TEAM_DOMAIN:'' };
const l1 = await st({ 'Cf-Access-Authenticated-User-Email':'a@x.jp' }, legacyEnv), l2 = await st({}, legacyEnv);
console.log(l1==='OK:a@x.jp'&&l2==='OK:admin@x.jp'?'✅':'❌', 'legacy mode unchanged', l1, l2);
if (fetches !== 1) { bad++; console.log('❌ 証明書の取得回数', fetches); }
if (!(l1==='OK:a@x.jp'&&l2==='OK:admin@x.jp')) bad++;
console.log(`========== Access JWT: ${bad ? bad + ' 件失敗' : '全件成功'} ==========`);
process.exit(bad ? 1 : 0);
