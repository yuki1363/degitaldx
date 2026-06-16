// 点検レポート出力（02 点検 / 08 レポート出力）
//   点検記録を期間・設備で絞り込み、点検項目を自由に組み合わせて
//   CSV（UTF-8/BOM・Shift_JIS）/ PDF（印刷）で出力する。
//   形式: 明細（項目ごと1行）/ 一覧（点検ごと1行・項目を列）。日付ごとの区切りも可。
//   URL: /pages/inspection-report

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render, formatDateTime } from '/js/util.js';
import { buildCsvText, downloadCsv } from '/js/csv.js';

const app = document.getElementById('app');

// ---- 状態 ----
let inspections = [];          // 取得した点検（items 込み）
let itemNames = [];            // 全点検に出現する項目名（出現順）
const selectedItems = new Set(); // 出力対象に選んだ項目名
let layout = 'detail';         // 'detail'（明細）| 'list'（一覧）
let groupByDate = false;       // 日付ごとに区切る
let reportTitle = '点検レポート';
let metaFrom = '';
let metaTo = '';
let metaEquip = '全設備';

// ---- 値の整形 ----
function fmtVal(item) {
  if (!item) return '';
  if (item.input_type === 'ok_ng') return item.value === 'ok' ? 'OK' : 'NG';
  if (item.input_type === 'number') {
    return item.unit ? `${item.value} ${item.unit}` : `${item.value}`;
  }
  return String(item.value ?? '');
}
const dateOf = (insp) => (insp.inspected_at || '').slice(0, 10);

// ---- データ取得 ----
async function loadData(filters) {
  const p = new URLSearchParams();
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  if (filters.equipment_id) p.set('equipment_id', filters.equipment_id);
  if (filters.abnormal_only) p.set('abnormal_only', '1');

  const { inspections: rows } = await api.get(`/api/inspections/export?${p}`);
  inspections = rows || [];

  // 出現する項目名を出現順で集約（列・行の選択肢になる）
  const seen = new Set();
  itemNames = [];
  for (const insp of inspections) {
    for (const it of insp.items || []) {
      if (it && it.name && !seen.has(it.name)) { seen.add(it.name); itemNames.push(it.name); }
    }
  }
  selectedItems.clear();
  itemNames.forEach((n) => selectedItems.add(n));
}

// ---- 出力行の構築 ----
// 明細（ロング）: 1点検 × 1項目 = 1行
function buildDetailRows() {
  const rows = [];
  for (const insp of inspections) {
    for (const it of insp.items || []) {
      if (!selectedItems.has(it.name)) continue;
      rows.push({
        date: dateOf(insp),
        datetime: formatDateTime(insp.inspected_at),
        equipment_code: insp.equipment_code || '',
        equipment_name: insp.equipment_name || '',
        assignee: insp.assignee_name || '',
        item: it.name,
        value: fmtVal(it),
        judge: it.abnormal ? '異常' : '',
        note: insp.note || '',
      });
    }
  }
  return rows;
}

// 一覧（ワイド）: 1点検 = 1行、選択項目を列に
function selectedItemList() {
  return itemNames.filter((n) => selectedItems.has(n));
}
function inspItemMap(insp) {
  const m = new Map();
  for (const it of insp.items || []) m.set(it.name, it);
  return m;
}

// ---- CSV 出力 ----
function exportCsv(enc) {
  const dateStr = new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
  let text;

  if (layout === 'detail') {
    const columns = [
      { label: '点検日時', value: (r) => r.datetime },
      { label: '設備番号', value: (r) => r.equipment_code },
      { label: '設備',     value: (r) => r.equipment_name },
      { label: '担当者',   value: (r) => r.assignee },
      { label: '点検項目', value: (r) => r.item },
      { label: '値',       value: (r) => r.value },
      { label: '判定',     value: (r) => r.judge },
      { label: '備考',     value: (r) => r.note },
    ];
    const rows = buildDetailRows();
    if (rows.length === 0) { alert('出力対象がありません。'); return; }
    text = buildCsvText(rows, columns);
  } else {
    const items = selectedItemList();
    if (items.length === 0) { alert('出力する項目を1つ以上選んでください。'); return; }
    const columns = [
      { label: '点検日時', value: (insp) => formatDateTime(insp.inspected_at) },
      { label: '設備番号', value: (insp) => insp.equipment_code || '' },
      { label: '設備',     value: (insp) => insp.equipment_name || '' },
      { label: '担当者',   value: (insp) => insp.assignee_name || '' },
      ...items.map((name) => ({
        label: name,
        value: (insp) => {
          const it = inspItemMap(insp).get(name);
          if (!it) return '';
          return fmtVal(it) + (it.abnormal ? ' ⚠異常' : '');
        },
      })),
      { label: '全体判定', value: (insp) => (insp.has_abnormal ? '異常あり' : '正常') },
      { label: '備考',     value: (insp) => insp.note || '' },
    ];
    if (inspections.length === 0) { alert('出力対象がありません。'); return; }
    text = buildCsvText(inspections, columns);
  }

  downloadCsv(`inspection_report_${dateStr}.csv`, text, enc);
}

