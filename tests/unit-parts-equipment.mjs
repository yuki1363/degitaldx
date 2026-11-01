// 単体テスト: 部品と設備の複数紐づけ（functions/api/parts/[id]/equipment.js・parts/[id].js の GET・describeEquipmentLink）
//   実行: node --experimental-sqlite unit-parts-equipment.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const eqApi = await load('functions/api/parts/[id]/equipment.js');
const partApi = await load('functions/api/parts/[id].js');
const lib = await load('functions/api/_lib/equipment-link.js');

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a.map((x) => (x === undefined ? null : x))),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  _exec() {
    const s = sqlite.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: s.all(...args), meta: { changes: 0 } };
    const r = s.run(...args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const db = {
  prepare: (sql) => wrap(sql),
  async batch(list) {
    sqlite.exec('BEGIN');
    try { const out = list.map((s) => s._exec()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const q = (sql, ...a) => sqlite.prepare(sql).get(...a);
const user = (role = 'editor') => ({ email: `${role}@x`, role });
const post = (partId, body, role) => eqApi.onRequestPost({ env: { DB: db }, data: { user: user(role) }, params: { id: String(partId) }, request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) });
const del = (partId, eqId, role) => eqApi.onRequestDelete({ env: { DB: db }, data: { user: user(role) }, params: { id: String(partId) }, request: new Request(`http://x?equipment_id=${eqId}`, { method: 'DELETE' }) });
const get = async (partId) => (await (await partApi.onRequestGet({ env: { DB: db }, params: { id: String(partId) } })).json());
console.log('\n=== 単体: 部品と設備の複数紐づけ ===');

sqlite.exec(`INSERT INTO equipment_ledger (code, name, line_name, equipment_name, created_by) VALUES
  ('01-01', '充填機 ポンプ', '充填機', 'ポンプ', 't'), ('02-01', '搬送 コンベア', '搬送', 'コンベア', 't'),
  ('03-01', '包装機', '包装', 'モーター', 't'), ('03-02', '包装機2', '包装', 'モーター', 't')`);
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by) VALUES
  ('p1', 'ベアリング', '充填機', 'ポンプ', 5, 't'),
  ('p2', 'ベルト', '包装', 'モーター', 5, 't'),
  ('p3', 'ボルト', '知らない設備', '機器', 5, 't'),
  ('p4', '名前なし', NULL, NULL, 5, 't')`);

// 紐づけ状況の表示
let d = await get(1);
ok('主な設備: 名前が台帳の1件に一致すれば linked で、equipment_links の先頭（primary）になる', d.equipment_status === 'linked' && d.equipment_links[0]?.id === 1 && d.equipment_links[0].kind === 'primary', JSON.stringify(d.equipment_links));
d = await get(2);
ok('同名の設備が複数なら ambiguous（以前は先頭の1件を返していた）。主な設備は決めない', d.equipment_status === 'ambiguous' && d.equipment === null && d.equipment_links.length === 0, JSON.stringify([d.equipment_status, d.equipment]));
ok('台帳に無い名前は unmatched、名前が空は none', (await get(3)).equipment_status === 'unmatched' && (await get(4)).equipment_status === 'none');

// 追加
let r = await post(1, { equipment_id: 2 });
ok('設備を追加できる（201）', r.status === 201 && q('SELECT COUNT(*) n FROM parts_equipment WHERE part_id=1 AND deleted_at IS NULL').n === 1);
d = await get(1);
ok('追加した設備が equipment_links に extra として出る（主な設備と並ぶ）', d.equipment_links.map((e) => `${e.id}:${e.kind}`).join() === '1:primary,2:extra', JSON.stringify(d.equipment_links));
r = await post(1, { equipment_id: 2 });
ok('同じ設備の二重追加は何もしない（duplicate・行は増えない）', (await r.json()).duplicate === true && q('SELECT COUNT(*) n FROM parts_equipment WHERE part_id=1').n === 1);
r = await post(1, { equipment_id: 1 });
ok('主な設備と同じ設備は追加できない（409）', r.status === 409);
ok('存在しない設備・部品・不正な値', (await post(1, { equipment_id: 999 })).status === 404 && (await post(999, { equipment_id: 2 })).status === 404 && (await post(1, { equipment_id: 'x' })).status === 400);
ok('閲覧のみは追加できない（403）', (await post(1, { equipment_id: 3 }, 'viewer')).status === 403);
ok('追加は監査ログに残る（誰が・どの設備を）', (() => { const a = q(`SELECT changed_by c, diff_json d FROM audit_log WHERE table_name='parts_inventory' AND record_id=1 ORDER BY id DESC LIMIT 1`); return a?.c === 'editor@x' && /equipment_link_added/.test(a.d) && /02-01/.test(a.d); })());

// 外す
ok('主な設備は外せない（400）', (await del(1, 1)).status === 400);
ok('閲覧のみは外せない（403）', (await del(1, 2, 'viewer')).status === 403);
r = await del(1, 2);
ok('外せる。行は削除せず論理削除（deleted_at・deleted_by）', r.status === 200 && q('SELECT deleted_at a, deleted_by b FROM parts_equipment WHERE part_id=1 AND equipment_id=2').a !== null && q('SELECT deleted_by b FROM parts_equipment WHERE part_id=1').b === 'editor@x');
ok('外したあとは equipment_links から消える。外していない設備は残る', (await get(1)).equipment_links.map((e) => e.id).join() === '1');
ok('外した設備をもう一度外すと404', (await del(1, 2)).status === 404);
r = await post(1, { equipment_id: 2 });
ok('外した設備を再度追加すると、新しい行を作らず復活させる', r.status === 201 && q('SELECT COUNT(*) n FROM parts_equipment WHERE part_id=1').n === 1 && q('SELECT deleted_at a FROM parts_equipment WHERE part_id=1').a === null);

// 複数の部品・複数の設備
await post(3, { equipment_id: 2 }); await post(3, { equipment_id: 4 });
ok('台帳に無い名前の部品でも、設備を追加して紐づけられる（複数も可）', (await get(3)).equipment_links.map((e) => e.id).join() === '2,4', JSON.stringify((await get(3)).equipment_links));
sqlite.exec(`UPDATE equipment_ledger SET deleted_at='2026-01-01T00:00:00Z' WHERE id=4`);
ok('削除済みの設備は一覧に出さない', (await get(3)).equipment_links.map((e) => e.id).join() === '2');

// describeEquipmentLink
sqlite.exec(`UPDATE parts_inventory SET equipment_id = 3 WHERE id = 2`);
const dsc = await lib.describeEquipmentLink(db, q('SELECT * FROM parts_inventory WHERE id=2'));
ok('equipment_id が入っていれば、同名が複数でもその設備に決まる', dsc.status === 'linked' && dsc.equipment.id === 3);

console.log(`\n========== 単体（部品と設備の複数紐づけ）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
