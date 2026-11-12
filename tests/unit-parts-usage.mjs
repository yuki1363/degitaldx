// 単体テスト: 部品の使用実績（functions/api/_lib/parts-usage.js）。実行: node --experimental-sqlite unit-parts-usage.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { recentMonths, buildUsage, loadPartUsage } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_lib/parts-usage.js')).href);

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

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 部品の使用実績 ===');

const months = recentMonths('2026-11-12');
ok('今月を含む12か月（古い順・年をまたぐ）', months.length === 12 && months[0] === '2025-12' && months[11] === '2026-11', months.join(','));
ok('1月でも前年へ正しくさかのぼる', recentMonths('2026-01-31')[0] === '2025-02' && recentMonths('2026-01-31')[11] === '2026-01');

const u0 = buildUsage([], '2026-11-12');
ok('出庫が無ければ12か月すべて0・合計0・平均0', u0.months.every((m) => m.out === 0) && u0.total_out === 0 && u0.avg_out === 0);
const u1 = buildUsage([{ month: '2026-11', qty: 5 }, { month: '2026-01', qty: 2 }, { month: '2020-01', qty: 99 }], '2026-11-12');
ok('月ごとに入れ、範囲外の月は捨てる（合計7・月平均0.6）', u1.total_out === 7 && u1.avg_out === 0.6 && u1.months[11].out === 5 && u1.months[1].out === 2, JSON.stringify(u1));

sqlite.exec(`INSERT INTO parts_inventory (id, part_no, name, quantity, created_by) VALUES (1, 'P-1', 'ベルト', 10, 'a@x'), (2, 'P-2', 'フィルタ', 10, 'a@x')`);
const ins = sqlite.prepare(`INSERT INTO parts_transaction (part_id, type, quantity, created_by, created_at) VALUES (?, ?, ?, 'a@x', ?)`);
ins.run(1, 'out', -3, '2026-11-05T01:00:00Z');
ins.run(1, 'out', -2, '2026-11-10T01:00:00Z');
ins.run(1, 'out', -1, '2026-10-31T16:00:00Z');  // JST では 11/1 01:00 → 11月
ins.run(1, 'out', -4, '2026-06-15T01:00:00Z');
ins.run(1, 'in', 20, '2026-11-06T01:00:00Z');   // 入庫は数えない
ins.run(1, 'adjust', -7, '2026-11-07T01:00:00Z'); // 棚卸調整は数えない
ins.run(1, 'out', -9, '2025-11-30T14:59:59Z');  // JST 2025-11-30 → 12か月より前
ins.run(1, 'out', -8, '2025-11-30T15:00:00Z');  // JST 2025-12-01 00:00 → 範囲の最初の月
ins.run(2, 'out', -50, '2026-11-05T01:00:00Z'); // 別の部品

const u = await loadPartUsage(db, 1, '2026-11-12');
ok('出庫だけを月ごとに足す（入庫・棚卸調整・別の部品は含めない）', u.months[11].out === 6 && u.months[6].out === 4, JSON.stringify(u.months));
ok('月は JST で分ける（10/31 16:00Z は11月）', u.months[10].out === 0);
ok('12か月の境目（JSTの月初）を含み、それより前は含めない', u.months[0].month === '2025-12' && u.months[0].out === 8 && u.total_out === 18, JSON.stringify(u));
ok('月平均は小数1桁', u.avg_out === 1.5);
ok('出庫の無い部品は合計0', (await loadPartUsage(db, 999, '2026-11-12')).total_out === 0);

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail > 0) process.exit(1);
