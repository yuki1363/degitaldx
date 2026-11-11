// 工事連絡許可書の「画面で入力する項目」の標準セット。
//   ・管理画面の帳票テンプレート（print-templates.js）の標準項目
//   ・保全計画の編集ページ（plan.js）でテンプレートに入力項目が無いときのフォールバック
// の両方で共有する。tag は Excel 用紙のセルに置く {{タグ名}} と対応させる。
// 工事概要（タイトル＋備考）・担当（担当者）・責任者（点検者）は、計画の入力から自動で入るため、ここには出さない。
export const CONSTRUCTION_NOTICE_FIELDS = [
  { tag: '会社名', label: '工事業者 会社名', type: 'text' },
  { tag: '会社TEL', label: '会社 連絡先TEL', type: 'text' },
  { tag: '責任者TEL', label: '責任者 連絡先TEL', type: 'text' },
  { tag: '担当TEL', label: '担当 連絡先TEL', type: 'text' },
  { tag: '内線', label: '担当 内線', type: 'text' },
  { tag: '高所作業', label: '高所作業', type: 'check' },
  { tag: '火気使用', label: '火気の使用', type: 'check' },
  { tag: 'LOTO', label: 'LOTO・エネルギー遮断', type: 'check' },
  { tag: '閉塞スペース', label: '閉塞スペースで作業', type: 'check' },
  { tag: '特殊作業', label: 'その他の特殊作業', type: 'check' },
  { tag: '特殊作業詳細', label: '特殊作業の詳細', type: 'text' },
  { tag: '設備停止連絡', label: '設備停止の連絡済み', type: 'check' },
  { tag: 'タンク確認', label: 'タンク内バルク確認', type: 'check' },
];

// トラブル報告書（設備関係修理報告書）の「画面で入力する項目」の標準セット。
//   ・管理画面の帳票テンプレート（print-templates.js）の標準項目
//   ・トラブル記録の編集ページ（trouble.js）の帳票入力欄
// の両方で共有する。設備名・発生年月日・現象・原因・対策・記録者（調査対象・トラブル名・処置・担当者印のタグも）は
// トラブル記録の入力から自動で入るため、ここには入力項目として出さない。
export const TROUBLE_REPORT_FIELDS = [
  { tag: '整理NO', label: '整理NO.', type: 'text' },
  { tag: '休止時間', label: '休止時間（分）', type: 'text' },
  { tag: '休止種別', label: '休止区分（1つ選び○）', type: 'choice', options: ['故障休止', '点検休止', '調整休止'] },
  { tag: '有効性の確認', label: '有効性の確認', type: 'textarea' },
  { tag: '特記事項', label: '特記事項', type: 'textarea' },
];
