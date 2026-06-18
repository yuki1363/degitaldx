// 帳票印刷 — 用紙画像オーバーレイ印刷（保全計画→工事連絡書 / トラブル記録→トラブル報告書）
//   管理画面で登録したテンプレート（用紙画像＋差込欄の位置）にレコードのデータを差し込み、
//   window.print() で用紙ごと印刷する。手入力欄は印刷前にその場で記入できる。
//   使い方: openPrintDialog('construction_notice', plan) / openPrintDialog('trouble_report', trouble)

import { api } from '/js/api.js';
import { el, render, formatDate, formatDateTime } from '/js/util.js';

const TYPE_LABELS = { construction_notice: '工事連絡書', trouble_report: 'トラブル報告書' };
const PLAN_TYPE_LABELS = { inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他' };
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };

// 差込値の整形（日付・種別・状態は表示用に変換）
function formatValue(recordData, source) {
  const raw = recordData ? recordData[source] : undefined;
  if (raw === undefined || raw === null || raw === '') return '';
  if (source === 'plan_type') return PLAN_TYPE_LABELS[raw] || raw;
  if (source === 'status') return STATUS_LABELS[raw] || raw;
  if (source === 'occurred_at') return formatDateTime(raw);
  if (source === 'planned_date' || source === 'planned_end_date') return formatDate(raw);
  return String(raw);
}

// テンプレートが複数ある場合の選択シート
function chooseTemplate(templates) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'sheet-backdrop' });
    const done = (val) => { backdrop.remove(); resolve(val); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    backdrop.appendChild(el('div', { class: 'sheet' }, [
      el('div', { class: 'sheet-title' }, '帳票テンプレートを選択'),
      ...templates.map((t) => el('button', { class: 'sheet-btn', onclick: () => done(t) }, t.name)),
      el('button', { class: 'sheet-btn sheet-cancel', onclick: () => done(null) }, 'キャンセル'),
    ]));
    document.body.appendChild(backdrop);
  });
}

// 用紙画像＋差込欄を重ねた印刷用の DOM を作る
function renderPrintForm(template, recordData) {
  let fields = [];
  try { fields = JSON.parse(template.fields_json || '[]'); } catch { fields = []; }

  const paper = el('div', { class: 'print-form-paper' + (template.orientation === 'landscape' ? ' is-landscape' : '') });
  if (template.image_file_id) {
    paper.appendChild(el('img', { class: 'print-form-img', src: `/api/files/${template.image_file_id}`, alt: '用紙' }));
  }

  const today = formatDate(new Date().toISOString());
  for (const f of fields) {
    let text = '';
    if (f.kind === 'data') text = formatValue(recordData, f.source);
    else if (f.kind === 'date') text = today;
    else if (f.kind === 'fixed') text = f.text || '';
    else if (f.kind === 'manual') text = f.text || '';

    const node = el('span', { class: 'pf-field' + (f.kind === 'manual' ? ' pf-manual' : '') }, text);
    if (f.kind === 'manual') node.setAttribute('contenteditable', 'true');
    node.style.left = `${f.x}%`;
    node.style.top = `${f.y}%`;
    node.style.fontSize = `${f.font_size || 12}pt`;
    node.style.textAlign = f.align || 'left';
    paper.appendChild(node);
  }
  return paper;
}

function openOverlay(template, recordData) {
  const paper = renderPrintForm(template, recordData);
  const styleEl = el('style', {},
    `@page { size: A4 ${template.orientation === 'landscape' ? 'landscape' : 'portrait'}; margin: 8mm; }`);
  const overlay = el('div', { class: 'print-form-overlay' });
  const close = () => {
    document.body.classList.remove('printing-form');
    overlay.remove();
    styleEl.remove();
  };
  render(overlay, [
    el('div', { class: 'print-form-bar no-print' }, [
      el('span', { class: 'print-form-hint' }, `${template.name}（手入力欄はクリックで記入できます）`),
      el('button', { class: 'btn btn-primary', onclick: () => window.print() }, '🖨 印刷'),
      el('button', { class: 'btn', onclick: close }, '閉じる'),
    ]),
    paper,
  ]);
  document.body.classList.add('printing-form');
  document.body.appendChild(styleEl);
  document.body.appendChild(overlay);
}

/**
 * 帳票印刷ダイアログを開く。
 * @param {'construction_notice'|'trouble_report'} templateType
 * @param {object} recordData 取得済みの plan / trouble オブジェクト
 */
export async function openPrintDialog(templateType, recordData) {
  let templates = [];
  try {
    ({ templates } = await api.get('/api/print-templates'));
  } catch (err) {
    alert(`帳票テンプレートの取得に失敗しました: ${err.message}`);
    return;
  }
  const matches = (templates || []).filter((t) => t.template_type === templateType);
  if (matches.length === 0) {
    alert(`「${TYPE_LABELS[templateType] || templateType}」のテンプレートが登録されていません。\n管理画面の「帳票テンプレート」から作成してください。`);
    return;
  }
  const template = matches.length === 1 ? matches[0] : await chooseTemplate(matches);
  if (!template) return;
  openOverlay(template, recordData);
}
