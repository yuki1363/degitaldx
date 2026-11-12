// トラブル記録の CSV 出力（04 トラブル一覧・08 ダッシュボードで共有）
//   列定義を1か所にまとめ、どちらから出しても同じ形式の CSV になるようにする。

import { formatDateTime, jstTodayStr } from '/js/util.js';
import { buildCsvText, downloadCsv, excelText } from '/js/csv.js';
import { downtimeOf } from '/js/downtime.js';

// CSV出力の列定義（トラブル履歴）
export const TROUBLE_CSV_COLUMNS = [
  { label: '発生日時', value: (t) => formatDateTime(t.occurred_at) },
  { label: '設備番号', value: (t) => excelText(t.equipment_code) },
  { label: '設備',     value: (t) => t.equipment_name || '' },
  { label: 'ジャンル', value: (t) => t.category_name || '' },
  { label: '現象',     value: (t) => t.phenomenon || '' },
  { label: '原因',     value: (t) => t.cause || '' },
  { label: '対策',     value: (t) => t.countermeasure || '' },
  // 休止時間は分の数値で出す（Excel で合計できるように）。読み取れない書き方は入力のまま出す
  { label: '休止時間（分）', value: (t) => { const d = downtimeOf(t.form_values_json); return d.minutes === null ? d.raw : d.minutes; } },
  { label: '休止区分', value: (t) => downtimeOf(t.form_values_json).kind },
  { label: '記録者',   value: (t) => t.reporter_name || t.creator_name || t.created_by || '' },
  { label: '登録日時', value: (t) => formatDateTime(t.created_at) },
];

// troubles（/api/troubles の結果）を CSV でダウンロード。enc='sjis' で Shift_JIS
export function exportTroubleCsv(troubles, enc) {
  const text = buildCsvText(troubles, TROUBLE_CSV_COLUMNS);
  const dateStr = jstTodayStr().replace(/-/g, '');
  downloadCsv(`trouble_${dateStr}.csv`, text, enc);
}
