// 08 ダッシュボード — サマリー/グラフ・抽出レポート・CSV/PDF出力

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render, formatDateTime } from '/js/util.js';

const app = document.getElementById('app');

// ---------------- CSVエクスポート ----------------

function escCsv(v) {
  const s = v == null ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsvText(rows, columns) {
  const header = columns.map((c) => escCsv(c.label)).join(',');
  const body   = rows.map((r) => columns.map((c) => escCsv(c.value(r))).join(',')).join('\n');
  return header + '\n' + body;
}

function downloadCsv(filename, text, encoding) {
  let blob;
  if (encoding === 'sjis' && typeof Encoding !== 'undefined') {
    const sjisArray = Encoding.convert(
      Encoding.stringToCode(text),
      { to: 'SJIS', from: 'UNICODE' }
    );
    blob = new Blob([new Uint8Array(sjisArray)], { type: 'text/csv' });
  } else {
    // UTF-8 with BOM（Excel で文字化けしない）
    blob = new Blob(['﻿' + text], { type: 'text/csv; charset=utf-8' });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- グラフ描画 ----------------

const CHART_COLORS = {
  blue:   'rgba(30,64,175,0.85)',
  orange: 'rgba(234,88,12,0.85)',
  green:  'rgba(21,128,61,0.85)',
  purple: 'rgba(107,33,168,0.85)',
  red:    'rgba(220,38,38,0.85)',
  teal:   'rgba(17,94,89,0.85)',
  indigo: 'rgba(67,56,202,0.85)',
  yellow: 'rgba(161,98,7,0.85)',
};
const PALETTE = Object.values(CHART_COLORS);

function makeCanvas(id) {
  return el('canvas', { id, style: 'max-height:240px' });
}

function destroyChart(id) {
  const existing = Chart.getChart(id);
  if (existing) existing.destroy();
}

function drawTroubleTrend(canvasId, data) {
  destroyChart(canvasId);
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels:   data.map((d) => d.month),
      datasets: [{ label: 'トラブル件数', data: data.map((d) => d.count), backgroundColor: CHART_COLORS.blue }],
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
  });
}

function drawTroubleByCategory(canvasId, data) {
  destroyChart(canvasId);
  new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: {
      labels:   data.map((d) => d.category_name),
      datasets: [{ data: data.map((d) => d.count), backgroundColor: PALETTE.slice(0, data.length) }],
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } },
  });
}

function drawEquipmentRanking(canvasId, data) {
  destroyChart(canvasId);
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels:   data.slice(0, 8).map((d) => d.equipment_name),
      datasets: [{ label: 'トラブル件数', data: data.slice(0, 8).map((d) => d.trouble_count), backgroundColor: CHART_COLORS.orange }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  });
}

function drawRepairSummary(canvasId, summary) {
  destroyChart(canvasId);
  const STATUS_LABELS = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };
  const keys = ['open', 'in_progress', 'waiting_parts', 'done'];
  const values = keys.map((k) => summary[k] ?? 0);
  new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: {
      labels:   keys.map((k) => STATUS_LABELS[k]),
      datasets: [{ data: values, backgroundColor: [CHART_COLORS.blue, CHART_COLORS.orange, CHART_COLORS.purple, CHART_COLORS.green] }],
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } },
  });
}

// ---------------- サマリータブ ----------------