// ---- プレビュー描画 ----
const previewBox = el('div', {});

function renderPreview() {
  // 印刷見出し（PDF/印刷時のみ表示）
  const printHeader = el('div', { class: 'print-only report-print-header' }, [
    el('h2', {}, reportTitle),
    el('p', {}, [
      metaFrom || metaTo ? `期間: ${metaFrom || '—'} 〜 ${metaTo || '—'}　` : '',
      `対象: ${metaEquip}　`,
      `出力日: ${new Date().toLocaleDateString('sv-SE')}`,
    ].join('')),
  ]);

  if (inspections.length === 0) {
    render(previewBox, [printHeader, el('p', { class: 'empty' }, '該当する点検記録がありません。条件を変えて「読み込み」してください。')]);
    return;
  }

  const countText = el('p', { class: 'report-count' },
    `点検 ${inspections.length}件${layout === 'detail' ? `／明細 ${buildDetailRows().length}行` : ''}`);

  const table = layout === 'detail' ? buildDetailTable() : buildWideTable();

  render(previewBox, [
    printHeader,
    el('div', { class: 'report-actions no-print' }, [
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv('UTF-8') }, '📥 CSV（UTF-8/BOM）'),
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv('sjis') }, '📥 CSV（Shift_JIS）'),
      el('button', { class: 'btn btn-sm btn-primary', onclick: () => window.print() }, '🖨 PDF / 印刷'),
    ]),
    countText,
    el('div', { class: 'report-table-wrap' }, [table]),
  ]);
}

