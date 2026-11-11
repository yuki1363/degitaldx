// 08 ダッシュボード — サマリー/グラフ・カスタムグラフ
//   （抽出→表→CSV/PDF は横断検索(11)へ集約。ダッシュボードは「見る（グラフ）」に専念。
//    例外としてトラブル記録だけは、集計期間のまま CSV を出せる＝04 一覧と同じ列）

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render, toJstDateStr, jstTodayStr } from '/js/util.js';
import { buildEquipSelect } from '/js/equip-picker.js';
import { exportTroubleCsv } from '/js/trouble-csv.js';

const app = document.getElementById('app');

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

// 設備ごとの故障（トラブル）件数の一覧表。期間内にトラブルがあった全設備を出す（上位N件の制限なし）。
// 並び順（件数順／設備番号順）の切り替えと、設備名・設備番号での絞り込みができる。
function buildEquipmentCounts(rows) {
  const state = { sort: 'count', q: '' };
  const total = rows.reduce((a, r) => a + r.trouble_count, 0);
  const tbody = el('tbody');
  const note = el('p', { class: 'hint' });
  const sortBtns = {
    count: el('button', { class: 'btn btn-sm', onclick: () => setSort('count') }, '件数が多い順'),
    code: el('button', { class: 'btn btn-sm', onclick: () => setSort('code') }, '設備番号順'),
  };

  const draw = () => {
    const q = state.q.trim().toLowerCase();
    let list = rows.filter((r) => !q || `${r.equipment_code || ''} ${r.equipment_name}`.toLowerCase().includes(q));
    list = [...list].sort(state.sort === 'code'
      ? (a, b) => (a.equipment_code || '\uffff').localeCompare(b.equipment_code || '\uffff', 'ja', { numeric: true })
          || a.equipment_name.localeCompare(b.equipment_name, 'ja')
      : (a, b) => b.trouble_count - a.trouble_count
          || a.equipment_name.localeCompare(b.equipment_name, 'ja'));
    render(tbody, list.map((r) => el('tr', {}, [
      el('td', {}, r.equipment_code || '—'),
      el('td', {}, r.equipment_id
        ? el('a', { class: 'table-link', href: `/pages/ledger?id=${r.equipment_id}` }, r.equipment_name)
        : r.equipment_name),
      el('td', { style: 'text-align:right;font-weight:600' }, `${r.trouble_count}件`),
    ])));
    note.textContent = q
      ? `${list.length}設備 / 全${rows.length}設備（絞り込み中）`
      : `${rows.length}設備・合計${total}件`;
    for (const [k, b] of Object.entries(sortBtns)) b.classList.toggle('btn-primary', k === state.sort);
  };
  const setSort = (k) => { state.sort = k; draw(); };

  const search = el('input', { type: 'search', placeholder: '設備名・設備番号で絞り込み', style: 'flex:1;min-width:0' });
  search.addEventListener('input', () => { state.q = search.value; draw(); });
  draw();
  return el('div', {}, [
    el('div', { class: 'action-row', style: 'margin-bottom:8px' }, [search, sortBtns.count, sortBtns.code]),
    note,
    el('div', { style: 'max-height:420px;overflow:auto' },
      el('table', { class: 'extract-table' }, [
        el('thead', {}, el('tr', {}, [el('th', {}, '設備番号'), el('th', {}, '設備'), el('th', { style: 'text-align:right' }, '故障件数')])),
        tbody,
      ])),
  ]);
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
        el('h3', { class: 'chart-title' }, '設備別 故障件数'),
        stats.equipment_trouble_counts.length > 0
          ? buildEquipmentCounts(stats.equipment_trouble_counts)
          : el('p', { class: 'empty' }, 'データがありません'),
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
  if (Object.keys(stats.repair_summary).length > 0) drawRepairSummary('chart-repair', stats.repair_summary);
}

// ---------------- カスタムグラフタブ ----------------
//   CLAUDE.md 08: 集計軸・期間・対象設備を選択できるカスタムグラフ。
//   データはトラブル/点検/業務依頼を取得してクライアント側で集計する。
//   単一系列のため凡例は出さない（円グラフのみカテゴリ凡例）。色は既存のチャート配色に合わせる。

const CUSTOM_DATA_TYPES = {
  trouble:    { label: 'トラブル件数' },
  inspection: { label: '点検実施数' },
  repair:     { label: '業務依頼件数' },
};
const CUSTOM_AXES = {
  month:     { label: '月別' },
  category:  { label: 'ジャンル別' },   // トラブルのみ
  equipment: { label: '設備別' },
  person:    { label: '担当者・記録者別' },
};
const CUSTOM_KINDS = { bar: '棒グラフ', line: '折れ線', doughnut: '円グラフ' };

