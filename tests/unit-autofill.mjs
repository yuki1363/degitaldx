// 単体テスト: 帳票の入力欄の自動補完（js/report-autofill.js）
//   入力欄が空のときだけ、トラブル記録／保全計画の内容で補う。実行: node unit-autofill.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// js/ 配下は ESM だが package.json が無いので、ソースを data: URL 経由で読み込む
const src = fs.readFileSync(path.join(ROOT, 'js/report-autofill.js'), 'utf8');
const { applyReportFallbacks, AUTOFILL_HINTS } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 帳票の入力欄の自動補完 ===');

const trouble = { equipment_name: 'コンプレッサ', phenomenon: '異音が出る', countermeasure: 'ベルト交換', reporter_name: '田中 太郎', creator_name: 'x' };
let v = applyReportFallbacks('trouble_report', trouble, {});
ok('トラブル報告書: 調査対象←設備・トラブル名←現象・処置←対策', v['調査対象'] === 'コンプレッサ' && v['トラブル名'] === '異音が出る' && v['処置'] === 'ベルト交換', JSON.stringify(v));
ok('トラブル報告書: 担当者印←記録者の苗字（姓＋名なら姓だけ）', v['担当者印'] === '田中');
ok('記録者が無ければ登録者の苗字を使う', applyReportFallbacks('trouble_report', { creator_name: '佐藤　花子' }, {})['担当者印'] === '佐藤');

v = applyReportFallbacks('trouble_report', trouble, { '調査対象': '3号機', '処置': '  ', '休止時間': '30' });
ok('入力欄に値があればそちらを優先し、空白だけなら補う。他の入力はそのまま',
  v['調査対象'] === '3号機' && v['処置'] === 'ベルト交換' && v['休止時間'] === '30', JSON.stringify(v));
ok('整理NO・休止区分・有効性の確認・特記事項は補わない（該当する入力が無い）',
  !('整理NO' in v) && !('休止種別' in v) && !('有効性の確認' in v) && !('特記事項' in v));

const plan = { assignee_name: '山田 一郎', note: '配管の交換', title: 'A棟配管工事' };
v = applyReportFallbacks('construction_notice', plan, {});
ok('工事連絡書: 担当←担当者・工事概要←備考', v['担当'] === '山田 一郎' && v['工事概要'] === '配管の交換', JSON.stringify(v));
ok('工事概要は備考が空ならタイトル', applyReportFallbacks('construction_notice', { note: ' ', title: 'A棟配管工事' }, {})['工事概要'] === 'A棟配管工事');
ok('工事連絡書: 会社名・責任者・TEL・安全チェックは補わない',
  !('会社名' in v) && !('責任者' in v) && !('担当TEL' in v) && !('高所作業' in v));

const input = { '担当': '' };
applyReportFallbacks('construction_notice', plan, input);
ok('元の入力値は変更しない', input['担当'] === '' && Object.keys(input).length === 1);
ok('補える値が無ければ空のまま（undefined を文字列にしない）',
  !('調査対象' in applyReportFallbacks('trouble_report', { phenomenon: 'x' }, {})) && JSON.stringify(applyReportFallbacks('other', trouble, { a: '1' })) === '{"a":"1"}');
ok('画面用の説明（placeholder）が補う項目すべてにある',
  ['調査対象', 'トラブル名', '処置', '担当者印'].every((t) => AUTOFILL_HINTS.trouble_report[t]) && ['担当', '工事概要'].every((t) => AUTOFILL_HINTS.construction_notice[t]));

console.log(`\n========== 単体（帳票の自動補完）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
