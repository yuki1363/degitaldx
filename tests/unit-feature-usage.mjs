// 単体テスト: 機能別の利用状況（functions/api/admin/feature-usage.js）。実行: node --experimental-sqlite unit-feature-usage.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { onRequestGet, FEATURE_LABELS } = await import(pathToFileURL(path.join(ROOT, 'functions/api/admin/feature-usage.js')).href);

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
});
const db = { prepare: (sql) => wrap(sql) };
const call = async (qs = '', role = 'admin') => {
  const res = await onRequestGet({ request: new Request(`http://x/api/admin/feature-usage${qs}`), env: { DB: db }, data: { user: { email: 'a@x', role } } });
  return { status: res.status, json: await res.json() };
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 機能別の利用状況 ===');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ins = sqlite.prepare(`INSERT INTO audit_log (table_name, record_id, action, changed_by, changed_at, diff_json) VALUES (?, 1, ?, ?, ?, '{}')`);
// トラブル: 10日前に作成2・更新1（2人）、100日前に1件。部品: 5日前に更新3。未知のテーブル: 3日前に1件
ins.run('trouble_record', 'create', 'a@x', iso(10)); ins.run('trouble_record', 'create', 'b@x', iso(10)); ins.run('trouble_record', 'update', 'a@x', iso(9));
ins.run('trouble_record', 'create', 'a@x', iso(100));
for (let i = 0; i < 3; i++) ins.run('parts_inventory', 'update', 'b@x', iso(5));
ins.run('some_new_table', 'create', 'c@x', iso(3));
ins.run('trouble_record', 'delete', 'a@x', iso(2));

let r = (await call('?days=30')).json;
const tr = r.features.find((f) => f.key === 'trouble_record');
ok('機能ごとに登録・更新・削除を数える（期間外の100日前は含めない）', tr.create === 2 && tr.update === 1 && tr.delete === 1 && tr.total === 4, JSON.stringify(tr));
ok('期間を広げると古い分も数える', (await call('?days=365')).json.features.find((f) => f.key === 'trouble_record').total === 5);
ok('操作した人数は実人数（a・b・c の3人）', r.active_users === 3, String(r.active_users));
ok('多い順に並ぶ（トラブル4件 → 部品3件）', r.features[0].key === 'trouble_record' && r.features[1].key === 'parts_inventory');
ok('未知のテーブルは「その他」にまとめる', r.features.find((f) => f.key === '__other')?.total === 1 && r.features.find((f) => f.key === '__other').label === 'その他');
ok('期間内に一度も使われていない主要機能も 0 件で並ぶ', r.features.find((f) => f.key === 'daily_report')?.total === 0 && r.features.length >= Object.keys(FEATURE_LABELS).length);
ok('最終操作の日時が入る', !!tr.last_at && r.features.find((f) => f.key === 'daily_report').last_at === null);
ok('個人ごとの操作数は返さない（人数だけ）', !JSON.stringify(r).includes('@x'));
ok('days は 1〜366 に丸める（0・負・巨大・不正）', [(await call('?days=0')).json.days, (await call('?days=-5')).json.days, (await call('?days=99999')).json.days, (await call('?days=abc')).json.days].join() === '30,1,366,30');
ok('admin 以外は403', (await call('', 'editor')).status === 403 && (await call('', 'viewer')).status === 403);

console.log(`\n========== 単体（機能別の利用状況）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