async function renderSummary(fromStr, toStr) {
  render(app.querySelector('#tab-content'), el('p', { class: 'loading' }, '集計中…'));
  const stats = await api.get(`/api/stats?from=${fromStr}&to=${toStr}`);

  const rateText = stats.inspection_rate.rate !== null
    ? `${stats.inspection_rate.rate}%（${stats.inspection_rate.done}/${stats.inspection_rate.planned}件）`
    : 'データなし';

  const openRepairs = (stats.repair_summary.open ?? 0) + (stats.repair_summary.in_progress ?? 0) + (stats.repair_summary.waiting_parts ?? 0);

  const canTrend    = makeCanvas('chart-trend');
  const canCategory = makeCanvas('chart-category');
  const canRanking  = makeCanvas('chart-ranking');
  const canRepair   = makeCanvas('chart-repair');

  render(app.querySelector('#tab-content'), [
    // サマリーカード
    el('div', { class: 'summary-grid' }, [
      el('div', { class: 'summary-card' }, [
        el('div', { class: 'summary-label' }, 'トラブル'),
        el('div', { class: 'summary-value' }, String(stats.activity.troubles)),
        el('div', { class: 'summary-period' }, '期間内'),
      ]),
      el('div', { class: 'summary-card' }, [
        el('div', { class: 'summary-label' }, '依頼（未完了）'),
        el('div', { class: 'summary-value', style: openRepairs > 0 ? 'color:#b45309' : '' }, String(openRepairs)),
        el('div', { class: 'summary-period' }, '全期間'),
      ]),
      el('div', { class: 'summary-card' }, [
        el('div', { class: 'summary-label' }, '点検達成率'),
        el('div', { class: 'summary-value' }, stats.inspection_rate.rate !== null ? `${stats.inspection_rate.rate}%` : '—'),
        el('div', { class: 'summary-period' }, rateText),
      ]),
      el('div', { class: 'summary-card' }, [
        el('div', { class: 'summary-label' }, '日報'),
        el('div', { class: 'summary-value' }, String(stats.activity.reports)),
        el('div', { class: 'summary-period' }, '期間内'),
      ]),
    ]),

    // グラフ群
    el('div', { class: 'chart-grid' }, [
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, 'トラブル月別推移'),
        stats.trouble_trend.length > 0 ? canTrend : el('p', { class: 'empty' }, 'データがありません'),
      ]),
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, 'ジャンル別トラブル'),
        stats.trouble_by_category.length > 0 ? canCategory : el('p', { class: 'empty' }, 'データがありません'),
      ]),
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, '設備別故障ランキング'),
        stats.equipment_ranking.length > 0 ? canRanking : el('p', { class: 'empty' }, 'データがありません'),
      ]),
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, '業務依頼 ステータス内訳'),
        Object.keys(stats.repair_summary).length > 0 ? canRepair : el('p', { class: 'empty' }, 'データがありません'),
      ]),
    ]),
  ]);

  // グラフ描画（DOMに追加後）
  if (stats.trouble_trend.length > 0)         drawTroubleTrend('chart-trend', stats.trouble_trend);
  if (stats.trouble_by_category.length > 0)   drawTroubleByCategory('chart-category', stats.trouble_by_category);
  if (stats.equipment_ranking.length > 0)     drawEquipmentRanking('chart-ranking', stats.equipment_ranking);
  if (Object.keys(stats.repair_summary).length > 0) drawRepairSummary('chart-repair', stats.repair_summary);
}

// ---------------- 抽出レポートタブ ----------------

const TYPE_CONFIG = {
  trouble:    { label: 'トラブル',  color: '#b45309', bg: '#fef3c7', dateField: 'occurred_at', titleField: 'phenomenon' },
  inspection: { label: '点検',      color: '#1e40af', bg: '#dbeafe', dateField: 'inspected_at', titleField: null },
  repair:     { label: '業務依頼',  color: '#6b21a8', bg: '#f3e8ff', dateField: 'created_at',  titleField: 'title' },
  report:     { label: '日報',      color: '#15803d', bg: '#dcfce7', dateField: 'report_date',  titleField: null },
};

