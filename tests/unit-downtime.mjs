// 単体テスト: 休止時間の読み取りと集計（js/downtime.js）と集計API（functions/api/stats/index.js）。
//   実行: node --experimental-sqlite unit-downtime.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseDowntimeMinutes, isUnreadableDowntime, formatDowntime, downtimeOf, summarizeDowntime } =
  await import(pathToFileURL(path.join(ROOT, 'js/downtime.js')).href);
const { onRequestGet } = await import(pathToFileURL(path.join(ROOT, 'functions/api/stats/index.js')).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 休止時間 ===');

const cases = [
  ['30', 30], ['30分', 30], ['３０', 30], ['３０分', 30], [' 45 分 ', 45], ['約20分', 20], ['90min', 90], ['0', 0],
  ['1時間', 60], ['1.5時間', 90], ['2h', 120], ['1時間30分', 90], ['1h30m', 90], ['1:30', 90], ['１：０５', 65], ['1,200', 1200],
  ['', null], ['半日', null], ['不明', null], ['-5', null], ['30分くらい', null], ['1:75', null], ['99999999', null], [null, null],
];
for (const [text, want] of cases) {
  const got = parseDowntimeMinutes(text);
  ok(`「${text}」→ ${want === null ? '読み取れない' : `${want}分`}`, got === want, String(got));
}
ok('空欄は「読み取れない」に数えない', isUnreadableDowntime('') === false && isUnreadableDowntime('  ') === false);
ok('文字だけの入力は「読み取れない」', isUnreadableDowntime('半日') === true && isUnreadableDowntime('30') === false);
ok('表示: 45分／1時間／1時間30分', formatDowntime(45) === '45分' && formatDowntime(60) === '1時間' && formatDowntime(90) === '1時間30分' && formatDowntime(0) === '0分');
ok('帳票入力（JSON文字列）から休止時間と区分を取り出す',
  JSON.stringify(downtimeOf('{"休止時間":"1時間","休止種別":"故障休止"}')) === JSON.stringify({ minutes: 60, unreadable: false, kind: '故障休止', raw: '1時間' }));
ok('壊れたJSON・配列・null でも落ちない', downtimeOf('{').minutes === null && downtimeOf('[1]').minutes === null && downtimeOf(null).unreadable === false);

const sum = summarizeDowntime([
  { month: '2026-10', equipment_id: 1, form_values_json: '{"休止時間":"30","休止種別":"故障休止"}' },
  { month: '2026-10', equipment_id: 1, form_values_json: '{"休止時間":"1時間","休止種別":"故障休止"}' },
  { month: '2026-11', equipment_id: 2, form_values_json: '{"休止時間":"15"}' },
  { month: '2026-11', equipment_id: null, form_values_json: '{"休止時間":"半日","休止種別":"点検休止"}' },
  { month: '2026-11', equipment_id: 2, form_values_json: '{"整理NO":"A-1"}' },
]);
ok('合計は読み取れた分だけ（30+60+15=105分・3件）', sum.total_minutes === 105 && sum.counted === 3, JSON.stringify(sum));
ok('読み取れない記録は件数だけ数える（合計に入れない）', sum.unreadable === 1);
ok('月×区分でまとめる（区分なしは「区分なし」）',
  JSON.stringify(sum.by_month) === JSON.stringify([{ month: '2026-10', kind: '故障休止', minutes: 90 }, { month: '2026-11', kind: '区分なし', minutes: 15 }]), JSON.stringify(sum.by_month));
ok('区分別は時間の長い順', sum.by_kind[0].kind === '故障休止' && sum.by_kind[0].minutes === 90 && sum.by_kind[0].count === 2);
ok('設備別の合計', sum.by_equipment['1'] === 90 && sum.by_equipment['2'] === 15);

// ---- 集計API ----
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
sqlite.exec(`INSERT INTO equipment_ledger (id, code, name) VALUES (1, 'E-001', 'コンプレッサ'), (2, 'E-002', 'ボイラー')`);
const ins = sqlite.prepare(`INSERT INTO trouble_record (equipment_id, occurred_at, phenomenon, form_values_json, created_by, deleted_at) VALUES (?, ?, ?, ?, 'a@x', ?)`);
ins.run(1, '2026-10-05T01:00:00Z', '異音', '{"休止時間":"30","休止種別":"故障休止"}', null);
ins.run(1, '2026-10-31T16:00:00Z', '漏れ', '{"休止時間":"1時間","休止種別":"調整休止"}', null);   // JST では 11/1
ins.run(2, '2026-11-10T01:00:00Z', '停止', '{"休止時間":"不明"}', null);
ins.run(2, '2026-11-11T01:00:00Z', '停止', null, null);
ins.run(1, '2026-11-12T01:00:00Z', '削除済み', '{"休止時間":"500"}', '2026-11-12T02:00:00Z');
ins.run(1, '2025-01-01T01:00:00Z', '期間外', '{"休止時間":"999"}', null);

const res = await onRequestGet({ request: new Request('http://x/api/stats?from=2026-10-01&to=2027-09-30'), env: { DB: db } });
const st = await res.json();
ok('API: 期間内・未削除の休止時間を合計する（90分・2件）', st.downtime.total_minutes === 90 && st.downtime.counted === 2, JSON.stringify(st.downtime));
ok('API: 読み取れない記録は unreadable に数える', st.downtime.unreadable === 1);
ok('API: 月は JST で分ける（10/31 16:00Z は11月）',
  st.downtime.by_month.some((m) => m.month === '2026-10' && m.minutes === 30) && st.downtime.by_month.some((m) => m.month === '2026-11' && m.minutes === 60), JSON.stringify(st.downtime.by_month));
ok('API: 設備別の行に休止時間（分）が載る',
  st.equipment_trouble_counts.find((e) => e.equipment_id === 1).downtime_minutes === 90 && st.equipment_trouble_counts.find((e) => e.equipment_id === 2).downtime_minutes === 0);
ok('API: 件数の集計はこれまでどおり', st.activity.troubles === 4);

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail > 0) process.exit(1);
