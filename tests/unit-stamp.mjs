// 単体テスト: 押印の位置（js/xlsx-image.js の embedHankos）。実行: node unit-stamp.mjs（npm test から呼ばれる）
//   トラブル報告書の押印を上げすぎて、上の行の見出しにかかった不具合の再発防止。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSZip = createRequire(import.meta.url)(path.join(ROOT, 'js/vendor/jszip.min.js'));
const src = fs.readFileSync(path.join(ROOT, 'js/xlsx-image.js'), 'utf8');
const { embedHankos } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const exSrc = fs.readFileSync(path.join(ROOT, 'js/excel-fill.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 押印の位置 ===');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function anchorOf(item) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  z.file('xl/workbook.xml', '<?xml version="1.0"?><workbook/>');
  z.file('xl/sharedStrings.xml', '<?xml version="1.0"?><sst><si><t>{{担当者印}}</t></si></sst>');
  z.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet><sheetData><row r="2" ht="30"><c r="A2"/></row><row r="3"><c r="B3" t="s"><v>0</v></c></row></sheetData></worksheet>');
  await embedHankos(z, [{ tag: '担当者印', base64: PNG, ...item }]);
  const dx = await z.file('xl/drawings/drawing1.xml').async('string');
  return { row: Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(dx)[1]), rowOff: Number(/<xdr:rowOff>(\d+)<\/xdr:rowOff>/.exec(dx)[1]) };
}

const base = await anchorOf({});
ok('既定: セルの上から約3mm下（B3＝行インデックス2）', base.row === 2 && base.rowOff === 108000, JSON.stringify(base));
const up2 = await anchorOf({ rowShift: -72000 });
ok('2mm 上へ: 同じセルの中（上から約1mm）に収まり、上の行にはかからない', up2.row === 2 && up2.rowOff === 36000, JSON.stringify(up2));
const up5 = await anchorOf({ rowShift: -180000 });
ok('セルより上にはみ出す量だと、1つ上の行へ移る（行の高さ30pt）', up5.row === 1 && up5.rowOff === 30 * 12700 - 72000, JSON.stringify(up5));
const m = /const TROUBLE_STAMP_UP = (-?\d+)/.exec(exSrc);
ok('トラブル報告書の押印は、セルの中に収まる範囲（上の行にかからない）で上げる', !!m && 108000 + Number(m[1]) >= 0, m && m[1]);

console.log(`\n========== 単体（押印の位置）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