async function renderExtract(fromStr, toStr) {
  const contentEl = app.querySelector('#tab-content');
  render(contentEl, el('p', { class: 'loading' }, '読み込み中…'));

  const [{ equipment }, { categories }, { categories: reportCats }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/troubles/categories'),
    api.get('/api/reports/categories'),
  ]);

  let types      = ['trouble', 'inspection', 'repair', 'report'];
  let equipId    = '';
  let categoryId = '';
  let currentFrom = fromStr;
  let currentTo   = toStr;
  const tableBox = el('div', {}, []);

  const fetchAndRender = async () => {
    render(tableBox, el('p', { class: 'loading' }, '読み込み中…'));
    try {
      const fetches = [];

      if (types.includes('trouble')) {
        const p = new URLSearchParams({ from: currentFrom, to: currentTo });
        if (equipId)    p.set('equipment_id', equipId);
        if (categoryId) p.set('category_id', categoryId);
        fetches.push(api.get(`/api/troubles?${p}`).then(({ troubles }) =>
          troubles.map((t) => ({ _type: 'trouble', _date: t.occurred_at?.slice(0, 10), _title: t.phenomenon, _equipment: t.equipment_name, _person: t.reporter_name, _status: null, _id: t.id, ...t }))
        ));
      }
      if (types.includes('inspection')) {
        const p = new URLSearchParams();
        if (equipId) p.set('equipment_id', equipId);
        fetches.push(api.get(`/api/inspections${p.size ? '?' + p : ''}`).then(({ inspections }) =>
          inspections
            .filter((i) => {
              const d = i.inspected_at?.slice(0, 10) || '';
              return d >= currentFrom && d <= currentTo;
            })
            .map((i) => ({ _type: 'inspection', _date: i.inspected_at?.slice(0, 10), _title: `${i.equipment_name || ''}の点検`, _equipment: i.equipment_name, _person: i.assignee_name, _status: i.has_abnormal ? '異常あり' : '正常', _id: i.id, ...i }))
        ));
      }
      if (types.includes('repair')) {
        const p = new URLSearchParams();
        if (equipId) p.set('equipment_id', equipId);
        fetches.push(api.get(`/api/repairs${p.size ? '?' + p : ''}`).then(({ repairs }) =>
          repairs
            .filter((r) => {
              const d = r.created_at?.slice(0, 10) || '';
              return d >= currentFrom && d <= currentTo;
            })
            .map((r) => ({ _type: 'repair', _date: r.created_at?.slice(0, 10), _title: r.title, _equipment: r.equipment_name, _person: r.assignee_name, _status: r.status, _id: r.id, ...r }))
        ));
      }
      if (types.includes('report')) {
        const p = new URLSearchParams({ from: currentFrom, to: currentTo });
        if (categoryId) p.set('category_id', categoryId);
        fetches.push(api.get(`/api/reports?${p}`).then(({ reports }) =>
          reports.map((r) => ({ _type: 'report', _date: r.report_date, _title: r.body.slice(0, 60), _equipment: null, _person: r.reporter_name, _status: r.category_name, _id: r.id, ...r }))
        ));
      }

      const results = (await Promise.all(fetches)).flat();
      results.sort((a, b) => (b._date || '').localeCompare(a._date || ''));

      if (results.length === 0) {
        render(tableBox, el('p', { class: 'empty' }, '該当データがありません。'));
        return;
      }

      const STATUS_REPAIR = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };

      render(tableBox, [
        el('p', { style: 'font-size:13px;color:#64748b;margin:4px 0 8px' }, `${results.length}件`),
        el('div', { style: 'overflow-x:auto' }, [
          el('table', { class: 'extract-table' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', {}, '種別'),
                el('th', {}, '日付'),
                el('th', {}, '設備'),
                el('th', {}, '内容'),
                el('th', {}, '担当/記録者'),
                el('th', {}, '状態'),
              ]),
            ]),
            el('tbody', {}, results.map((row) => {
              const cfg = TYPE_CONFIG[row._type] || {};
              return el('tr', {}, [
                el('td', {}, el('span', { class: 'type-badge', style: `background:${cfg.bg};color:${cfg.color}` }, cfg.label || row._type)),
                el('td', {}, row._date || ''),
                el('td', {}, row._equipment || '—'),
                el('td', {}, el('a', { href: `${LINKED_TYPE_URLS[row._type]}${row._id}`, class: 'table-link' }, row._title || '—')),
                el('td', {}, row._person || '—'),
                el('td', {}, STATUS_REPAIR[row._status] || row._status || '—'),
              ]);
            })),
          ]),
        ]),

        el('div', { class: 'action-row', style: 'margin-top:8px' }, [
          el('button', { class: 'btn btn-sm', onclick: () => exportCsv(results, 'UTF-8') }, '📥 CSV（UTF-8/BOM）'),
          el('button', { class: 'btn btn-sm', onclick: () => exportCsv(results, 'sjis')   }, '📥 CSV（Shift_JIS）'),
          el('button', { class: 'btn btn-sm', onclick: () => window.print() }, '🖨 印刷/PDF'),
        ]),
      ]);
    } catch (err) {
      render(tableBox, el('p', { class: 'notice is-error' }, err.message));
    }
  };

  const exportCsv = (rows, enc) => {
    const STATUS_REPAIR = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };
    const columns = [
      { label: '種別',         value: (r) => TYPE_CONFIG[r._type]?.label || r._type },
      { label: '日付',         value: (r) => r._date || '' },
      { label: '設備',         value: (r) => r._equipment || '' },
      { label: '内容',         value: (r) => r._title || '' },
      { label: '担当/記録者',  value: (r) => r._person || '' },
      { label: '状態',         value: (r) => STATUS_REPAIR[r._status] || r._status || '' },
    ];
    const text = buildCsvText(rows, columns);
    const dateStr = new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
    downloadCsv(`report_${dateStr}.csv`, text, enc);
  };

  // フィルタUI
  const typeCheckboxes = Object.entries(TYPE_CONFIG).map(([type, cfg]) => {
    const cb = el('input', { type: 'checkbox', checked: true, id: `type-${type}`, onchange: () => {
      types = Object.keys(TYPE_CONFIG).filter((t) => document.getElementById(`type-${t}`)?.checked);
      fetchAndRender().catch(() => {});
    }});
    return el('label', { class: 'type-check', style: `background:${cfg.bg};color:${cfg.color}` }, [cb, ` ${cfg.label}`]);
  });

  const fromInput = el('input', { type: 'date', value: currentFrom, onchange: (e) => { currentFrom = e.target.value; fetchAndRender().catch(() => {}); }});
  const toInput   = el('input', { type: 'date', value: currentTo,   onchange: (e) => { currentTo   = e.target.value; fetchAndRender().catch(() => {}); }});

  const equipSel = el('select', { onchange: (e) => { equipId = e.target.value; fetchAndRender().catch(() => {}); }}, [
    el('option', { value: '' }, '全設備'),
    ...equipment.map((e) => el('option', { value: e.id }, `${e.code} ${e.name}`)),
  ]);

  const allCats = [
    ...categories.map((c) => ({ ...c, _type: 'trouble' })),
    ...reportCats.map((c) => ({ ...c, _type: 'report' })),
  ];
  const catSel = el('select', { onchange: (e) => { categoryId = e.target.value; fetchAndRender().catch(() => {}); }}, [
    el('option', { value: '' }, '全カテゴリ/ジャンル'),
    ...allCats.map((c) => el('option', { value: c.id }, `${c.name}`)),
  ]);

  render(contentEl, [
    el('div', { class: 'filter-bar' }, typeCheckboxes),
    el('div', { class: 'filter-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromInput]),
      el('label', { class: 'filter-label' }, ['TO ', toInput]),
    ]),
    el('div', { class: 'filter-bar' }, [equipSel, catSel]),
    tableBox,
  ]);
  await fetchAndRender();
}

