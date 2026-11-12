// 単体テスト: バックアップの取り忘れ防止（functions/api/admin/backup.js の記録・backup-status.js）。
//   実行: node --experimental-sqlite unit-backup-status.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backup = await import(pathToFileURL(path.join(ROOT, 'functions/api/admin/backup.js')).href);
const status = await import(pathToFileURL(path.join(ROOT, 'functions/api/admin/backup-status.js')).href);

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
});
const db = { prepare: (sql) => wrap(sql) };
const admin = { email: 'admin@x', role: 'admin', name: '管理者' };
sqlite.exec(`UPDATE users SET email = 'admin@x', name = '管理 太郎'`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: バックアップの取り忘れ防止 ===');

const getStatus = async (user = admin) => {
  const res = await status.onRequestGet({ env: { DB: db }, data: { user } });
  return { status: res.status, json: await res.json() };
};
const download = async (qs = '') => {
  const res = await backup.onRequestGet({ request: new Request(`http://x/api/admin/backup${qs}`), env: { DB: db }, data: { user: admin } });
  return res.text(); // 最後まで読む
};
const count = () => sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'backup'`).get().n;

let r = await getStatus();
ok('記録が無いときは last=null・overdue=true', r.json.last === null && r.json.overdue === true && r.json.remind_days === 35, JSON.stringify(r.json));
ok('管理者以外は見られない（403）', (await getStatus({ email: 'e@x', role: 'editor' })).status === 403);

const jsonText = await download();
ok('JSON を最後まで取ると監査ログに1件残る', count() === 1 && JSON.parse(jsonText).tables.users.length === 1);
ok('その記録自体は今回のバックアップに入らない（読み終わってから書く）', !JSON.parse(jsonText).tables.audit_log.some((a) => a.table_name === 'backup'));
r = await getStatus();
ok('前回の日時・取った人の名前・形式が返る', r.json.last?.by === '管理 太郎' && r.json.last.format === 'json' && r.json.days_since === 0 && r.json.overdue === false, JSON.stringify(r.json));

await download('?format=sql');
ok('SQL でも記録される（形式は sql）', count() === 2 && (await getStatus()).json.last.format === 'sql');
await download('?purpose=csv');
ok('CSV(ZIP) 用の取得は記録しない', count() === 2);

// 途中で止めた（最後まで読まなかった）ダウンロードは記録しない
const partial = await backup.onRequestGet({ request: new Request('http://x/api/admin/backup'), env: { DB: db }, data: { user: admin } });
const reader = partial.body.getReader();
await reader.read();
await reader.cancel();
ok('途中でやめたダウンロードは記録しない', count() === 2);

// 経過日数と注意の境界（35日ちょうどは出さない・36日で出す）
const setLast = (daysAgo) => {
  sqlite.exec(`DELETE FROM audit_log WHERE table_name = 'backup'`);
  const at = new Date(Date.now() - daysAgo * 86400000 - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  sqlite.prepare(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changed_at, diff_json) VALUES ('backup', 0, 'create', 'gone@x', ?, '{"format":"sql"}')`).run(at);
};
setLast(35);
r = await getStatus();
ok('35日前は注意なし', r.json.days_since === 35 && r.json.overdue === false, JSON.stringify(r.json));
setLast(36);
r = await getStatus();
ok('36日前は注意あり', r.json.days_since === 36 && r.json.overdue === true);
ok('削除済みユーザーが取った記録はメールで表示', r.json.last.by === 'gone@x');

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail > 0) process.exit(1);
