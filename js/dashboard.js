// 08 ダッシュボード・保全レポート — サマリー/グラフ（年度ごと・10月〜翌9月）とレポート（印刷用1枚）
//   サマリーのグラフは会計年度（10月始まり9月終わり）で固定し、「前の年度／次の年度」で切り替える。
//   期間（今週・先週・今月・先月・直近6ヶ月・FROM〜TO）とトラブルCSVはレポートタブだけで使う。
//   （抽出→表→CSV/PDF は横断検索(11)へ集約。ダッシュボードは「見る（グラフ）」に専念。
//    例外としてトラブル記録だけは、レポートの期間のまま CSV を出せる＝04 一覧と同じ列）

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render, toJstDateStr, jstTodayStr } from '/js/util.js';
import { exportTroubleCsv } from '/js/trouble-csv.js';
import { periodFor, fiscalYearOf, fiscalYearRange, fiscalMonths } from '/js/report-period.js';
import { renderReport } from '/js/report-summary.js';
import { formatDowntime } from '/js/downtime.js';

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

function drawTroubleTrend(canvasId, labels, counts) {
  destroyChart(canvasId);
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'トラブル件数', data: counts, backgroundColor: CHART_COLORS.blue }],
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

// ジャンル別の月推移（積み上げ棒グラフ）。縦＝件数、横＝年度の12か月、色＝ジャンル
function drawTroubleTrendByCategory(canvasId, labels, series) {
  destroyChart(canvasId);
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s, i) => ({ label: s.category_name, data: s.counts, backgroundColor: PALETTE[i % PALETTE.length] })),
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  });
}

