// 単体テスト: 部品CSV取込の差分マージ（functions/api/parts/import.js）
//   同じ型番を別のライン・機器で別々に登録している部品（設計上ありうる）を、取り込みで取り違えない・
//   黙って捨てないことを確かめる。実行: node --experimental-sqlite unit-parts-import.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = await import(pathToFileURL(path.join(ROOT, 'functions/api/parts/import.js')).href);

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, norm(a)),
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
const run = async (rows, mode = 'merge', role = 'admin') => {
  const res = await imp.onRequestPost({ env: { DB: db }, data: { user: { email: `${role}@x`, role } }, request: new Request('http://x', { method: 'POST', body: JSON.stringify({ rows, mode }) }) });
  return { status: res.status, ...(await res.json()) };
};
const part = (id) => sqlite.prepare('SELECT id, model_no, name, line_name, equipment_name, quantity, location, deleted_at FROM parts_inventory WHERE id = ?').get(id);
const live = () => sqlite.prepare('SELECT COUNT(*) AS n FROM parts_inventory WHERE deleted_at IS NULL').get().n;

console.log('\n=== 単体: 同じ型番を別のライン・機器で使う部品の取り込み ===');
sqlite.exec(`INSERT INTO parts_inventory (part_no, model_no, name, line_name, equipment_name, quantity, location, created_by) VALUES
  ('a', 'BRG-6205', 'ベアリング', '充填機', 'ポンプ', 5, 'A棚', 't'),
  ('b', 'BRG-6205', 'ベアリング', '包装機', 'モーター', 7, 'B棚', 't'),
  ('c', 'BLT-100',  'ベルト',     '搬送',   'コンベア', 3, 'C棚', 't')`);

// 1) 設備名・機器名も対応付けた取り込み → 一致する部品だけが更新される（取り違えない）
let r = await run([
  { name: 'ベアリング', model_no: 'BRG-6205', line_name: '充填機', equipment_name: 'ポンプ', quantity: '10' },
  { name: 'ベアリング', model_no: 'BRG-6205', line_name: '包装機', equipment_name: 'モーター', quantity: '20' },
]);
ok('同じ型番の2行が、それぞれ設備名・機器名の一致する部品を更新する（2件とも取り込まれる）', r.updated === 2 && r.inserted === 0 && r.skipped === 0, JSON.stringify(r));
ok('充填機のベアリングは10、包装機のベアリングは20（取り違えない）', part(1).quantity === 10 && part(2).quantity === 20, JSON.stringify([part(1), part(2)]));
ok('在庫数の変更は入出庫履歴に「調整」として残る', sqlite.prepare(`SELECT COUNT(*) AS n FROM parts_transaction WHERE type = 'adjust'`).get().n === 2);

// 2) 設備名・機器名を対応付けない取り込み → 同じ型番が2件あるので決められない。黙って1件だけ更新しない
r = await run([{ name: 'ベアリング', model_no: 'BRG-6205', quantity: '99' }]);
ok('設備名・機器名が無く、同じ型番の部品が複数あるときは取り込まず、理由を返す', r.updated === 0 && r.inserted === 0 && r.skipped === 1 && /2件/.test(r.errors?.[0]?.reason || '') && r.errors[0].row === 1, JSON.stringify(r));
ok('その場合、どの部品も変更されない', part(1).quantity === 10 && part(2).quantity === 20);

// 3) 型番が1件だけなら、従来どおり型番だけで更新できる
r = await run([{ name: 'ベルト', model_no: 'BLT-100', quantity: '8' }]);
ok('型番が1件に決まるときは、設備名・機器名が無くても従来どおり更新する', r.updated === 1 && part(3).quantity === 8, JSON.stringify(r));

// 4) 同じ型番でも、設備名・機器名が既存のどれとも違えば、別のライン・機器の部品として新規追加
r = await run([{ name: 'ベアリング', model_no: 'BRG-6205', line_name: '検査機', equipment_name: 'ファン', quantity: '4' }]);
ok('設備名・機器名が既存のどれとも違う同じ型番は、別の部品として新規追加する', r.inserted === 1 && r.updated === 0 && live() === 4, JSON.stringify(r));

// 5) 同じ部品を指す行が1回の取り込みに2回出てきたら、2行目は取り込まず理由を返す
r = await run([
  { name: 'ベルト', model_no: 'BLT-100', quantity: '1' },
  { name: 'ベルト', model_no: 'BLT-100', quantity: '2' },
]);
ok('同じ部品を指す行が重なったら、2行目は飛ばして理由を返す（1行目が有効）', r.updated === 1 && r.skipped === 1 && /重複/.test(r.errors?.[0]?.reason || '') && r.errors[0].row === 2 && part(3).quantity === 1, JSON.stringify({ r, q: part(3).quantity }));

// 6) 対応付けていない列は、更新しても消えない（従来の保証）
r = await run([{ name: 'ベルト', model_no: 'BLT-100' }]);
ok('対応付けていない列（在庫場所・在庫数など）は更新しても元の値のまま', r.updated === 1 && part(3).location === 'C棚' && part(3).quantity === 1, JSON.stringify(part(3)));

// 7) 型番が空の行は常に新規追加
const n0 = live();
r = await run([{ name: '型番なし部品A' }, { name: '型番なし部品A' }]);
ok('型番が空の行は、重複判定せず常に新規追加', r.inserted === 2 && live() === n0 + 2, JSON.stringify(r));

// 8) 全置き換えは、サーバー側では行を捨てない（同じ型番でも別ラインなら両方作る）。editor は 403
r = await run([
  { name: 'ベアリング', model_no: 'BRG-6205', line_name: '充填機', equipment_name: 'ポンプ' },
  { name: 'ベアリング', model_no: 'BRG-6205', line_name: '包装機', equipment_name: 'モーター' },
], 'replace');
ok('全置き換え: 同じ型番・別ラインの2行が両方とも作られる', r.inserted === 2 && live() === 2, JSON.stringify(r));
r = await run([{ name: 'x' }], 'replace', 'editor');
ok('全置き換えは管理者だけ（editor は 403）', r.status === 403);

console.log(`\n========== 単体（部品CSV取込）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