// 明細テーブル（必要なら日付ごとに見出し行を挿入）
function buildDetailTable() {
  const rows = buildDetailRows();
  const head = el('tr', {}, ['点検日時', '設備', '担当者', '点検項目', '値', '判定', '備考'].map((h) => el('th', {}, h)));
  const body = [];
  let lastDate = null;
  for (const r of rows) {
    if (groupByDate && r.date !== lastDate) {
      lastDate = r.date;
      body.push(el('tr', { class: 'report-date-row' }, [el('td', { colspan: '7' }, `📅 ${r.date}`)]));
    }
    body.push(el('tr', r.judge ? { class: 'is-abn-row' } : {}, [
      el('td', {}, r.datetime),
      el('td', {}, `${r.equipment_code} ${r.equipment_name}`.trim()),
      el('td', {}, r.assignee || '—'),
      el('td', {}, r.item),
      el('td', {}, r.value),
      el('td', {}, r.judge ? '⚠ 異常' : ''),
      el('td', {}, r.note || ''),
    ]));
  }
  return el('table', { class: 'report-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]);
}

// 一覧テーブル（点検ごと1行・選択項目を列）
function buildWideTable() {
  const items = selectedItemList();
  const headCells = ['点検日時', '設備', '担当者', ...items, '全体判定', '備考'];
  const head = el('tr', {}, headCells.map((h) => el('th', {}, h)));
  const colCount = headCells.length;
  const body = [];
  let lastDate = null;
  for (const insp of inspections) {
    if (groupByDate) {
      const d = dateOf(insp);
      if (d !== lastDate) {
        lastDate = d;
        body.push(el('tr', { class: 'report-date-row' }, [el('td', { colspan: String(colCount) }, `📅 ${d}`)]));
      }
    }
    const m = inspItemMap(insp);
    body.push(el('tr', insp.has_abnormal ? { class: 'is-abn-row' } : {}, [
      el('td', {}, formatDateTime(insp.inspected_at)),
      el('td', {}, `${insp.equipment_code || ''} ${insp.equipment_name || ''}`.trim()),
      el('td', {}, insp.assignee_name || '—'),
      ...items.map((name) => {
        const it = m.get(name);
        return el('td', it && it.abnormal ? { class: 'is-abn-cell' } : {},
          it ? fmtVal(it) + (it.abnormal ? ' ⚠' : '') : '—');
      }),
      el('td', {}, insp.has_abnormal ? '異常あり' : '正常'),
      el('td', {}, insp.note || ''),
    ]));
  }
  return el('table', { class: 'report-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]);
}

// ---- 項目（列）選択UI ----
function buildItemPicker() {
  if (itemNames.length === 0) return el('p', { class: 'hint' }, '点検項目がありません。');
  const checks = itemNames.map((name) => {
    const cb = el('input', {
      type: 'checkbox', checked: selectedItems.has(name),
      onchange: (e) => {
        if (e.target.checked) selectedItems.add(name); else selectedItems.delete(name);
        renderPreview();
      },
    });
    return el('label', { class: 'report-item-check' }, [cb, ` ${name}`]);
  });
  const selectAll = (on) => {
    selectedItems.clear();
    if (on) itemNames.forEach((n) => selectedItems.add(n));
    buildAndRenderControls();
    renderPreview();
  };
  return el('div', {}, [
    el('div', { class: 'report-pick-actions' }, [
      el('button', { class: 'btn btn-sm', onclick: () => selectAll(true) }, 'すべて選択'),
      el('button', { class: 'btn btn-sm', onclick: () => selectAll(false) }, 'すべて解除'),
    ]),
    el('div', { class: 'report-item-list' }, checks),
  ]);
}

// ---- フィルタ＋オプションUI ----
const today = new Date();
const defFrom = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('sv-SE');
const defTo = today.toLocaleDateString('sv-SE');

let equipment = [];
const fromInput = el('input', { type: 'date', value: defFrom });
const toInput = el('input', { type: 'date', value: defTo });
const abnormalToggle = el('input', { type: 'checkbox' });
let equipSelect; // 後で構築

const controlsBox = el('div', {}); // 形式・日付区切り・項目選択（読み込み後に表示）

function buildAndRenderControls() {
  if (inspections.length === 0) { render(controlsBox, []); return; }
  const layoutSel = el('select', {
    onchange: (e) => { layout = e.target.value; renderPreview(); },
  }, [
    el('option', { value: 'detail', selected: layout === 'detail' }, '明細（項目ごとに1行）'),
    el('option', { value: 'list', selected: layout === 'list' }, '一覧（点検ごとに1行・項目を列）'),
  ]);
  const groupCb = el('input', {
    type: 'checkbox', checked: groupByDate,
    onchange: (e) => { groupByDate = e.target.checked; renderPreview(); },
  });

  render(controlsBox, [
    el('div', { class: 'card no-print' }, [
      el('h3', { class: 'card-title' }, '出力オプション'),
      el('div', { class: 'field' }, [el('label', {}, '形式'), layoutSel]),
      el('label', { class: 'report-item-check' }, [groupCb, ' 日付ごとに区切る']),
      el('div', { class: 'field' }, [
        el('label', {}, '出力する点検項目（自由に組み合わせ）'),
        buildItemPicker(),
      ]),
    ]),
  ]);
}

async function runLoad() {
  render(previewBox, el('p', { class: 'loading' }, '読み込み中…'));
  metaFrom = fromInput.value;
  metaTo = toInput.value;
  metaEquip = equipSelect.value
    ? (equipment.find((e) => String(e.id) === equipSelect.value)?.name || '指定設備')
    : '全設備';
  try {
    await loadData({
      from: fromInput.value,
      to: toInput.value,
      equipment_id: equipSelect.value,
      abnormal_only: abnormalToggle.checked,
    });
    buildAndRenderControls();
    renderPreview();
  } catch (err) {
    render(previewBox, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
}

async function renderPage() {
  ({ equipment } = await api.get('/api/equipment'));
  equipSelect = el('select', {}, [
    el('option', { value: '' }, '全設備'),
    ...equipment.map((e) => el('option', { value: e.id }, `${e.code} ${e.name}`)),
  ]);

  render(app, [
    el('div', { class: 'card no-print' }, [
      el('h2', { class: 'card-title' }, '点検レポート出力'),
      el('p', { class: 'hint' }, '期間・設備で絞り込み、点検項目を自由に選んで CSV / PDF に出力できます。'),
      el('div', { class: 'field-pair' }, [
        el('div', { class: 'field' }, [el('label', {}, '開始日'), fromInput]),
        el('div', { class: 'field' }, [el('label', {}, '終了日'), toInput]),
      ]),
      el('div', { class: 'field' }, [el('label', {}, '設備'), equipSelect]),
      el('label', { class: 'report-item-check' }, [abnormalToggle, ' 異常ありのみ']),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => runLoad() }, '🔍 読み込み'),
      ]),
    ]),
    controlsBox,
    previewBox,
  ]);

  // 初期表示で当月分を読み込む
  await runLoad();
}

(async () => {
  try {
    await getCurrentUser();
    await renderPage();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
