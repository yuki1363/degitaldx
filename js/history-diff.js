// 変更履歴（audit_log の diff_json）を「何がどう変わったか」の一覧にする（画面表示用の純粋関数）。
//   他の import を持たない（単体テスト tests/unit-history-diff.mjs が node でそのまま読めるように）。
//   サーバー側の記録形式は機能ごとに少しずつ違うため、ここで3通りを同じ形にそろえる:
//     ① { 項目: { from, to } }          保全計画・業務依頼・トラブル記録
//     ② { 項目: { before, after } }     設備台帳
//     ③ { before: {…}, after: {…} }     点検記録
//   加えて日報の changed_items（ユーティリティ日報の点検項目ごとの前後）・attached_files（追加した写真の数）。
//   登録・削除・復元は「内容」ではなく操作そのものが履歴なので、変更内容は出さない。
//   以前の形式（新しい値だけを全項目書いていた日報など）は、前の値が無いので出さない。

/** 項目名（列名）→ 画面の表示名 */
export const FIELD_LABELS = {
  title: 'タイトル', planned_date: '予定日', planned_end_date: '終了日', plan_type: '種別',
  line_name: '設備名', equipment_name: '機器名', assignee_name: '担当者', inspector_name: '点検者・工事責任者',
  status: '状態', note: '備考', unscheduled: '時期未定', annual_only: '年間計画のみ',
  phenomenon: '現象', cause: '原因', countermeasure: '対策', occurred_at: '発生日時',
  equipment_id: '設備', category_id: 'ジャンル／カテゴリ', priority: '優先度', due_date: '対応期限',
  description: '内容', reporter_name: '記録者', report_date: '日付', body: '本文',
  inspected_at: '点検日時', has_abnormal: '異常', code: '設備番号', name: '名称',
  location: '設置場所', manufacturer: 'メーカー', model: '型式', serial_no: '製造番号',
  manufactured_on: '製造年月', installed_on: '設置年月日', form_values_json: '帳票の入力',
  custom_fields_json: 'カスタム項目', attachments_json: '添付', printed_at: '印刷日時',
};

/** 値の表示名（コードのまま出さない） */
const VALUE_LABELS = {
  pending: '未実施', done: '完了', received: '受付', in_progress: '対応中', waiting_parts: '部品待ち',
  inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他',
  high: '高', medium: '中', low: '低',
};

const BOOLEAN_KEYS = new Set(['has_abnormal', 'unscheduled', 'annual_only']);
const DATETIME_KEYS = new Set(['occurred_at', 'inspected_at', 'printed_at']);
const MAX_TEXT = 60;

const pad = (n) => String(n).padStart(2, '0');

/** UTC の ISO 日時 → JST の 'YYYY/MM/DD HH:MM'（解釈できない値はそのまま） */
function jstDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const j = new Date(d.getTime() + 9 * 3600_000);
  return `${j.getUTCFullYear()}/${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
}

/** 1つの値を表示用の文字列にする */
export function formatDiffValue(key, value) {
  if (value === null || value === undefined || value === '') return 'なし';
  if (BOOLEAN_KEYS.has(key)) return Number(value) ? 'はい' : 'いいえ';
  if (Array.isArray(value)) return value.length === 0 ? 'なし' : value.map((v) => formatDiffValue(key, v)).join('、');
  if (typeof value === 'object') return '（内容あり）';
  const s = String(value);
  if (DATETIME_KEYS.has(key) && /^\d{4}-\d{2}-\d{2}T/.test(s)) return jstDateTime(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, '/');
  if (VALUE_LABELS[s] && (key === 'status' || key === 'plan_type' || key === 'priority')) return VALUE_LABELS[s];
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * diff_json（文字列）→ 変更内容の一覧 [{ key, label, from, to, opaque? }]。
 *   from / to は表示用の文字列。`_json` の列（帳票の入力など）は中身を読めないので opaque:true
 *   （「変更あり」とだけ出す）。変更内容を出せない履歴（登録・削除・以前の形式）は空配列。
 */
export function parseHistoryChanges(diffJson, action) {
  if (action !== 'update' || !diffJson) return [];
  let diff;
  try { diff = typeof diffJson === 'string' ? JSON.parse(diffJson) : diffJson; } catch { return []; }
  if (!isObj(diff)) return [];

  const out = [];
  const push = (key, label, from, to, opaque = false) => {
    out.push({ key, label, from: opaque ? '' : formatDiffValue(key, from), to: opaque ? '' : formatDiffValue(key, to), opaque });
  };
  const labelOf = (key) => FIELD_LABELS[key] || key;
  const opaqueKey = (key) => key.endsWith('_json');

  // ③ { before: {…}, after: {…} }
  if (isObj(diff.before) && isObj(diff.after)) {
    for (const key of Object.keys(diff.after)) {
      if (sameValue(diff.before[key], diff.after[key])) continue;
      push(key, labelOf(key), diff.before[key], diff.after[key], opaqueKey(key));
    }
    return out;
  }

  for (const [key, v] of Object.entries(diff)) {
    if (key === 'changed_items' && Array.isArray(v)) {
      // ユーティリティ日報: 点検項目ごとの前後
      for (const it of v) {
        if (!isObj(it) || !it.name) continue;
        const unit = it.unit ? ` ${it.unit}` : '';
        out.push({
          key: `item:${it.name}`, label: String(it.name), opaque: false,
          from: it.from === null || it.from === undefined ? 'なし' : `${formatDiffValue('', it.from)}${unit}`,
          to: it.to === null || it.to === undefined ? 'なし' : `${formatDiffValue('', it.to)}${unit}`,
        });
      }
      continue;
    }
    if (key === 'attached_files' && Number(v) > 0) {
      out.push({ key, label: '写真・動画', from: '', to: `${Number(v)}件を追加`, opaque: false, added: true });
      continue;
    }
    if (!isObj(v)) continue; // ①②以外（メタ情報や以前の形式）は出さない
    const hasFromTo = 'from' in v && 'to' in v;
    const hasBeforeAfter = 'before' in v && 'after' in v;
    if (!hasFromTo && !hasBeforeAfter) continue;
    const from = hasFromTo ? v.from : v.before;
    const to = hasFromTo ? v.to : v.after;
    if (sameValue(from, to)) continue;
    push(key, labelOf(key), from, to, opaqueKey(key));
  }
  return out;
}

/** 1行の要約（例「状態・担当者を変更」）。詳細を開かなくても何が変わったか分かるように */
export function summarizeChanges(changes) {
  if (!changes.length) return '';
  const names = changes.map((c) => c.label);
  const shown = names.slice(0, 3).join('・');
  return names.length > 3 ? `${shown} ほか${names.length - 3}件を変更` : `${shown}を変更`;
}
