// 帳票出力 — Excel差込（タグ置換）方式
//   管理画面で登録した Excel 用紙（セルに {{予定日}} 等のタグを入力済み）を取得し、
//   タグを保全計画／トラブル記録のデータ＋画面入力値に置換した .xlsx をダウンロードする。
//   PDF が必要な場合は、出力した Excel を開いて「PDFで保存／エクスポート」する。
//   .xlsx は ZIP+XML なので JSZip で内部XMLのタグ文字列だけを置換する。これにより
//   書式・罫線・結合セル・ロゴ画像などのレイアウトは完全に保持される。
//
//   タグの種類:
//     ・自動タグ … 保全計画/トラブル記録のデータから自動で入る（buildValues）
//     ・入力タグ … テンプレートに定義された「画面で入力する項目」（fields_json）。
//                  出力時にフォームを表示して入力。type='check' はレ点(✓)になる。

import { api } from '/js/api.js';
import { el, formatDate, formatDateTime } from '/js/util.js';

const TYPE_LABELS = { construction_notice: '工事連絡書', trouble_report: 'トラブル報告書' };
const PLAN_TYPE_LABELS = { inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他' };
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CHECK_MARK = '✓';

const JSZIP_SRC = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSZIP_SRC;
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => { jszipPromise = null; reject(new Error('JSZip の読み込みに失敗しました（オンラインで実行してください）。')); };
      document.head.appendChild(s);
    });
  }
  return jszipPromise;
}

// 'YYYY-MM-DD' → { y, mo, da }（月日は先頭ゼロなし）
function datePart(d) {
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  if (!mt) return { y: '', mo: '', da: '' };
  return { y: mt[1], mo: String(Number(mt[2])), da: String(Number(mt[3])) };
}
// 開始〜終了の日数（両端含む）。終了が無ければ1日
function daysBetween(start, end) {
  if (!start) return '';
  const s = new Date(start);
  const e = new Date(end || start);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  return String(Math.floor((e - s) / 86400000) + 1);
}

// 自動タグ → 値（種別ごと）。入力タグ（fields_json）はここに無く、フォームで集める
function buildValues(type, r) {
  const today = formatDate(new Date().toISOString());
  if (type === 'construction_notice') {
    const ds = datePart(r.planned_date);
    const de = datePart(r.planned_end_date || r.planned_date);
    return {
      'タイトル': r.title || '',
      '工事作業名称': r.title || '',
      '種別': PLAN_TYPE_LABELS[r.plan_type] || r.plan_type || '',
      '予定日': formatDate(r.planned_date),
      '期間終了日': formatDate(r.planned_end_date),
      '開始年': ds.y, '開始月': ds.mo, '開始日': ds.da,
      '終了年': de.y, '終了月': de.mo, '終了日': de.da,
      '日間': daysBetween(r.planned_date, r.planned_end_date),
      '設備名': r.line_name || '',
      '機器名': r.equipment_name || '',
      '点検者': r.inspector_name || '',
      '担当者': r.assignee_name || '',
      '状態': STATUS_LABELS[r.status] || r.status || '',
      '備考': r.note || '',
      '印刷日': today,
    };
  }
  return {
    '発生日時': formatDateTime(r.occurred_at),
    '設備番号': r.equipment_code || '',
    '設備名': r.equipment_name || '',
    'ジャンル': r.category_name || '',
    '現象': r.phenomenon || '',
    '原因': r.cause || '',
    '対策': r.countermeasure || '',
    '記録者': r.reporter_name || r.creator_name || '',
    '印刷日': today,
  };
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n]+/g, ' ')   // セル内改行は空白に（書式崩れ防止）
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// XML文字列中の {{タグ}} を置換する。未知タグは原文のまま残す
function replaceTags(xml, values) {
  return xml.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, raw) => {
    const tag = raw.trim();
    return Object.prototype.hasOwnProperty.call(values, tag) ? xmlEscape(values[tag]) : m;
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildFilename(type, r) {
  const base = TYPE_LABELS[type] || '帳票';
  const label = type === 'construction_notice' ? (r.title || '') : (r.phenomenon || r.equipment_name || '');
  const safe = String(label).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
  return `${base}${safe ? '_' + safe : ''}.xlsx`;
}

// テンプレートが複数ある場合の選択シート
function chooseTemplate(templates) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'sheet-backdrop' });
    const done = (v) => { backdrop.remove(); resolve(v); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    backdrop.appendChild(el('div', { class: 'sheet' }, [
      el('div', { class: 'sheet-title' }, '帳票テンプレートを選択'),
      ...templates.map((t) => el('button', { class: 'sheet-btn', onclick: () => done(t) }, t.name)),
      el('button', { class: 'sheet-btn sheet-cancel', onclick: () => done(null) }, 'キャンセル'),
    ]));
    document.body.appendChild(backdrop);
  });
}

