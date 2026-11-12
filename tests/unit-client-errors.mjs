// 単体テスト: 画面エラーの自動記録（functions/api/client-errors/index.js・js/client-error-group.js）。
//   実行: node --experimental-sqlite unit-client-errors.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = await import(pathToFileURL(path.join(ROOT, 'functions/api/client-errors/index.js')).href);
const { groupClientErrors, deviceLabel } = await import(pathToFileURL(path.join(ROOT, 'js/client-error-group.js')).href);

const sqlite = new DatabaseSync(':memory:');
// 表が無い古いDBを想定（schema.sql の client_error_log だけ流さない）＝ API が自分で作ることを確かめる
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (!t || /client_error_log/.test(t)) continue;
  try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
});
const db = { prepare: (sql) => wrap(sql) };
sqlite.exec(`UPDATE users SET email = 'admin@x', name = '管理 太郎'`);
const admin = { email: 'admin@x', role: 'admin' };
const viewer = { email: 'viewer@x', role: 'viewer' };

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 画面エラーの自動記録 ===');

const post = async (body, user = viewer, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)') => {
  const res = await api.onRequestPost({
    request: new Request('http://x/api/client-errors', { method: 'POST', headers: { 'User-Agent': ua }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    env: { DB: db }, data: { user },
  });
  return { status: res.status, json: await res.json() };
};
const list = async (user = admin) => {
  const res = await api.onRequestGet({ env: { DB: db }, data: { user } });
  return { status: res.status, json: await res.json() };
};

let r = await post({ kind: 'js', message: 'x is not defined', source: '/js/parts.js:10:5', stack: 'ReferenceError: x\n at a', page: '/pages/parts?id=3&q=secret#frag', version: 'v1.68.0' });
ok('閲覧のみのユーザーでも記録できる（表が無ければ自動で作る）', r.status === 201 && r.json.saved === true, JSON.stringify(r));
let rows = (await list()).json.errors;
ok('内容・場所・版・端末・記録者が保存される', rows.length === 1 && rows[0].message === 'x is not defined' && rows[0].source === '/js/parts.js:10:5'
  && rows[0].app_version === 'v1.68.0' && /iPhone/.test(rows[0].user_agent) && rows[0].created_by === 'viewer@x', JSON.stringify(rows[0]));
ok('ページはパスだけ保存する（クエリ・ハッシュは落とす）', rows[0].page === '/pages/parts');

ok('不正なJSONは400', (await post('{')).status === 400);
ok('kind が不正なら400', (await post({ kind: 'evil', message: 'm' })).status === 400);
ok('message が空なら400', (await post({ kind: 'js', message: '  ' })).status === 400);
ok('未ログインは401', (await post({ kind: 'js', message: 'm' }, null)).status === 401);
ok('一覧は管理者だけ（閲覧のみは403）', (await list(viewer)).status === 403);

await post({ kind: 'api', message: 'あ'.repeat(900), source: 's'.repeat(900), stack: 't'.repeat(5000) }, admin, 'u'.repeat(900));
const long = (await list()).json.errors.find((e) => e.kind === 'api');
ok('長すぎる値は切り詰める', long.message.length === 500 && long.source.length === 300 && long.stack.length === 2000 && long.user_agent.length === 300);
ok('記録者の名前が付く', long.user_name === '管理 太郎');

// 1人あたり1時間の上限
for (let i = 0; i < api.MAX_PER_HOUR + 5; i++) await post({ kind: 'js', message: `loop ${i}` });
const mine = sqlite.prepare(`SELECT COUNT(*) AS n FROM client_error_log WHERE created_by = 'viewer@x'`).get().n;
ok(`1人あたり1時間 ${api.MAX_PER_HOUR} 件まで（超えた分は保存しない）`, mine === api.MAX_PER_HOUR, String(mine));
r = await post({ kind: 'js', message: 'over' });
ok('上限を超えてもエラーにはしない（画面を止めない）', r.status === 200 && r.json.saved === false && r.json.limited === true);
ok('別の人は上限に影響されない', (await post({ kind: 'js', message: 'other' }, admin)).status === 201);

// 90日より古い記録は消える（次の保存のときに1時間に1回）
sqlite.prepare(`INSERT INTO client_error_log (kind, message, created_by, created_at) VALUES ('js', 'old', 'old@x', ?)`)
  .run(new Date(Date.now() - 91 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
sqlite.prepare(`INSERT INTO client_error_log (kind, message, created_by, created_at) VALUES ('js', 'keep', 'old@x', ?)`)
  .run(new Date(Date.now() - 89 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
const realNow = Date.now;
Date.now = () => realNow() + 3601_000; // 1時間後（前回の掃除から時間が経った想定）
await post({ kind: 'js', message: 'trigger prune' }, { email: 'p@x', role: 'editor' });
Date.now = realNow;
const msgs = sqlite.prepare(`SELECT message FROM client_error_log WHERE created_by = 'old@x'`).all().map((x) => x.message);
ok('90日より古い記録だけが消える', msgs.length === 1 && msgs[0] === 'keep', msgs.join(','));

// ---- まとめ表示 ----
ok('端末の種類', deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)') === 'iPhone' && deviceLabel('Mozilla/5.0 (Windows NT 10.0)') === 'Windows PC' && deviceLabel('') === '');
const groups = groupClientErrors([
  { kind: 'js', message: 'A', source: 's', page: '/p', created_at: '2026-11-12T03:00:00Z', created_by: 'a@x', user_name: '田中', user_agent: 'iPhone', app_version: 'v1.68.0', stack: null },
  { kind: 'js', message: 'A', source: 's', page: '/p', created_at: '2026-11-12T02:00:00Z', created_by: 'b@x', user_name: null, user_agent: 'Windows NT', app_version: 'v1.67.0', stack: 'st' },
  { kind: 'js', message: 'A', source: 's', page: '/other', created_at: '2026-11-12T01:00:00Z', created_by: 'a@x', user_name: '田中', user_agent: 'iPhone', app_version: 'v1.68.0' },
]);
ok('同じエラー（種類・内容・場所・ページ）を1行にまとめる', groups.length === 2 && groups[0].count === 2 && groups[1].count === 1);
ok('最後・最初の日時、起きた人・端末・版をまとめる', groups[0].last_at === '2026-11-12T03:00:00Z' && groups[0].first_at === '2026-11-12T02:00:00Z'
  && [...groups[0].users].join() === '田中,b@x' && [...groups[0].devices].join() === 'iPhone,Windows PC' && groups[0].versions.size === 2 && groups[0].stack === 'st');
ok('空でも落ちない', groupClientErrors(null).length === 0);

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail > 0) process.exit(1);
