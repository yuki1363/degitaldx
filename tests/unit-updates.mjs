// 単体テスト: 更新のお知らせ（js/updates.js）。実行: node unit-updates.mjs
//   sw.js の CACHE_VERSION を上げたのにお知らせを足し忘れる事故を防ぐ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const updSrc = fs.readFileSync(path.join(ROOT, 'js/updates.js'), 'utf8');
const { UPDATES, LATEST_VERSION } = await import(`data:text/javascript;base64,${Buffer.from(updSrc).toString('base64')}`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 更新のお知らせ ===');

const cache = /const CACHE_VERSION = 'v([\d.]+)'/.exec(swSrc)?.[1];
ok('先頭のお知らせの版が sw.js の CACHE_VERSION と同じ（版を上げたらお知らせも足す）', UPDATES[0].version === cache, `updates=${UPDATES[0].version} sw=${cache}`);
ok('LATEST_VERSION は先頭の版', LATEST_VERSION === UPDATES[0].version);
ok('各お知らせに 版・日付(YYYY-MM-DD)・見出し・1件以上の項目がある',
  UPDATES.every((u) => /^\d+\.\d+\.\d+$/.test(u.version) && /^\d{4}-\d{2}-\d{2}$/.test(u.date) && u.title && Array.isArray(u.items) && u.items.length > 0));
const vkey = (v) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
ok('新しい順（版が降順）で、版の重複がない', UPDATES.every((u, i) => i === 0 || vkey(UPDATES[i - 1].version) > vkey(u.version)));
ok('sw.js のキャッシュ対象に 更新のお知らせ・更新履歴ページがある（オフラインでもホームが動く）', ['/js/updates.js', '/js/update-notice.js', '/js/updates-page.js', '/pages/updates'].every((u) => swSrc.includes(`'${u}'`)));

console.log(`\n========== 単体（更新のお知らせ）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