const LINKED_TYPE_URLS = {
  trouble:    '/pages/trouble?id=',
  inspection: '/pages/inspection?id=',
  repair:     '/pages/repair?id=',
  report:     '/pages/report?id=',
};

// ---------------- タブ付きレイアウト ----------------

async function renderDashboard() {
  // 期間デフォルト（直近6ヶ月）
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth() - 5, 1);
  const defaultFrom = firstDay.toLocaleDateString('sv-SE');
  const defaultTo   = today.toLocaleDateString('sv-SE');

  const fromInput = el('input', { type: 'date', value: defaultFrom });
  const toInput   = el('input', { type: 'date', value: defaultTo });
  const applyBtn  = el('button', { class: 'btn btn-sm', onclick: () => loadTab() }, '集計');

  let activeTab = 'summary';
  const tabContent = el('div', { id: 'tab-content' }, []);

  const tabs = [
    { id: 'summary',  label: 'サマリー/グラフ' },
    { id: 'extract',  label: '抽出レポート' },
  ];
  const tabBtns = tabs.map(({ id, label }) =>
    el('button', {
      class: `tab-btn ${id === activeTab ? 'is-active' : ''}`,
      id: `tab-btn-${id}`,
      onclick: () => {
        activeTab = id;
        tabBtns.forEach((b) => b.classList.toggle('is-active', b.id === `tab-btn-${id}`));
        loadTab();
      },
    }, label)
  );

  const loadTab = async () => {
    const from = fromInput.value || defaultFrom;
    const to   = toInput.value   || defaultTo;
    if (activeTab === 'summary') {
      await renderSummary(from, to);
    } else {
      await renderExtract(from, to);
    }
  };

  render(app, [
    el('div', { class: 'period-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromInput]),
      el('label', { class: 'filter-label' }, ['TO ', toInput]),
      applyBtn,
    ]),
    el('div', { class: 'tab-bar' }, tabBtns),
    tabContent,
  ]);

  await loadTab();
}

// ---------------- 起動 ----------------

(async () => {
  try {
    await getCurrentUser();
    if (typeof Chart === 'undefined') {
      render(app, el('p', { class: 'notice is-error' }, 'グラフライブラリの読み込みに失敗しました。インターネット接続を確認してください。'));
      return;
    }
    await renderDashboard();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
