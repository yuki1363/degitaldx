// 04 トラブル報告書・01 工事連絡書: 帳票用の入力欄を、すでに入力した内容で賄う
//   帳票の入力欄が「空」のときだけ、トラブル記録／保全計画の内容で補う（入力欄に値があればそちらを優先）。
//   データを二重に持たず、出力時にだけ補う。Excel 用紙の差込タグ名は変えない。
//   整理NO・休止時間・休止区分・有効性の確認・特記事項・チェック類は、該当する入力が無いため手入力のまま。
//   他の import を持たない（Node の単体テストから読み込めるように）。

const blank = (v) => v == null || String(v).trim() === '';
const surnameOf = (name) => String(name || '').trim().split(/[\s　]+/)[0];

// 種別ごとの「入力タグ → 補う値を返す関数」。値が空なら補わない
const FALLBACKS = {
  trouble_report: {
    '調査対象': (r) => r.equipment_name,                       // 設備
    'トラブル名': (r) => r.phenomenon,                          // 現象
    '処置': (r) => r.countermeasure,                            // 対策
    '担当者印': (r) => surnameOf(r.reporter_name || r.creator_name), // 記録者の苗字
  },
  construction_notice: {
    '担当': (r) => r.assignee_name,                             // 計画の担当者
    '工事概要': (r) => (blank(r.note) ? r.title : r.note),      // 備考（空ならタイトル）
  },
};

/** 画面の入力欄に出す、空欄のときの補い元の説明（placeholder 用） */
export const AUTOFILL_HINTS = {
  trouble_report: {
    '調査対象': '空欄なら「設備」を使います',
    'トラブル名': '空欄なら「現象」を使います',
    '処置': '空欄なら「対策」を使います',
    '担当者印': '空欄なら「記録者」の苗字を使います',
  },
  construction_notice: {
    '担当': '空欄なら「担当者」を使います',
    '工事概要': '空欄なら「備考」（無ければタイトル）を使います',
  },
};

/**
 * 帳票の入力値を返す（入力欄が空のタグだけ、記録／計画の内容で補う）。元の inputValues は変更しない。
 * @param {'trouble_report'|'construction_notice'|string} type
 * @param {object} record トラブル記録 または 保全計画
 * @param {object} inputValues 帳票の入力欄の値（form_values_json）
 */
export function applyReportFallbacks(type, record, inputValues) {
  const out = { ...(inputValues || {}) };
  const rules = FALLBACKS[type];
  if (!rules || !record) return out;
  for (const [tag, pick] of Object.entries(rules)) {
    if (!blank(out[tag])) continue;
    const v = pick(record);
    if (!blank(v)) out[tag] = String(v).trim();
  }
  return out;
}