// 休止時間の月推移（積み上げ棒グラフ）。縦＝時間、横＝年度の12か月、色＝休止区分
function drawDowntimeTrend(canvasId, labels, series) {
  destroyChart(canvasId);
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s, i) => ({ label: s.kind, data: s.hours, backgroundColor: PALETTE[i % PALETTE.length] })),
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${formatDowntime(Math.round(c.parsed.y * 60))}` } },
      },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: '時間' } } },
    },
  });
}

// 月×休止区分の行（分）→ 休止区分ごとの12か月ぶんの時間（合計の多い区分順）
function downtimeSeries(months, rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.kind)) map.set(r.kind, new Map());
    map.get(r.kind).set(r.month, r.minutes);
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return [...map.entries()]
    .map(([kind, byMonth]) => ({ kind, hours: months.map((m) => Math.round(((byMonth.get(m) ?? 0) / 60) * 100) / 100) }))
    .sort((a, b) => sum(b.hours) - sum(a.hours));
}

// ---------------- サマリータブ（年度ごと） ----------------

// 年度の12か月（10月〜翌9月）に合わせて、データの無い月は0件で埋める
function fillMonths(months, rows) {
  const by = new Map(rows.map((r) => [r.month, r.count]));
  return months.map((m) => by.get(m) ?? 0);
}

// 月×ジャンルの行 → ジャンルごとの12か月ぶんの件数（合計の多いジャンル順）
function seriesByCategory(months, rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.category_name)) map.set(r.category_name, new Map());
    map.get(r.category_name).set(r.month, r.count);
  }
  return [...map.entries()]
    .map(([category_name, byMonth]) => ({ category_name, counts: months.map((m) => byMonth.get(m) ?? 0) }))
    .sort((a, b) => b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0));
}

async function renderSummary(fy, currentFy, onChangeFy) {
  const box = app.querySelector('#tab-content');
  const { from, to } = fiscalYearRange(fy);
  const months = fiscalMonths(fy);
  const monthLabels = months.map((m) => `${Number(m.slice(5))}月`);

  // 年度の切り替え（未来の年度は見られない＝今年度より先へは進めない）
  const fyBar = el('div', { class: 'fy-bar' }, [
    el('button', { class: 'btn btn-sm', type: 'button', id: 'fy-prev', onclick: () => onChangeFy(fy - 1) }, '◀ 前の年度'),
    el('div', { class: 'fy-label', id: 'fy-label' }, [
      el('strong', {}, `FY${fy}`),
      el('span', { class: 'hint' }, ` ${from.replace(/-/g, '/')} 〜 ${to.replace(/-/g, '/')}`),
    ]),
    el('button', { class: 'btn btn-sm', type: 'button', id: 'fy-next', disabled: fy >= currentFy, onclick: () => onChangeFy(fy + 1) }, '次の年度 ▶'),
  ]);

  render(box, [fyBar, el('p', { class: 'loading' }, '集計中…')]);
  const stats = await api.get(`/api/stats?from=${from}&to=${to}`);

  const series = seriesByCategory(months, stats.trouble_trend_by_category || []);
  const counts = fillMonths(months, stats.trouble_trend || []);
  const hasData = stats.activity.troubles > 0;
  // 休止時間（トラブル入力の「休止時間」の合計）。古いAPIの応答（downtime なし）でも落ちないようにする
  const downtime = stats.downtime || { total_minutes: 0, counted: 0, unreadable: 0, by_month: [] };
  const dtSeries = downtimeSeries(months, downtime.by_month || []);
  const hasDowntime = downtime.counted > 0;

  render(box, [
    fyBar,
    el('div', { class: 'summary-grid', style: 'grid-template-columns:1fr 1fr' }, [
      el('div', { class: 'summary-card' }, [
        el('div', { class: 'summary-label' }, 'トラブル'),
        el('div', { class: 'summary-value' }, String(stats.activity.troubles)),
        el('div', { class: 'summary-period' }, `FY${fy}（年度内）`),
      ]),
      el('div', { class: 'summary-card', id: 'downtime-card' }, [
        el('div', { class: 'summary-label' }, '休止時間'),
        el('div', { class: 'summary-value summary-value-text' }, formatDowntime(downtime.total_minutes)),
        el('div', { class: 'summary-period' }, `入力のあった ${downtime.counted} 件の合計`),
      ]),
    ]),
    downtime.unreadable > 0
      ? el('p', { class: 'hint downtime-warn', id: 'downtime-unreadable' },
          `⚠ 休止時間を数字で読み取れない記録が ${downtime.unreadable} 件あり、合計に入っていません（トラブル記録の休止時間を、数字（分）に直すと入ります）。`)
      : null,
    el('div', { class: 'chart-grid' }, [
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, 'トラブル月別推移'),
        hasData ? makeCanvas('chart-trend') : el('p', { class: 'empty' }, 'データがありません'),
      ]),
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, '休止時間の月推移（休止区分別）'),
        hasDowntime ? makeCanvas('chart-downtime') : el('p', { class: 'empty' }, '休止時間の入力がありません'),
      ]),
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, 'ジャンル別の月推移'),
        hasData ? makeCanvas('chart-category-trend') : el('p', { class: 'empty' }, 'データがありません'),
      ]),
      el('div', { class: 'chart-wrap' }, [
        el('h3', { class: 'chart-title' }, 'ジャンル別トラブル（年度合計）'),
        stats.trouble_by_category.length > 0 ? makeCanvas('chart-category') : el('p', { class: 'empty' }, 'データがありません'),
      ]),
    ]),
  ]);

  // グラフ描画（DOMに追加後）
  if (hasData) {
    drawTroubleTrend('chart-trend', monthLabels, counts);
    drawTroubleTrendByCategory('chart-category-trend', monthLabels, series);
  }
  if (hasDowntime) drawDowntimeTrend('chart-downtime', monthLabels, dtSeries);
  if (stats.trouble_by_category.length > 0) drawTroubleByCategory('chart-category', stats.trouble_by_category);
}

// ---------------- タブ付きレイアウト ----------------

async function renderDashboard() {
  // 年度は JST の今日で決める（端末の時刻設定に依らない）
  const currentFy = fiscalYearOf(jstTodayStr());
  let fy = currentFy;

  // レポートの期間の初期値は「今月」（1日〜月末）
  const { from: defaultFrom, to: defaultTo } = periodFor('month', jstTodayStr());

  const fromInput = el('input', { type: 'date', value: defaultFrom });
  const toInput   = el('input', { type: 'date', value: defaultTo });
  const applyBtn  = el('button', { class: 'btn btn-sm', onclick: () => loadTab() }, '集計');

  // 期間のプリセット（今週・先週・今月・先月・直近6ヶ月）。レポートの FROM〜TO を書き換えて取り直す
  const KINDS = [['week', '今週'], ['lastweek', '先週'], ['month', '今月'], ['lastmonth', '先月'], ['last6months', '直近6ヶ月']];
  const chips = el('div', { class: 'chip-row' }, KINDS.map(([kind, label]) =>
    el('button', { class: 'chip', type: 'button', 'data-kind': kind, onclick: () => { setPreset(kind); loadTab(); } }, label)));
  const setPreset = (kind) => {
    const p = periodFor(kind, jstTodayStr());
    if (p) { fromInput.value = p.from; toInput.value = p.to; }
  };
  // いまの FROM〜TO がプリセットと一致するチップだけ強調する（手で日付を変えたら全部消える）
  const syncChips = () => {
    chips.querySelectorAll('.chip').forEach((c) => {
      const p = periodFor(c.dataset.kind, jstTodayStr());
      c.classList.toggle('is-active', !!p && p.from === fromInput.value && p.to === toInput.value);
    });
  };

  // トラブル記録CSV: レポートの FROM〜TO（集計期間）で /api/troubles を取得して出力（列は 04 一覧と共通）
  const exportTroubles = async (enc, btn) => {
    const from = fromInput.value || defaultFrom;
    const to   = toInput.value   || defaultTo;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '出力中…';
    try {
      // 件数の上限（既定500）より多く拾えるよう明示的に増やす（CSVが黙って欠けないように）
      const { troubles, truncated } = await api.get(`/api/troubles?${new URLSearchParams({ from, to, limit: '5000' })}`);
      if (troubles.length === 0) { alert('期間内のトラブル記録がありません。'); return; }
      if (truncated) alert(`件数が多いため先頭${troubles.length}件のみCSVに出力します。全件を出すには期間を絞ってください。`);
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

  // ?tab=report（旧「保全レポート」ページからの移動・ブックマーク）はレポートタブで開く
  const startTab = new URLSearchParams(window.location.search).get('tab');
  let activeTab = startTab === 'report' ? 'report' : 'summary';
  const tabContent = el('div', { id: 'tab-content' }, []);

  // 期間・CSVの操作欄はレポートタブのときだけ出す（サマリーのグラフは年度固定のため）。
  // 印刷時は期間・CSV・タブの操作欄を隠す（rpt-controls は body.rpt-page の印刷CSSで display:none）
  const reportBars = el('div', { id: 'report-bars', hidden: activeTab !== 'report' }, [
    el('div', { class: 'period-bar rpt-controls' }, [
      chips,
      el('label', { class: 'filter-label' }, ['FROM ', fromInput]),
      el('label', { class: 'filter-label' }, ['TO ', toInput]),
      applyBtn,
    ]),
    el('div', { class: 'period-bar rpt-controls', id: 'trouble-csv-bar' }, [
      el('span', { class: 'filter-label' }, 'トラブル記録（期間内）'),
      csvUtf8Btn,
      csvSjisBtn,
    ]),
  ]);

  const tabs = [
    { id: 'summary',  label: 'サマリー/グラフ（年度）' },
    { id: 'report',   label: '📄 レポート（印刷用）' },
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
    reportBars.hidden = activeTab !== 'report';
    // 印刷用CSS（body.rpt-page）はレポートタブのときだけ効かせる
    document.body.classList.toggle('rpt-page', activeTab === 'report');
    if (activeTab === 'report') {
      syncChips();
      await renderReportTab(fromInput.value || defaultFrom, toInput.value || defaultTo);
    } else {
      await renderSummary(fy, currentFy, (next) => { fy = next; loadTab(); });
    }
  };

  // レポートタブ: 印刷ボタン＋レポート本体。ユーザー名は出力者として載せる
  let me = null;
  try { me = await getCurrentUser(); } catch { me = null; }
  const renderReportTab = async (from, to) => {
    const docBox = el('div', { id: 'report-doc', class: 'rpt-doc' });
    render(tabContent, [
      el('div', { class: 'rpt-controls' }, [
        el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'rpt-print', onclick: () => window.print() }, '🖨 印刷 / PDF保存'),
        el('p', { class: 'hint' }, '印刷ダイアログで「PDFに保存」を選ぶと、PDFとして残せます（A4・縦）。期間は上の FROM〜TO（今週・先週・今月・先月・直近6ヶ月ボタン）で選べます。'),
      ]),
      docBox,
    ]);
    try {
      await renderReport(docBox, from, to, me);
    } catch (err) {
      render(docBox, el('p', { class: 'empty' }, `レポートを作成できませんでした: ${err.message}`));
    }
  };

  render(app, [
    el('div', { class: 'tab-bar tab-bar-fit rpt-controls' }, tabBtns),
    reportBars,
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
