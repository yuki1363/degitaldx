// 単体テスト: 開発用ファイルの配信止め（functions/api/_lib/blocked-paths.js・functions/_middleware.js・_routes.json）
//   最も大事な確認は「拒否するファイルは必ず Functions を通る（_routes.json の exclude に紛れない）」こと。
//   exclude に紛れると静的配信がそのまま返してしまうため、リポジトリの全ファイルで確かめる。
//   実行: node unit-blocked-paths.mjs（npm test から呼ばれる）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isBlockedPath } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_lib/blocked-paths.js')).href);
const mw = await import(pathToFileURL(path.join(ROOT, 'functions/_middleware.js')).href);
const routes = JSON.parse(fs.readFileSync(path.join(ROOT, '_routes.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// _routes.json の照合（Cloudflare Pages の仕様: `/xxx/*` は配下すべて・それ以外は完全一致。exclude が include に優先）
const matches = (pattern, p) => (pattern.endsWith('/*') ? p.startsWith(pattern.slice(0, -1)) : p === pattern);
const viaFunction = (p) => routes.include.some((pt) => matches(pt, p)) && !routes.exclude.some((pt) => matches(pt, p));

// -z（NUL区切り）で読む。区切りなしだと日本語のファイル名（docs/現場向け….md）が \347… のようにクォートされ、
//   検査の対象から事実上外れてしまう
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
ok('追跡中のファイル名が読める（日本語のファイル名を含む）', tracked.length > 100 && tracked.some((f) => /[^\x00-\x7f]/.test(f)) && !tracked.some((f) => f.startsWith('"')));

console.log('\n=== 単体: 拒否するパス（開発用ファイル）と、配信するパス（アプリ） ===');
const mustBlock = ['/CLAUDE.md', '/README.md', '/schema.sql', '/wrangler.toml', '/.dev.vars', '/.dev.vars.example', '/.gitignore',
  '/_headers', '/_routes.json', '/tests/e2e.mjs', '/tests/package.json', '/docs/guide.md', '/scripts/make-icons.mjs',
  '/functions/api/_lib/auth.js', '/.github/workflows/e2e.yml', '/.git/config', '/.wrangler/state', '/node_modules/x/index.js', '/package.json'];
ok('開発用ファイルは拒否される', mustBlock.every((p) => isBlockedPath(p)), mustBlock.filter((p) => !isBlockedPath(p)).join(' '));
const mustServe = ['/', '/index.html', '/sw.js', '/manifest.json', '/js/api.js', '/js/vendor/qrcode.mjs', '/css/style.css', '/icons/icon-192.png',
  '/pages/parts', '/pages/parts.html', '/electrical/', '/electrical', '/api/me', '/api/files/12', '/.well-known/x'];
ok('アプリが使うパスは許可される', mustServe.every((p) => !isBlockedPath(p)), mustServe.filter((p) => isBlockedPath(p)).join(' '));

console.log('\n=== 単体: 抜け道（実測で本物のファイルが返った書き方）を塞ぐ ===');
const tricks = ['//schema.sql', '///schema.sql', '/%43LAUDE.md', '/sch%65ma.sql', '/%2e%2e/schema.sql', '/js/..%2fschema.sql', '/js/%2e%2e%2fschema.sql',
  '/js/../schema.sql', '/./schema.sql', '/%252e%252e/schema.sql', '/api/%2e%2e/schema.sql', '/js\\..\\schema.sql', '/schema.sql/', '/SCHEMA.SQL', '/%zz', '/js/\0x'];
ok('連続スラッシュ・%エンコード・二重エンコード・../・バックスラッシュ・大文字違いでも拒否される', tricks.every((p) => isBlockedPath(p)), tricks.filter((p) => !isBlockedPath(p)).join(' '));

console.log('\n=== 単体: リポジトリの全ファイルの分類 ===');
const servedRoots = new Set(['index.html', 'sw.js', 'manifest.json']);
const staticDirs = ['js/', 'css/', 'icons/', 'pages/', 'electrical/'];
const SERVABLE_EXT = new Set(['.js', '.mjs', '.css', '.html', '.png']);
const unclassified = [];
for (const f of tracked) {
  const p = `/${f}`;
  const isApp = servedRoots.has(f) || staticDirs.some((d) => f.startsWith(d));
  if (isApp && isBlockedPath(p)) unclassified.push(`アプリのファイルが拒否される: ${f}`);
  if (!isApp && !isBlockedPath(p) && !f.startsWith('functions/api/')) unclassified.push(`アプリの外のファイルが配信される: ${f}`);
}
ok('追跡中の全ファイルが「アプリ（配信）」か「開発用（拒否）」に分類されている（新しいファイルを足したらここで気づく）', unclassified.length === 0, unclassified.join(' / '));
const blockedFiles = tracked.filter((f) => isBlockedPath(`/${f}`));
const leaked = blockedFiles.filter((f) => !viaFunction(`/${f}`));
ok(`拒否するファイル（${blockedFiles.length}件）は、すべて Functions を通る（_routes.json の exclude に紛れて静的配信されない）`, blockedFiles.length > 10 && leaked.length === 0, leaked.join(' '));
// 静的配信のまま（Functions を通さない）にするのは、HTML ページ・css・アイコン・ホーム・sw.js・manifest.json。
//   ヘッダー（CSP など）を静的配信側に任せたいため。除外は必ず「ファイル名の完全一致」（フォルダ単位 `/js/*` は
//   `/js/..%2fschema.sql` で本物のファイルが返る抜け道になることを実測で確認済み）
ok('除外（静的配信のまま）はファイル名の完全一致だけで、フォルダ単位（/*）を使わない', routes.exclude.every((pt) => !pt.includes('*')), routes.exclude.filter((pt) => pt.includes('*')).join(' '));
ok('除外したパスはすべて許可されるパス（拒否と矛盾しない）', routes.exclude.every((pt) => !isBlockedPath(pt)), routes.exclude.filter((pt) => isBlockedPath(pt)).join(' '));
const pageFiles = tracked.filter((f) => f.startsWith('pages/') && f.endsWith('.html'));
const pageMissing = pageFiles.filter((f) => viaFunction(`/pages/${path.basename(f, '.html')}`));
ok(`HTML ページ（${pageFiles.length}件）・css・アイコン・ホーム・sw.js・manifest.json は静的配信のまま（新しいページを足したら _routes.json の exclude にも足す）`,
  pageFiles.length > 10 && pageMissing.length === 0 && ['/', '/sw.js', '/manifest.json', '/css/style.css', '/icons/icon-192.png'].every((p) => !viaFunction(p)), pageMissing.join(' '));
ok('/api/* と /electrical/* と JS は Functions を通る（API・CSPの上書き・許可リスト判定が動く）', viaFunction('/api/me') && viaFunction('/electrical/') && viaFunction('/js/api.js') && viaFunction('/js/..%2fschema.sql'));
ok(`ルール数が Cloudflare Pages の上限（include と exclude の合計100）に十分余裕がある（現在 ${routes.include.length + routes.exclude.length}件）`, routes.include.length + routes.exclude.length <= 90);
ok('静的フォルダ（js・css・icons・pages）には、配信してよい種類のファイルしか無い（メモ・SQL・設定などが紛れていない）',
  tracked.filter((f) => ['js/', 'css/', 'icons/', 'pages/'].some((d) => f.startsWith(d))).every((f) => SERVABLE_EXT.has(path.extname(f))),
  tracked.filter((f) => ['js/', 'css/', 'icons/', 'pages/'].some((d) => f.startsWith(d)) && !SERVABLE_EXT.has(path.extname(f))).join(' '));

console.log('\n=== 単体: ミドルウェア ===');
const call = async (url) => {
  let nextCalled = false;
  const res = await mw.onRequest({ request: new Request(`http://x${url}`), next: async () => { nextCalled = true; return new Response('app', { status: 200 }); } });
  return { status: res.status, nextCalled, ct: res.headers.get('Content-Type'), cache: res.headers.get('Cache-Control') };
};
let r = await call('/schema.sql');
ok('拒否パスは 404（次へ進まない・キャッシュさせない）', r.status === 404 && !r.nextCalled && /text\/plain/.test(r.ct) && r.cache === 'no-store', JSON.stringify(r));
r = await call('//schema.sql');
ok('連続スラッシュの抜け道も 404', r.status === 404 && !r.nextCalled);
r = await call('/api/me');
ok('許可パスは次へ進む（API は従来どおり）', r.status === 200 && r.nextCalled);
r = await call('/CLAUDE.md?x=1');
ok('クエリ文字列を付けても 404', r.status === 404);

console.log(`\n========== 単体（配信ファイルの保護）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
