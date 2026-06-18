// 01 保全計画 — 年間計画CSV取込
//   年間計画表の出力CSV（行=タスク／列=12ヶ月）と同じ形式を取り込む。
//   ・種別/タスク/設備名/機器名/点検者/担当者 はヘッダー自動判定（必要なら手動マッピング）
//   ・各月セル（1月..12月）に値があればその月の予定を作成、「未定」列は未定枠で作成
//   ・全件 annual_only=1 で登録（カレンダーには出さず年間計画表専用）
//   ・/api/plans/batch（最大120件）へ100件ずつ分割送信する

import { api } from '/js/api.js';
import { el, render } from '/js/util.js';

const app = document.getElementById('app');

// 固定項目（マッピング対象）。aliases のいずれかに見出しが一致すれば自動検出する
const FIELD_DEFS = [
  { key: 'plan_type',      label: '種別',   aliases: ['種別', 'plan_type'] },
  { key: 'title',          label: 'タスク', aliases: ['タスク', 'タイトル', 'title'], required: true },
  { key: 'line_name',      label: '設備名', aliases: ['設備名', '設備', 'line_name'] },
  { key: 'equipment_name', label: '機器名', aliases: ['機器名', 'equipment_name'] },
  { key: 'inspector_name', label: '点検者', aliases: ['点検者', 'inspector_name'] },
  { key: 'assignee_name',  label: '担当者', aliases: ['担当者', 'assignee_name'] },
];

const PLAN_TYPE_VALUES = { '点検': 'inspection', '部品交換': 'parts', '工事': 'construction', 'その他': 'other' };
const PLAN_TYPE_KEYS = new Set(['inspection', 'parts', 'construction', 'other']);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const mm = (m) => String(m).padStart(2, '0');
const BATCH_SIZE = 100; // /api/plans/batch は最大120件。安全側で100件ずつ送る

// CSVのバイト列を文字コード自動判定で文字列化（Excel/SharePoint由来のSJISとUTF-8の両対応）
function decodeCsvBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let text;
  if (typeof Encoding !== 'undefined') {
    const detected = Encoding.detect(bytes) || 'AUTO';
    const unicode = Encoding.convert(bytes, { to: 'UNICODE', from: detected });
    text = Encoding.codeToString(unicode);
  } else {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return text.replace(/^﻿/, ''); // 先頭のBOMを除去
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  return lines.map((line) => {
    const row = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { row.push(cur); cur = ''; }
      else cur += ch;
    }
    row.push(cur);
    return row;
  });
}

