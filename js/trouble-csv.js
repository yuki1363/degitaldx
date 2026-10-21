// トラブル記録の CSV 出力（04 トラブル一覧・08 ダッシュボードで共有）
//   列定義を1か所にまとめ、どちらから出しても同じ形式の CSV になるようにする。

import { formatDateTime } from '/js/util.js';
import { buildCsvText, downloadCsv, excelText } from '/js/csv.js';

// CSV出力の列定義（トラブル履歴）
export const TROUBLE_CSV_COLUMNS = [
  { label: '発生日時', value: (t) => formatDateTime(t.occurred_at) },
  { label: '設備番号', value: (t) => excelText(t.equipment_code) },
  { label: '設備',     value: (t) => t.equipment_name || '' },
  { label: 'ジャンル', value: (t) => t.category_name || '' },
  { label: '現象',     value: (t) => t.phenomenon || '' },
  { label: '原因',     value: (t) => t.cause || '' },
  { label: '対策',     value: (t) => t.countermeasure || '' },
  { label: '記録者',   value: (t) => t.reporter_name || t.creator_name || t.created_by || '' },
  { label: '登録日時', value: (t) => formatDateTime(t.created_at) },
];

// troubles（/api/troubles の結果）を CSV でダウンロード。enc='sjis' で Shift_JIS
export function exportTroubleCsv(troubles, enc) {
  const text = buildCsvText(troubles, TROUBLE_CSV_COLUMNS);
  const dateStr = new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
  downloadCsv(`trouble_${dateStr}.csv`, text, enc);
}
