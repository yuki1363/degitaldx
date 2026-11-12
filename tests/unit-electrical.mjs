// 単体テスト: 電気設備点検の異常 → 通知・横断検索（functions/api/electrical-inspections・search）
//   実行: node --experimental-sqlite unit-electrical.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const elec = await load('functions/api/electrical-inspections/index.js');
const search = await load('functions/api/search/index.js');

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
sqlite.exec(`INSERT INTO users (email, name, role, created_by) VALUES ('ed@x','入力者','editor','t')`);
const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, norm(a)),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args), meta: {} }; },
  async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  _exec() {
    const s = sqlite.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: s.all(...args), meta: { changes: 0 } };
    const r = s.run(...args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const db = { prepare: (sql) => wrap(sql), async batch(l) { sqlite.exec('BEGIN'); try { const o = l.map((s) => s._exec()); sqlite.exec('COMMIT'); return o; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
const user = { id: 1, email: 'ed@x', name: '入力者', role: 'editor' };
const post = async (rec) => {
  const res = await elec.onRequestPost({ request: new Request('http://x', { method: 'POST', body: JSON.stringify(rec) }), env: { DB: db }, data: { user }, waitUntil() {} });
  return { status: res.status, json: await res.json() };
};
const find = async (qs) => {
  const res = await search.onRequestGet({ request: new Request(`http://x/api/search?${qs}`), env: { DB: db }, data: { user }, waitUntil() {} });
  return (await res.json()).results.filter((r) => r.type === 'electrical');
};
const notifs = () => sqlite.prepare(`SELECT * FROM notifications ORDER BY id`).all();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// 点検項目の設定スナップショット（全記録に同じ内容が入る。検索の対象にしてはいけない）
const config = [{ id: 'c1', name: 'ゲージ圧力確認項目', measurements: [{ key: 'm1', label: 'ユニークな測定名ZZZ' }] }];
const rec = (over) => ({ id: '1000', equipmentType: 'battery', date: '2026-10-05', inspector: '山田太郎', facility: '第一変電室', statuses: { a: 'good', b: 'good' }, remarks: '異常なし', repairNotes: '', categoryRemarks: { c1: '' }, config, ...over });

console.log('\n=== 単体: 異常のある記録を保存すると通知する ===');
let r = await post(rec({ id: '1000' }));
ok('異常なし（良好のみ）の保存では通知しない', r.status === 201 && notifs().length === 0, JSON.stringify(notifs()));
r = await post(rec({ id: '1001', equipmentType: 'battery', date: '2026-10-06', statuses: { a: 'caution', b: 'repair', c: 'good' }, repairNotes: '端子の腐食あり' }));
let n = notifs();
ok('要注意・要修理を含む記録を新規保存すると通知が1件できる', r.status === 201 && n.length === 1 && n[0].type === 'inspection_abnormal', JSON.stringify(n));
ok('通知: 見出しに設備種別と日付、本文に件数（要修理1件・要注意1件）', /蓄電池/.test(n[0].title) && /2026-10-06/.test(n[0].title) && n[0].body.startsWith('要修理1件・要注意1件'), `${n[0].title} / ${n[0].body}`);
ok('通知: 要修理を含むので level は alert。リンクは記録を開く /electrical/#record=ID、関連テーブルも入る', n[0].level === 'alert' && n[0].link_url === '/electrical/#record=1001' && n[0].related_table === 'electrical_inspection' && n[0].related_id === r.json.id && n[0].created_by === 'ed@x', JSON.stringify(n[0]));

r = await post(rec({ id: '1001', equipmentType: 'battery', date: '2026-10-06', statuses: { a: 'caution', b: 'repair', c: 'good' }, remarks: '追記' }));
ok('異常のままの再保存では通知を繰り返さない', r.status === 200 && notifs().length === 1);
await post(rec({ id: '1001', equipmentType: 'battery', date: '2026-10-06', statuses: { a: 'good', b: 'good', c: 'good' } }));
ok('異常を直して再保存しても通知は増えない', notifs().length === 1);
await post(rec({ id: '1001', equipmentType: 'battery', date: '2026-10-06', statuses: { a: 'caution', b: 'good', c: 'good' } }));
n = notifs();
ok('直した後で、また異常になったときは新しく通知する（要注意のみ → level は warning）', n.length === 2 && n[1].level === 'warning' && n[1].body.startsWith('要注意1件'), JSON.stringify(n[1]));
ok('N/A・良好だけの記録は異常扱いにしない', elec.computeHasAbnormal({ a: 'na', b: 'good' }) === 0 && elec.computeHasAbnormal({ a: 'repair' }) === 1);

console.log('\n=== 単体: 横断検索で電気設備点検を探せる ===');
await post(rec({ id: '2000', equipmentType: 'main', date: '2026-09-01', inspector: '佐藤花子', facility: '本館', remarks: '碍子の清掃を実施', statuses: { a: 'good' } }));
await post(rec({ id: '2001', equipmentType: 'generator', date: '2026-08-15', inspector: '鈴木一郎', facility: '別館', remarks: '燃料補給', statuses: { a: 'good' } }));
let rs = await find('q=' + encodeURIComponent('佐藤'));
ok('点検者名で見つかる。結果から記録の詳細（/electrical/#record=ID）へ飛べる', rs.length === 1 && rs[0].url === '/electrical/#record=2000' && /高圧受電設備/.test(rs[0].title) && rs[0].date === '2026-09-01', JSON.stringify(rs));
rs = await find('q=' + encodeURIComponent('碍子'));
ok('備考の語で見つかる', rs.length === 1 && rs[0].id === '2000');
await post(rec({ id: '3000', equipmentType: 'main', date: '2026-10-20', inspector: '高橋', statuses: { a: 'repair' }, repairNotes: '端子の腐食あり' }));
rs = await find('q=' + encodeURIComponent('腐食'));
ok('要修理メモの語で見つかり、スニペットに「⚠異常あり」が付く', rs.length === 1 && rs[0].id === '3000' && /⚠異常あり/.test(rs[0].snippet) && /腐食/.test(rs[0].snippet), JSON.stringify(rs));
rs = await find('q=' + encodeURIComponent('蓄電池'));
ok('設備種別の名称（蓄電池）で、その種別の記録が見つかる（高圧・発電機は出ない）', rs.length >= 1 && rs.every((x) => /蓄電池/.test(x.title)), JSON.stringify(rs.map((x) => x.title)));
rs = await find('q=' + encodeURIComponent('ゲージ圧力確認項目'));
ok('点検項目の設定スナップショット（全記録に入っている語）では全件ヒットしない', rs.length === 0, `n=${rs.length}`);
rs = await find('q=' + encodeURIComponent('ユニークな測定名ZZZ'));
ok('測定名のスナップショットでもヒットしない', rs.length === 0);
rs = await find('q=' + encodeURIComponent('山田') + '&from=2026-10-01&to=2026-10-31');
ok('期間（点検日）で絞り込める', rs.length >= 1 && rs.every((x) => x.date >= '2026-10-01' && x.date <= '2026-10-31'));
rs = await find('q=' + encodeURIComponent('山田') + '&from=2026-11-01');
ok('期間外なら出ない', rs.length === 0);
rs = await find('q=' + encodeURIComponent('佐藤') + '&type=repair');
ok('種別を絞ったとき（トラブル等のみ）は電気設備点検を検索しない', rs.length === 0);
sqlite.exec(`UPDATE electrical_inspection SET deleted_at = '2026-11-01T00:00:00Z', deleted_by = 'x' WHERE client_id = '2000'`);
rs = await find('q=' + encodeURIComponent('佐藤'));
ok('削除した記録は検索に出ない', rs.length === 0);
rs = await find('q=' + encodeURIComponent('%'));
ok('「%」はワイルドカードではなく文字として探す（全件ヒットにならない）', rs.length === 0, `n=${rs.length}`);

console.log(`\n========== 単体（電気設備点検の通知・検索）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