export function renderPlanImport(year, onDone) {
  let csvHeaders = [];
  let csvRows = [];
  const mapping = {};      // fieldKey -> 列インデックス(文字列) または ''
  let monthCols = {};      // 月番号 -> 列インデックス
  let unschedCol = -1;     // 「未定」列インデックス（無ければ -1）

  const mappingBox = el('div', {}, []);
  const previewBox = el('div', {}, []);
  const resultBox  = el('div', {}, []);
  const importBtn  = el('button', { class: 'btn btn-primary', disabled: true }, '取込実行');

  const back = () => { if (typeof onDone === 'function') onDone(); };

  // ヘッダーから月列（N月）・未定列を自動検出
  const detectAutoCols = () => {
    monthCols = {};
    unschedCol = -1;
    csvHeaders.forEach((h, i) => {
      const t = String(h).trim();
      const mMatch = /^(\d{1,2})月$/.exec(t);
      if (mMatch) {
        const m = Number(mMatch[1]);
        if (m >= 1 && m <= 12) monthCols[m] = i;
      } else if (t === '未定') {
        unschedCol = i;
      }
    });
  };

  // 固定項目を見出しから自動マッピング
  const autoMapFields = () => {
    for (const def of FIELD_DEFS) {
      const idx = csvHeaders.findIndex((h) => def.aliases.includes(String(h).trim()));
      mapping[def.key] = idx >= 0 ? String(idx) : '';
    }
  };

  // CSV行 → /api/plans/batch 用の items に展開する
  const buildItems = () => {
    const items = [];
    const noMonthRows = [];
    const titleIdx = mapping.title === '' ? -1 : Number(mapping.title);
    const ptIdx = mapping.plan_type === '' ? -1 : Number(mapping.plan_type);
    const cell = (row, key) => {
      const idx = mapping[key];
      return idx === '' || idx === undefined ? '' : String(row[Number(idx)] || '').trim();
    };

    csvRows.forEach((row, ri) => {
      const title = titleIdx >= 0 ? String(row[titleIdx] || '').trim() : '';
      if (!title) return; // タイトル空行はスキップ

      const ptRaw = ptIdx >= 0 ? String(row[ptIdx] || '').trim() : '';
      const plan_type = PLAN_TYPE_VALUES[ptRaw] || (PLAN_TYPE_KEYS.has(ptRaw) ? ptRaw : 'other');

      const common = {
        title,
        plan_type,
        line_name: cell(row, 'line_name') || null,
        equipment_name: cell(row, 'equipment_name') || null,
        inspector_name: cell(row, 'inspector_name') || null,
        assignee_name: cell(row, 'assignee_name') || null,
        annual_only: 1,
      };

      let added = 0;
      for (const m of MONTHS) {
        const idx = monthCols[m];
        if (idx === undefined) continue;
        if (String(row[idx] || '').trim()) {
          items.push({ ...common, planned_date: `${year}-${mm(m)}-01` });
          added++;
        }
      }
      if (unschedCol >= 0 && String(row[unschedCol] || '').trim()) {
        items.push({ ...common, planned_date: `${year}-01-01`, unscheduled: 1 });
        added++;
      }
      if (added === 0) noMonthRows.push(ri + 2); // ヘッダー行ぶん +1、1始まり +1
    });
    return { items, noMonthRows };
  };

  const buildPreview = () => {
    if (csvRows.length === 0) { render(previewBox, []); importBtn.disabled = true; return; }
    const { items, noMonthRows } = buildItems();
    const monthList = MONTHS.filter((m) => monthCols[m] !== undefined).map((m) => `${m}月`);

    const sample = csvRows.slice(0, 5).map((row) => {
      const o = {};
      for (const def of FIELD_DEFS) {
        const idx = mapping[def.key];
        o[def.key] = idx === '' || idx === undefined ? '' : (row[Number(idx)] || '');
      }
      o._months = MONTHS.filter((m) => monthCols[m] !== undefined && String(row[monthCols[m]] || '').trim())
        .map((m) => `${m}月`).join(' ');
      if (unschedCol >= 0 && String(row[unschedCol] || '').trim()) o._months += ' 未定';
      return o;
    });

    render(previewBox, [
      el('p', { class: 'hint', style: 'margin:8px 0' },
        `${csvRows.length}行を検出 → 生成される予定 ${items.length}件`),
      el('p', { class: 'hint', style: 'margin:0 0 8px' },
        `検出した月列: ${monthList.join(' ') || 'なし'}${unschedCol >= 0 ? ' / 未定' : ''}`),
      monthList.length === 0 && unschedCol < 0
        ? el('p', { class: 'notice is-error', style: 'font-size:12px' },
            '月列（1月〜12月）も「未定」列も見つかりません。出力CSVと同じ見出しか確認してください。')
        : null,
      noMonthRows.length > 0
        ? el('p', { class: 'notice is-warning', style: 'font-size:12px' },
            `⚠ 実施月の指定が無い行はスキップします（行: ${noMonthRows.slice(0, 10).join(', ')}${noMonthRows.length > 10 ? ' …' : ''}）`)
        : null,
      el('div', { style: 'overflow-x:auto' }, [
        el('table', { class: 'import-table' }, [
          el('thead', {}, [el('tr', {}, [
            ...FIELD_DEFS.map((d) => el('th', {}, d.label)),
            el('th', {}, '実施月'),
          ])]),
          el('tbody', {}, sample.map((o) => el('tr', {}, [
            ...FIELD_DEFS.map((d) => el('td', {}, d.key === 'plan_type'
              ? (PLAN_TYPE_VALUES[o[d.key]] ? o[d.key] : (PLAN_TYPE_KEYS.has(String(o[d.key]).trim()) ? o[d.key] : (o[d.key] ? `${o[d.key]}→その他` : '')))
              : (o[d.key] || ''))),
            el('td', {}, o._months || '—'),
          ]))),
        ]),
      ]),
    ]);
    importBtn.disabled = items.length === 0;
  };

  const buildMapping = () => {
    render(mappingBox, [
      el('p', { class: 'hint', style: 'margin:8px 0' }, 'CSVの列とアプリ項目の対応（自動検出済み・必要なら変更）:'),
      ...FIELD_DEFS.map((def) => {
        const sel = el('select', {
          onchange: (e) => { mapping[def.key] = e.target.value; buildPreview(); },
        }, [
          el('option', { value: '' }, '— 対応なし'),
          ...csvHeaders.map((h, i) => el('option', { value: String(i) }, `[${i + 1}] ${h}`)),
        ]);
        sel.value = mapping[def.key] || '';
        return el('div', { class: 'field-pair' }, [
          el('div', { class: 'field', style: 'flex:0 0 110px' }, [
            el('label', {}, def.label + (def.required ? '（必須）' : '')),
          ]),
          el('div', { class: 'field', style: 'flex:1' }, [sel]),
        ]);
      }),
    ]);
  };

  const onFile = async (file) => {
    render(resultBox, []);
    if (!file) return;
    let all;
    try {
      const buffer = await file.arrayBuffer();
      all = parseCSV(decodeCsvBuffer(buffer));
    } catch (err) {
      render(resultBox, el('p', { class: 'notice is-error' }, `CSVの読み込みに失敗しました: ${err.message}`));
      return;
    }
    if (all.length < 2) {
      render(resultBox, el('p', { class: 'notice is-error' }, 'データ行がありません（ヘッダー＋1行以上が必要です）。'));
      return;
    }
    csvHeaders = all[0].map((h) => String(h).trim());
    csvRows = all.slice(1).filter((r) => r.some((c) => String(c || '').trim() !== ''));
    autoMapFields();
    detectAutoCols();
    buildMapping();
    buildPreview();
  };

  importBtn.onclick = async () => {
    const { items } = buildItems();
    if (items.length === 0) { alert('登録できる予定がありません。'); return; }
    importBtn.disabled = true;
    importBtn.textContent = '取込中…';
    try {
      let created = 0;
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const res = await api.post('/api/plans/batch', { items: items.slice(i, i + BATCH_SIZE) });
        created += res.created || 0;
      }
      render(resultBox, el('p', { class: 'notice is-success' }, [
        `${created}件の予定を登録しました。`,
        el('button', { class: 'btn btn-sm', style: 'margin-left:12px', onclick: back }, '年間計画表で確認'),
      ]));
      importBtn.textContent = '取込完了';
    } catch (err) {
      render(resultBox, el('p', { class: 'notice is-error' }, `取込に失敗しました: ${err.message}`));
      importBtn.disabled = false;
      importBtn.textContent = '取込実行';
    }
  };

  const fileInput = el('input', {
    type: 'file', accept: '.csv,text/csv',
    onchange: (e) => onFile(e.target.files[0]),
  });

  render(app, el('div', { class: 'card' }, [
    el('div', { class: 'action-row', style: 'margin-bottom:8px' }, [
      el('button', { class: 'btn btn-sm', onclick: back }, '← 年間計画表へ戻る'),
    ]),
    el('h2', { class: 'card-title' }, '年間計画 CSV取込'),
    el('p', { class: 'hint' },
      '年間計画表の出力CSVと同じ形式（行=タスク／列=1月〜12月）を取り込みます。月セルに値が入っている月の予定を作成します。既存の予定に追加されます（同じCSVを2回取り込むと重複登録になるためご注意ください）。'),
    el('div', { class: 'field' }, [el('label', {}, 'CSVファイル（UTF-8 / Shift_JIS）'), fileInput]),
    mappingBox,
    previewBox,
    el('div', { class: 'action-row' }, [importBtn]),
    resultBox,
  ]));
}
