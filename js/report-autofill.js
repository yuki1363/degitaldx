// 04 トラブル報告書・01 工事連絡書: 帳票用の入力を、すでに入力した内容で賄う
//   ・トラブル報告書: 設備・現象・原因・対策・記録者は、トラブル記録の入力を**そのまま反映する**（帳票用の入力欄は
//     出さない＝同じことを二度入力しない）。Excel 用紙の差込タグ名（調査対象・トラブル名・処置・担当者印など）は
//     変えず、出力時に記録から差し込む。記録の値が空のときだけ、以前に帳票入力欄へ保存した値を使う。
//   ・工事連絡書: 同じく、保全計画の入力をそのまま反映する（工事概要←タイトル＋備考／担当←担当者／責任者←点検者）。
//     帳票用の入力欄は出さない。計画の値が空のときだけ、以前に帳票入力欄へ保存した値を使う。
//   データを二重に持たず、出力時にだけ補う。
//   整理NO・休止時間・休止区分・有効性の確認・特記事項・チェック類は、該当する入力が無いため手入力のまま。
//   他の import を持たない（Node の単体テストから読み込めるように）。

const blank = (v) => v == null || String(v).trim() === '';
const surnameOf = (name) => String(name || '').trim().split(/[\s　]+/)[0];

// トラブル報告書: 記録の内容をそのまま反映するタグ（帳票用の入力欄は出さない）。値が空なら反映しない
const RECORD_VALUES = {
  trouble_report: {
    '調査対象': (r) => r.equipment_name,                       // 設備
    'トラブル名': (r) => r.phenomenon,                          // 現象
    '現象': (r) => r.phenomenon,
    '原因': (r) => r.cause,
    '処置': (r) => r.countermeasure,                            // 対策
    '対策': (r) => r.countermeasure,
    '担当者印': (r) => surnameOf(r.reporter_name || r.creator_name), // 記録者の苗字
    '担当印': (r) => surnameOf(r.reporter_name || r.creator_name),   // 用紙のタグ名が違っても同じ印（工事連絡書と同じ名前）
    '担当社印': (r) => surnameOf(r.reporter_name || r.creator_name),
  },
  construction_notice: {
    '工事概要': (r) => [r.title, r.note].filter((x) => !blank(x)).join('\n'), // タイトル＋備考（統合）
    '担当': (r) => r.assignee_name,                             // 計画の担当者（＝シーバイエス担当）
    '責任者': (r) => r.inspector_name,                          // 計画の点検者（＝工事責任者）
  },
};

/** 記録から入るタグ＝帳票の入力欄には出さないタグ（テンプレートが入力項目として定義していても出さない） */
export const RECORD_TAGS = {
  trouble_report: [...Object.keys(RECORD_VALUES.trouble_report),
    '設備名', '設備番号', 'ジャンル', '記録者', '発生日時', '発生年月日', '発生年', '発生月', '発生日',
    '調査日時', '調査日付', '調査年月日', '調査年', '調査月', '調査日'], // 調査日時・調査日付 = 発生日時（統合）
  construction_notice: ['工事概要', '担当', '責任者', 'タイトル', '工事作業名称', '備考', '点検者', '担当者'],
};

/** 画面の入力欄に出す、空欄のときの補い元の説明（placeholder 用） */
export const AUTOFILL_HINTS = {
  trouble_report: {},
  construction_notice: {},
};

/**
 * 帳票の入力値を返す（入力欄が空のタグだけ、記録／計画の内容で補う）。元の inputValues は変更しない。
 * @param {'trouble_report'|'construction_notice'|string} type
 * @param {object} record トラブル記録 または 保全計画
 * @param {object} inputValues 帳票の入力欄の値（form_values_json）
 */
export function applyReportFallbacks(type, record, inputValues) {
  const out = { ...(inputValues || {}) };
  if (!record) return out;
  // 記録／計画の値を優先して反映する（記録が空のタグだけ、保存済みの帳票入力値が残る）
  for (const [tag, pick] of Object.entries(RECORD_VALUES[type] || {})) {
    const v = pick(record);
    if (!blank(v)) out[tag] = String(v).trim();
  }
  return out;
}