// from〜to の各月（YYYY-MM）を順に返す（最大36ヶ月で打ち切り）
function monthKeys(fromStr, toStr) {
  const keys = [];
  let cur = fromStr.slice(0, 7);
  const end = toStr.slice(0, 7);
  while (cur <= end && keys.length < 36) {
    keys.push(cur);
    const [y, m] = cur.split('-').map(Number);
    cur = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return keys;
}

// rows: { date:'YYYY-MM-DD', category, equipment, person } の配列 → 軸ごとの集計
function aggregateRows(rows, axis, fromStr, toStr) {
  if (axis === 'month') {
    const keys = monthKeys(fromStr, toStr);
    const counts = new Map(keys.map((k) => [k, 0]));
    for (const r of rows) {
      const k = (r.date || '').slice(0, 7);
      if (counts.has(k)) counts.set(k, counts.get(k) + 1);
    }
    return { labels: keys.map((k) => k.replace('-', '/')), data: keys.map((k) => counts.get(k)) };
  }
  const counts = new Map();
  for (const r of rows) {
    const k = r[axis] || '未設定';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15); // 上位15件
  return { labels: sorted.map((x) => x[0]), data: sorted.map((x) => x[1]) };
}

async function renderCustom(fromStr, toStr) {
  const contentEl = app.querySelector('#tab-content');
  render(contentEl, el('p', { class: 'loading' }, '読み込み中…'));
  const { equipment } = await api.get('/api/equipment?limit=2000');

  let dataType = 'trouble';
  let axis = 'month';
  let chartKind = 'bar';
  let equipId = '';

  const chartBox = el('div', { class: 'chart-wrap' });
  const countNote = el('p', { class: 'hint', style: 'margin:4px 0 0' }, '');

  const fetchRows = async () => {
    if (dataType === 'trouble') {
      const p = new URLSearchParams({ from: fromStr, to: toStr });
      if (equipId) p.set('equipment_id', equipId);
      const { troubles } = await api.get(`/api/troubles?${p}`);
      return (troubles || []).map((t) => ({
        date: toJstDateStr(t.occurred_at),
        category: t.category_name || '未設定',
        equipment: t.equipment_name || '設備未指定',
        person: t.reporter_name || t.creator_name || '未設定',
      }));
    }
    if (dataType === 'inspection') {
      // 期間で絞って取得する（limit=5000）。期間なし・既定200件だと、6ヶ月で200件を超えたとき古い月が黙って欠けていた
      const p = new URLSearchParams({ from: fromStr, to: toStr, limit: '5000' });
      if (equipId) p.set('equipment_id', equipId);
      const { inspections } = await api.get(`/api/inspections?${p}`);
      return (inspections || [])
        .filter((i) => { const d = toJstDateStr(i.inspected_at); return d >= fromStr && d <= toStr; })
        .map((i) => ({
          date: toJstDateStr(i.inspected_at),
          category: '—',
          equipment: i.equipment_name || '設備未指定',
          person: i.assignee_name || '未設定',
        }));
    }
    const p = new URLSearchParams();
    if (equipId) p.set('equipment_id', equipId);
    const { repairs } = await api.get(`/api/repairs${p.size ? '?' + p : ''}`);
    return (repairs || [])
      .filter((r) => { const d = toJstDateStr(r.created_at); return d >= fromStr && d <= toStr; })
      .map((r) => ({
        date: toJstDateStr(r.created_at),
        category: '—',
        equipment: r.equipment_name || '設備未指定',
        person: r.assignee_name || '未設定',
      }));
  };

  const draw = async () => {
    render(chartBox, el('p', { class: 'loading' }, '集計中…'));
    let rows;
    try { rows = await fetchRows(); }
    catch (err) { render(chartBox, el('p', { class: 'notice is-error' }, err.message)); return; }

    const { labels, data } = aggregateRows(rows, axis, fromStr, toStr);
    countNote.textContent = `対象 ${rows.length}件（${fromStr} 〜 ${toStr}）`;
    if (rows.length === 0) {
      render(chartBox, el('p', { class: 'empty' }, '該当データがありません。'));
      return;
    }
    const canvas = makeCanvas('chart-custom');
    render(chartBox, [
      el('h3', { class: 'chart-title' }, `${CUSTOM_DATA_TYPES[dataType].label} × ${CUSTOM_AXES[axis].label}`),
      canvas,
    ]);
    destroyChart('chart-custom');
    new Chart(canvas, {
      type: chartKind,
      data: {
        labels,
        datasets: [{
          label: CUSTOM_DATA_TYPES[dataType].label,
          data,
          backgroundColor: chartKind === 'doughnut' ? PALETTE.slice(0, labels.length) : CHART_COLORS.blue,
          borderColor: chartKind === 'line' ? CHART_COLORS.blue : undefined,
          fill: false,
          tension: 0.2,
        }],
      },
      options: {
        responsive: true,
        // 単一系列なので凡例は出さない（円グラフはカテゴリの識別に必要なため表示）
        plugins: { legend: chartKind === 'doughnut' ? { position: 'bottom' } : { display: false } },
        scales: chartKind === 'doughnut' ? {} : { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        // カテゴリ系の棒グラフは横棒（設備名などの長いラベルが読みやすい）
        indexAxis: chartKind === 'bar' && axis !== 'month' ? 'y' : 'x',
      },
    });
  };

  // 集計軸の選択肢はデータ種別に応じて組み替える（ジャンル別はトラブルのみ）
  const axisSel = el('select', { onchange: (e) => { axis = e.target.value; draw(); } });
  const rebuildAxisOptions = () => {
    const axes = Object.entries(CUSTOM_AXES).filter(([k]) => k !== 'category' || dataType === 'trouble');
    if (!axes.some(([k]) => k === axis)) axis = 'month';
    axisSel.replaceChildren(...axes.map(([v, { label }]) => el('option', { value: v, selected: v === axis }, label)));
  };
  const dataSel = el('select', { onchange: (e) => { dataType = e.target.value; rebuildAxisOptions(); draw(); } },
    Object.entries(CUSTOM_DATA_TYPES).map(([v, { label }]) => el('option', { value: v }, label)));
  const kindSel = el('select', { onchange: (e) => { chartKind = e.target.value; draw(); } },
    Object.entries(CUSTOM_KINDS).map(([v, label]) => el('option', { value: v }, label)));
  const equipSel = buildEquipSelect(equipment, {
    value: '',
    allLabel: '全設備',
    onchange: (e) => { equipId = e.target.value; draw(); },
  });
  rebuildAxisOptions();

  render(contentEl, [
    el('div', { class: 'filter-bar' }, [
      el('label', { class: 'filter-label' }, ['データ ', dataSel]),
      el('label', { class: 'filter-label' }, ['集計軸 ', axisSel]),
      el('label', { class: 'filter-label' }, ['グラフ ', kindSel]),
      equipSel,
    ]),
    countNote,
    chartBox,
  ]);
  await draw();
}

// ---------------- タブ付きレイアウト ----------------

async function renderDashboard() {
  // 期間デフォルト（直近6ヶ月）。端末の時刻設定に依らず JST の今日を基準にする
  // （期間は JST の日付として API が日付境界を変換するため、端末が UTC だと今日の記録が外れる）
  const defaultTo = jstTodayStr();
  const [ty, tm] = defaultTo.split('-').map(Number);
  const fromIdx = ty * 12 + (tm - 1) - 5; // 5ヶ月前の1日
  const defaultFrom = `${Math.floor(fromIdx / 12)}-${String((fromIdx % 12) + 1).padStart(2, '0')}-01`;

  const fromInput = el('input', { type: 'date', value: defaultFrom });
  const toInput   = el('input', { type: 'date', value: defaultTo });
  const applyBtn  = el('button', { class: 'btn btn-sm', onclick: () => loadTab() }, '集計');

  // トラブル記録CSV: 画面の FROM〜TO（集計期間）で /api/troubles を取得して出力（列は 04 一覧と共通）
  const exportTroubles = async (enc, btn) => {
    const from = fromInput.value || defaultFrom;
    const to   = toInput.value   || defaultTo;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '出力中…';
    try {
      const { troubles } = await api.get(`/api/troubles?${new URLSearchParams({ from, to })}`);
      if (troubles.length === 0) { alert('期間内のトラブル記録がありません。'); return; }
      exportTroubleCsv(troubles, enc);
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  const csvUtf8Btn = el('button', { class: 'btn btn-sm', onclick: () => exportTroubles('utf8', csvUtf8Btn) }, '📥 CSV（UTF-8/BOM）');
  const csvSjisBtn = el('button', { class: 'btn btn-sm', onclick: () => exportTroubles('sjis', csvSjisBtn) }, '📥 CSV（Shift_JIS）');

  let activeTab = 'summary';
  const tabContent = el('div', { id: 'tab-content' }, []);

  const tabs = [
    { id: 'summary',  label: 'サマリー/グラフ' },
    { id: 'custom',   label: 'カスタムグラフ' },
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
    if (activeTab === 'custom') {
      await renderCustom(from, to);
    } else {
      await renderSummary(from, to);
    }
  };

  render(app, [
    el('div', { class: 'period-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromInput]),
      el('label', { class: 'filter-label' }, ['TO ', toInput]),
      applyBtn,
    ]),
    el('div', { class: 'period-bar', id: 'trouble-csv-bar' }, [
      el('span', { class: 'filter-label' }, 'トラブル記録（期間内）'),
      csvUtf8Btn,
      csvSjisBtn,
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
