// 単体テスト: ダッシュボードの計算（js/dashboard-calc.js）と集計APIの追加分（functions/api/stats/index.js）。
//   実行: node --experimental-sqlite unit-dashboard-calc.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const calc = await import(pathToFileURL(path.join(ROOT, 'js/dashboard-calc.js')).href);
const { onRequestGet } = await import(pathToFileURL(path.join(ROOT, 'functions/api/stats/index.js')).href);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name} ${detail}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 前年度比の期間 ----
ok('1年前の同じ日', calc.prevYearDate('2026-11-15') === '2025-11-15');
ok('2/29 の1年前は 2/28', calc.prevYearDate('2028-02-29') === '2027-02-28');
ok('不正な日付は null', calc.prevYearDate('2026-02-31') === null && calc.prevYearDate('x') === null);
ok('今年度: 前年度の同じ時期まで', eq(calc.comparePeriod(2026, 2026, '2026-11-15'), { from: '2025-10-01', to: '2025-11-15', partial: true }));
ok('過去の年度: 前の年度まるごと', eq(calc.comparePeriod(2025, 2026, '2026-11-15'), { from: '2024-10-01', to: '2025-09-30', partial: false }));
ok('今年度の最終日: まるごと扱い', eq(calc.comparePeriod(2026, 2026, '2027-09-30'), { from: '2025-10-01', to: '2026-09-30', partial: false }));
ok('今日が不正なら null', calc.comparePeriod(2026, 2026, 'bad') === null);

// ---- 増減 ----
ok('増えた', eq(calc.yoy(14, 8), { diff: 6, pct: 75, dir: 'up' }));
ok('減った', eq(calc.yoy(6, 8), { diff: -2, pct: -25, dir: 'down' }));
ok('同じ', calc.yoy(5, 5).dir === 'same');
ok('前年が0なら割合は出さない', calc.yoy(3, 0).pct === null && calc.yoy(3, 0).dir === 'up');

// ---- 設備別 ----
const rows = [
  { equipment_id: 1, equipment_name: 'A', trouble_count: 7, downtime_minutes: 30 },
  { equipment_id: null, equipment_name: '設備未指定', trouble_count: 6, downtime_minutes: 999 },
  { equipment_id: 2, equipment_name: 'B', trouble_count: 3, downtime_minutes: 120 },
  { equipment_id: 3, equipment_name: 'C', trouble_count: 3, downtime_minutes: 0 },
  { equipment_id: 4, equipment_name: 'D', trouble_count: 2, downtime_minutes: 0 },
  { equipment_id: 5, equipment_name: 'E', trouble_count: 1, downtime_minutes: 5 },
  { equipment_id: 6, equipment_name: 'F', trouble_count: 1, downtime_minutes: 0 },
  { equipment_id: 7, equipment_name: 'G', trouble_count: 1, downtime_minutes: 0 },
];
ok('件数の上位5（設備未指定は除く・同点は元の順）', eq(calc.worstEquipment(rows, 'trouble_count', 5).map((r) => r.equipment_id), [1, 2, 3, 4, 5]));
ok('休止時間の上位（0分は載せない）', eq(calc.worstEquipment(rows, 'downtime_minutes', 5).map((r) => r.equipment_id), [2, 1, 5]));
ok('設備未指定の件数', calc.unassignedCount(rows) === 6);
ok('繰り返し（3回以上・設備未指定は除く）', eq(calc.repeatEquipment(rows, 3).map((r) => r.equipment_id), [1, 2, 3]));
ok('空でも落ちない', eq(calc.worstEquipment(null, 'trouble_count'), []) && eq(calc.repeatEquipment(undefined), []));

// ---- 曜日×時間帯 ----
const g = calc.heatmapGrid([
  { weekday: 1, hour: 9, count: 2 },   // 月 9時 → 9〜12時・月
  { weekday: 1, hour: 11, count: 1 },  // 同じマス
  { weekday: 0, hour: 23, count: 4 },  // 日 23時 → 21〜24時・日（最後の列）
  { weekday: 9, hour: 1, count: 5 },   // 不正は無視
  { weekday: 2, hour: 24, count: 5 },  // 不正は無視
]);
ok('時間帯は8つ・曜日は月〜日', g.cells.length === 8 && g.cells[0].length === 7 && calc.HEAT_WEEKDAYS[0] === '月' && calc.HEAT_BANDS[3] === '9〜12時');
ok('同じ時間帯・曜日は足す', g.cells[3][0] === 3);
ok('日曜は最後の列', g.cells[7][6] === 4);
ok('最大と合計（不正な行は数えない）', g.max === 4 && g.total === 7);
ok('濃さの段階: 0件は0・1件でも1段目・最大は最上段', calc.heatStep(0, 10) === 0 && calc.heatStep(1, 100) === 1 && calc.heatStep(10, 10) === 5 && calc.heatStep(3, 0) === 0);