// 入力タグ（fields_json）の値を画面フォームで集める。キャンセルは null を返す
function collectInputs(title, inputFields) {
  return new Promise((resolve) => {
    const getters = [];
    const rows = inputFields.map((f) => {
      const tag = f.tag;
      if (f.type === 'check') {
        const cb = el('input', { type: 'checkbox' });
        getters.push(() => [tag, cb.checked ? CHECK_MARK : '']);
        return el('label', { class: 'pf-input-check' }, [cb, ` ${f.label || tag}（レ点）`]);
      }
      let input;
      if (f.type === 'textarea') input = el('textarea', { rows: '2' });
      else if (f.type === 'date') input = el('input', { type: 'date' });
      else if (f.type === 'time') input = el('input', { type: 'time' });
      else input = el('input', { type: 'text' });
      getters.push(() => [tag, f.type === 'date' ? formatDate(input.value) : (input.value || '')]);
      return el('div', { class: 'field' }, [el('label', {}, f.label || tag), input]);
    });

    const backdrop = el('div', { class: 'modal-backdrop' });
    const done = (val) => { backdrop.remove(); resolve(val); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    backdrop.appendChild(el('div', { class: 'modal' }, [
      el('h2', { class: 'modal-title' }, title),
      el('p', { class: 'hint' }, '入力した内容が Excel に差し込まれます（日付・設備などは計画から自動）。'),
      el('div', { class: 'pf-input-form' }, rows),
      el('div', { class: 'modal-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          onclick: () => {
            const values = {};
            for (const get of getters) { const [t, v] = get(); values[t] = v; }
            done(values);
          },
        }, '出力'),
        el('button', { class: 'btn', onclick: () => done(null) }, 'キャンセル'),
      ]),
    ]));
    document.body.appendChild(backdrop);
  });
}

async function fillAndDownload(template, type, record, inputValues) {
  const JSZip = await loadJSZip();
  const res = await fetch(`/api/files/${template.image_file_id}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`テンプレートファイルを取得できません（HTTP ${res.status}）`);
  const buf = await res.arrayBuffer();

  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('テンプレートが Excel(.xlsx) ではないようです。管理画面で Excel を登録し直してください。');
  }
  if (!zip.file('xl/workbook.xml')) {
    throw new Error('Excel(.xlsx) として読み取れませんでした。管理画面で Excel を登録し直してください。');
  }

  // 自動タグ＋入力タグをマージ（入力タグ優先）
  const values = { ...buildValues(type, record), ...(inputValues || {}) };
  const targets = Object.keys(zip.files).filter(
    (p) => p === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(p)
  );
  for (const path of targets) {
    const xml = await zip.file(path).async('string');
    zip.file(path, replaceTags(xml, values));
  }

  const outBlob = await zip.generateAsync({ type: 'blob', mimeType: XLSX_MIME });
  downloadBlob(outBlob, buildFilename(type, record));
}

/**
 * 帳票（Excel差込）を出力する。入力項目が定義されていればフォームを表示し、
 * 入力後にタグを置換した .xlsx をダウンロードする。PDF は Excel で「PDFで保存」。
 * @param {'construction_notice'|'trouble_report'} type
 * @param {object} record 取得済みの plan / trouble オブジェクト
 */
export async function openExcelExport(type, record) {
  let templates = [];
  try {
    ({ templates } = await api.get('/api/print-templates'));
  } catch (err) {
    alert(`帳票テンプレートの取得に失敗しました: ${err.message}`);
    return;
  }
  const matches = (templates || []).filter((t) => t.template_type === type && t.image_file_id);
  if (matches.length === 0) {
    alert(`「${TYPE_LABELS[type] || type}」の Excel テンプレートが登録されていません。\n管理画面の「帳票テンプレート」から登録してください。`);
    return;
  }
  const template = matches.length === 1 ? matches[0] : await chooseTemplate(matches);
  if (!template) return;

  // テンプレートに定義された入力項目を画面で集める
  let inputFields = [];
  try {
    const parsed = JSON.parse(template.fields_json || '[]');
    if (Array.isArray(parsed)) inputFields = parsed.filter((f) => f && f.tag);
  } catch { inputFields = []; }

  let inputValues = {};
  if (inputFields.length > 0) {
    const collected = await collectInputs(`${TYPE_LABELS[type] || '帳票'}の入力`, inputFields);
    if (collected === null) return; // キャンセル
    inputValues = collected;
  }

  try {
    await fillAndDownload(template, type, record, inputValues);
  } catch (err) {
    alert(`帳票の出力に失敗しました: ${err.message}`);
  }
}
