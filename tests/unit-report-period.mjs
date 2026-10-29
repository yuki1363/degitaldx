// 単体テスト: 保全レポートの期間計算（js/report-period.js）。実行: node unit-report-period.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'js/report-period.js'), 'utf8');
const { periodFor, isValidPeriod, shiftDate } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const is = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log('\n=== 単体: 保全レポートの期間 ===');

// 2026-10-29 は木曜日
ok('今週は月曜〜日曜（木曜に実行）', is(periodFor('week', '2026-10-29'), { from: '2026-10-26', to: '2026-11-01' }), JSON.stringify(periodFor('week', '2026-10-29')));
ok('今週: 月曜に実行すると、その日から始まる', is(periodFor('week', '2026-10-26'), { from: '2026-10-26', to: '2026-11-01' }));
ok('今週: 日曜に実行すると、前の月曜から（週が次に進まない）', is(periodFor('week', '2026-11-01'), { from: '2026-10-26', to: '2026-11-01' }));
ok('先週は今週の7日前', is(periodFor('lastweek', '2026-10-29'), { from: '2026-10-19', to: '2026-10-25' }));
ok('今月は1日〜月末', is(periodFor('month', '2026-10-29'), { from: '2026-10-01', to: '2026-10-31' }));
ok('先月: 年をまたぐ（1月→前年12月）', is(periodFor('lastmonth', '2027-01-15'), { from: '2026-12-01', to: '2026-12-31' }));
ok('月末の算出（2月・うるう年）', is(periodFor('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' }) && is(periodFor('month', '2027-02-10'), { from: '2027-02-01', to: '2027-02-28' }));
ok('週が月をまたぐ・年をまたぐ', is(periodFor('week', '2026-12-31'), { from: '2026-12-28', to: '2027-01-03' }));
ok('不正な日付・種類は null', periodFor('week', 'abc') === null && periodFor('year', '2026-10-29') === null && periodFor('month', '2026-02-30') === null);
ok('shiftDate: 翌日（月末・年末）', shiftDate('2026-10-31', 1) === '2026-11-01' && shiftDate('2026-12-31', 1) === '2027-01-01' && shiftDate('x', 1) === null);
ok('isValidPeriod: 開始≦終了で、存在する日付のみ', isValidPeriod('2026-10-01', '2026-10-31') && isValidPeriod('2026-10-01', '2026-10-01') && !isValidPeriod('2026-10-31', '2026-10-01') && !isValidPeriod('', '2026-10-01') && !isValidPeriod('2026-02-30', '2026-03-01'));

console.log(`\n========== 単体（保全レポート期間）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
