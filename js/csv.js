// CSV出力の共通モジュール（クライアント側で生成）
//
//   - escCsv(v)               … 値をCSV用にエスケープ（カンマ・改行・"" を安全化）
//   - buildCsvText(rows, cols) … 行データと列定義（{label, value(row)}）からCSVテキスト生成
//   - downloadCsv(name, text, enc) … Blobとしてダウンロード
//       enc='sjis' のときは encoding-japanese（グローバル Encoding）で Shift_JIS 変換。
//       未読込・未指定のときは UTF-8 + BOM（Excelで文字化けしない）でダウンロードする。
//
//   ※ Shift_JIS 出力を使うページは encoding-japanese の <script> を読み込むこと
//     （未読込でも UTF-8/BOM に自動フォールバックするため動作はする）。

export function escCsv(v) {
  const s = v == null ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

// Excel の自動変換よけ。設備番号「3-25」や品番「0012」などを Excel が
// 日付（3月25日）や数値（先頭0が消える）に勝手に変換するのを防ぐ。
//   ="値" の数式形式にすると Excel はその中身を文字列として保持する。
//   （CSVエスケープは buildCsvText 側の escCsv が行うため、ここでは数式文字列のみ作る）
export function excelText(v) {
  if (v == null || v === '') return '';
  return `="${String(v).replace(/"/g, '""')}"`;
}

export function buildCsvText(rows, columns) {
  const header = columns.map((c) => escCsv(c.label)).join(',');
  const body   = rows.map((r) => columns.map((c) => escCsv(c.value(r))).join(',')).join('\n');
  return header + '\n' + body;
}

export function downloadCsv(filename, text, encoding) {
  let blob;
  if (encoding === 'sjis' && typeof Encoding !== 'undefined') {
    const sjisArray = Encoding.convert(
      Encoding.stringToCode(text),
      { to: 'SJIS', from: 'UNICODE' }
    );
    blob = new Blob([new Uint8Array(sjisArray)], { type: 'text/csv' });
  } else {
    // UTF-8 with BOM（Excel で文字化けしない）
    blob = new Blob(['﻿' + text], { type: 'text/csv; charset=utf-8' });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