// ---- 色の枠 ----
const slots = calc.categorySlots([{ id: 5 }, { id: 1 }, { id: 3 }]);
ok('ジャンルはID順に枠を決める（件数の順位に依らない）', slots.get(1) === 0 && slots.get(3) === 1 && slots.get(5) === 2);
ok('枠の数を超えたジャンルは灰色（-1）', calc.categorySlots(Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }))).get(9) === -1);
const ks = calc.kindSlots(['調整休止', '区分なし', 'その他休止']);
ok('休止区分: 標準の3区分は固定・区分なしは灰色', ks.get('故障休止') === 0 && ks.get('調整休止') === 2 && ks.get('その他休止') === 3 && ks.get('区分なし') === -1);

// ---- 集計API ----
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
const wrap = (sql) => {
  const st = sqlite.prepare(sql);
  let args = [];
  const o = {
    bind: (...a) => { args = a; return o; },
    all: async () => ({ results: st.all(...args) }),
    first: async () => st.get(...args) ?? null,
  };
  return o;
};
const db = { prepare: (sql) => wrap(sql) };
sqlite.exec(`INSERT INTO equipment_ledger (id, code, name) VALUES (1, 'E-001', 'コンプレッサ')`);
const catId = sqlite.prepare(`SELECT id FROM trouble_category ORDER BY id LIMIT 1`).get().id;
const ins = sqlite.prepare(`INSERT INTO trouble_record (equipment_id, category_id, occurred_at, phenomenon, form_values_json, created_by, deleted_at) VALUES (1, ?, ?, 'x', ?, 'a@x', ?)`);
ins.run(catId, '2026-11-08T15:30:00Z', null, null);                      // JST 11/9（月）0:30
ins.run(catId, '2026-11-09T00:10:00Z', null, null);                      // JST 11/9（月）9:10
ins.run(null, '2026-11-09T00:50:00Z', null, null);                       // JST 11/9（月）9:50・未分類
ins.run(catId, '2026-11-09T01:00:00Z', null, '2026-11-10T00:00:00Z');    // 削除済み
ins.run(catId, '2025-10-31T15:00:00Z', '{"休止時間":"45"}', null);        // 前年度 JST 11/1
ins.run(catId, '2025-11-20T01:00:00Z', '{"休止時間":"500"}', null);       // 前年度だが比べる期間の外

const call = async (qs) => (await onRequestGet({ request: new Request(`http://x/api/stats?${qs}`), env: { DB: db } })).json();
const st = await call('from=2026-10-01&to=2027-09-30&prev_from=2025-10-01&prev_to=2025-11-15');
ok('API: 曜日×時刻は JST で数える（削除済みは除く）',
  eq(st.trouble_by_weekday_hour, [{ weekday: 1, hour: 0, count: 1 }, { weekday: 1, hour: 9, count: 2 }]), JSON.stringify(st.trouble_by_weekday_hour));
ok('API: ジャンルマスタをID順で返す', st.categories.length >= 1 && st.categories[0].id === catId && typeof st.categories[0].name === 'string');
ok('API: ジャンル別に category_id が載る（未分類は null）',
  st.trouble_by_category.some((c) => c.category_id === catId && c.count === 2) && st.trouble_by_category.some((c) => c.category_id === null && c.category_name === '未分類')
  && st.trouble_trend_by_category.every((c) => 'category_id' in c));
ok('API: 前年度は指定した期間だけを数える（件数・月別・休止時間）',
  st.previous.troubles === 1 && eq(st.previous.trouble_trend, [{ month: '2025-11', count: 1 }])
  && st.previous.downtime.total_minutes === 45 && st.previous.downtime.counted === 1, JSON.stringify(st.previous));
ok('API: 前年度の期間を指定しなければ previous は null', (await call('from=2026-10-01&to=2027-09-30')).previous === null);
ok('API: 前年度の期間が不正なら previous は null（500にしない）',
  (await call('from=2026-10-01&to=2027-09-30&prev_from=abc&prev_to=2025-11-15')).previous === null
  && (await call('from=2026-10-01&to=2027-09-30&prev_from=2025-12-01&prev_to=2025-11-15')).previous === null);
const bad = await call('from=2026-10-01&to=2027-09-30&prev_from=2025-13-45&prev_to=2025-13-46');
ok('API: 存在しない日付でも落ちない（0件）', bad.previous && bad.previous.troubles === 0);

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail > 0) process.exit(1);
