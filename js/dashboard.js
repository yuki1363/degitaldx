// 08 ダッシュボード・保全レポート — サマリー/グラフ（年度ごと・10月〜翌9月）とレポート（印刷用1枚）
//   サマリーのグラフは会計年度（10月始まり9月終わり）で固定し、「前の年度／次の年度」で切り替える。
//   期間（今週・先週・今月・先月・直近6ヶ月・FROM〜TO）とトラブルCSVはレポートタブだけで使う。
//   （抽出→表→CSV/PDF は横断検索(11)へ集約。ダッシュボードは「見る（グラフ）」に専念。
//    例外としてトラブル記録だけは、レポートの期間のまま CSV を出せる＝04 一覧と同じ列）

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render, jstTodayStr } from '/js/util.js';
import { exportTroubleCsv } from '/js/trouble-csv.js';
import { periodFor, fiscalYearOf, fiscalYearRange, fiscalMonths } from '/js/report-period.js';
import { renderReport } from '/js/report-summary.js';
import { formatDowntime } from '/js/downtime.js';
import {
  comparePeriod, yoy, worstEquipment, unassignedCount, repeatEquipment,
  heatmapGrid, heatStep, HEAT_WEEKDAYS, HEAT_BANDS, categorySlots, kindSlots,
} from '/js/dashboard-calc.js';

const app = document.getElementById('app');

// ---------------- グラフ描画 ----------------

// 系列の色（色覚の違いがあっても隣どうしを見分けられる順に並べた8色。順番は変えない）。
// 色は「何番目に多いか」ではなく「どのジャンル／休止区分か」で決める（年度を変えても同じ色）
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const NEUTRAL = '#94a3b8';   // 未分類・区分なし・前年度
const SURFACE = '#ffffff';
const INK_MUTED = '#64748b';
const GRID = '#eef2f7';
// 曜日×時間帯の濃淡（1色の薄い→濃い。0件は地の色）
const HEAT = ['#f1f5f9', '#cde2fb', '#9ec5f4', '#5598e7', '#256abf', '#0d366b'];
const slotColor = (slot) => (slot >= 0 && slot < SERIES.length ? SERIES[slot] : NEUTRAL);

function setChartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK_MUTED;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.padding = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1e293b';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
}

// 高さを決めた枠の中に描く（縦長・横長どちらの画面でも同じ高さ）
function makeCanvas(id) {
  return el('div', { class: 'dash-canvas' }, el('canvas', { id }));
}

function destroyChart(id) {
  const existing = Chart.getChart(id);
  if (existing) existing.destroy();
}

const X_SCALE = { grid: { display: false }, border: { color: '#cbd5e1' }, ticks: { maxRotation: 0, autoSkip: false } };
const yScale = (extra = {}) => ({ beginAtZero: true, grid: { color: GRID }, border: { display: false }, ...extra });
const BAR = { borderRadius: 6, maxBarThickness: 24, borderColor: SURFACE };

// トラブル月別推移（棒＝この年度、線＝前年度の同じ時期まで）
function drawTroubleTrend(canvasId, labels, counts, fy, prevCounts) {
  destroyChart(canvasId);
  const datasets = [{ type: 'bar', label: `FY${fy}`, data: counts, backgroundColor: SERIES[0], ...BAR, order: 2, pointStyle: 'rect' }];
  if (prevCounts) {
    datasets.push({
      type: 'line', label: `前年度（FY${fy - 1}）`, data: prevCounts, order: 1,
      borderColor: NEUTRAL, backgroundColor: SURFACE, borderWidth: 2, borderDash: [5, 4],
      pointRadius: 3, pointHoverRadius: 5, pointBorderWidth: 2, pointBackgroundColor: SURFACE, tension: 0.25, spanGaps: false,
      pointStyle: 'line',
    });
  }
  new Chart(document.getElementById(canvasId), {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !!prevCounts, position: 'bottom', reverse: true, labels: { usePointStyle: true, pointStyleWidth: 22 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y ?? 0}件` } },
      },
      scales: { x: X_SCALE, y: yScale({ ticks: { precision: 0 } }) },
    },
  });
}

// 積み上げ棒グラフ（区切りは地の色の細い線）
function drawStacked(canvasId, labels, datasets, { yTitle, tooltipLabel } = {}) {
  destroyChart(canvasId);
  new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels, datasets: datasets.map((d) => ({ ...BAR, borderRadius: 3, borderWidth: { top: 1, right: 0, bottom: 0, left: 0 }, ...d })) },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { filter: (c) => (c.parsed.y ?? 0) > 0, callbacks: tooltipLabel ? { label: tooltipLabel } : {} },
      },
      scales: {
        x: { ...X_SCALE, stacked: true },
        y: yScale({ stacked: true, ticks: { precision: yTitle ? undefined : 0 }, title: yTitle ? { display: true, text: yTitle } : undefined }),
      },
    },
  });
}

// 月×休止区分の行（分）→ 休止区分ごとの12か月ぶんの時間（色の枠の順）
function downtimeSeries(months, rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.kind)) map.set(r.kind, new Map());
    map.get(r.kind).set(r.month, r.minutes);
  }
  const slots = kindSlots([...map.keys()]);
  const order = (k) => { const s = slots.get(k); return s == null || s < 0 ? 99 : s; };
  return [...map.entries()]
    .map(([kind, byMonth]) => ({ kind, color: slotColor(slots.get(kind) ?? -1), hours: months.map((m) => Math.round(((byMonth.get(m) ?? 0) / 60) * 100) / 100) }))
    .sort((a, b) => order(a.kind) - order(b.kind));
}

// ---------------- サマリータブ（年度ごと） ----------------

// 年度の12か月（10月〜翌9月）に合わせて、データの無い月は0件で埋める
function fillMonths(months, rows) {
  const by = new Map(rows.map((r) => [r.month, r.count]));
  return months.map((m) => by.get(m) ?? 0);
}

// 月×ジャンルの行 → ジャンルごとの12か月ぶんの件数（色の枠の順＝ジャンルのID順。未分類は最後）
function seriesByCategory(months, rows, slots) {
  const map = new Map();
  for (const r of rows) {
    const key = r.category_id ?? null;
    if (!map.has(key)) map.set(key, { category_name: r.category_name, color: catColor(slots, key), byMonth: new Map() });
    map.get(key).byMonth.set(r.month, r.count);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a == null) - (b == null) || a - b)
    .map(([, v]) => ({ category_name: v.category_name, color: v.color, counts: months.map((m) => v.byMonth.get(m) ?? 0) }));
}
const catColor = (slots, id) => slotColor(id == null ? -1 : (slots.get(Number(id)) ?? -1));

const ymd = (s) => s.replace(/-/g, '/');
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

// 前年度比の1行（▲増・▼減・＝同じ。トラブルも休止時間も「減ったら良い」）。色だけに頼らず記号と言葉で示す
function deltaLine(id, cur, prev, fmt, prevLabel, prevEmpty) {
  if (prev == null) return el('div', { class: 'dash-delta', id }, el('span', { class: 'dash-delta-note' }, '前年度比は取得できませんでした'));
  // 前年度に記録が無いときは「◯件増」と出さない（比べる相手が無いだけで、悪くなったわけではない）
  if (prevEmpty) return el('div', { class: 'dash-delta', id }, el('span', { class: 'dash-delta-note' }, `${prevLabel}の記録はありません`));
  const d = yoy(cur, prev);
  const badge = d.dir === 'same'
    ? el('span', { class: 'dash-badge is-same' }, '＝ 前年度と同じ')
    : el('span', { class: `dash-badge ${d.dir === 'up' ? 'is-bad' : 'is-good'}` },
        `${d.dir === 'up' ? '▲' : '▼'} ${fmt(Math.abs(d.diff))}${d.dir === 'up' ? '増' : '減'}${d.pct == null ? '' : `（${d.pct > 0 ? '+' : ''}${d.pct}%）`}`);
  return el('div', { class: 'dash-delta', id }, [badge, el('span', { class: 'dash-delta-note' }, `${prevLabel} ${fmt(prev)}`)]);
}

// 数字カードの下の小さな棒（12か月の形だけを見せる飾り。数字は下のグラフで読む）
function miniBars(values) {
  const max = Math.max(...values, 0);
  return el('div', { class: 'dash-mini', 'aria-hidden': 'true' }, values.map((v) =>
    el('span', { class: v > 0 ? 'is-on' : '', style: `height:${max > 0 && v > 0 ? Math.max(12, Math.round((v / max) * 100)) : 6}%` })));
}

// 横棒の一覧（名前・棒・値）。rows: [{ label, value, text, color, href }]
function barList(id, rows, { rank = false } = {}) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return el('div', { class: 'dash-bars', id }, rows.map((r, i) => el('div', { class: 'dash-bar-row' }, [
    el('div', { class: 'dash-bar-head' }, [
      rank ? el('span', { class: `dash-rank r${i + 1}` }, String(i + 1)) : null,
      r.href ? el('a', { class: 'dash-bar-name', href: r.href }, r.label) : el('span', { class: 'dash-bar-name' }, r.label),
      el('span', { class: 'dash-bar-value' }, r.text),
    ]),
    el('div', { class: 'dash-bar-track' }, el('span', { style: `width:${max > 0 ? Math.max(2, (r.value / max) * 100) : 0}%;background:${r.color || SERIES[0]}` })),
  ])));
}

const equipLabel = (r) => (r.equipment_code ? `${r.equipment_code} ${r.equipment_name}` : r.equipment_name);
const equipHref = (r) => `/pages/ledger?id=${encodeURIComponent(r.equipment_id)}`;

// 曜日×時間帯の表（色の濃さ＝件数。件数はマスにも数字で出す）
function heatmap(rows) {
  const g = heatmapGrid(rows);
  const cell = (v) => {
    const step = heatStep(v, g.max, HEAT.length - 1);
    return el('td', { class: `dash-heat-cell${step >= 4 ? ' is-dark' : ''}`, style: `background:${HEAT[step]}` }, v > 0 ? String(v) : '');
  };
  return el('div', { id: 'dash-heatmap' }, [
    el('table', { class: 'dash-heat' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, ''), ...HEAT_WEEKDAYS.map((w) => el('th', { scope: 'col' }, w))])),
      el('tbody', {}, HEAT_BANDS.map((band, i) => el('tr', {}, [el('th', { scope: 'row' }, band), ...g.cells[i].map(cell)]))),
    ]),
    el('div', { class: 'dash-heat-legend' }, ['少', ...HEAT.slice(1).map((c) => el('span', { style: `background:${c}` })), '多']),
  ]);
}

const card = (title, body, sub, icon) => el('section', { class: 'chart-wrap' }, [
  el('h3', { class: 'chart-title' }, [icon ? el('span', { class: 'chart-icon', 'aria-hidden': 'true' }, icon) : null, title]),
  sub ? el('p', { class: 'dash-sub' }, sub) : null,
  body,
]);
const empty = (text = 'データがありません') => el('p', { class: 'empty' }, text);

async function renderSummary(fy, currentFy, onChangeFy) {
  const box = app.querySelector('#tab-content');
  const { from, to } = fiscalYearRange(fy);
  const months = fiscalMonths(fy);
  const monthLabels = months.map((m) => `${Number(m.slice(5))}月`);
  // 前年度比の比べる相手（今年度は「前年度の同じ時期まで」、過去の年度は前の年度まるごと）
  const cmp = comparePeriod(fy, currentFy, jstTodayStr());

  // 年度の切り替え（未来の年度は見られない＝今年度より先へは進めない）
  const fyBar = el('div', { class: 'dash-hero fy-bar' }, [
    el('button', { class: 'dash-nav', type: 'button', id: 'fy-prev', onclick: () => onChangeFy(fy - 1) }, '◀ 前の年度'),
    el('div', { class: 'fy-label', id: 'fy-label' }, [
      el('span', { class: 'dash-hero-kicker' }, fy === currentFy ? '今年度' : '過去の年度'),
      el('strong', {}, `FY${fy}`),
      el('span', { class: 'hint' }, ` ${ymd(from)} 〜 ${ymd(to)}`),
    ]),
    el('button', { class: 'dash-nav', type: 'button', id: 'fy-next', disabled: fy >= currentFy, onclick: () => onChangeFy(fy + 1) }, '次の年度 ▶'),
  ]);

  render(box, [fyBar, el('p', { class: 'loading' }, '集計中…')]);
  const q = new URLSearchParams({ from, to });
  if (cmp) { q.set('prev_from', cmp.from); q.set('prev_to', cmp.to); }
  const stats = await api.get(`/api/stats?${q}`);

  const slots = categorySlots(stats.categories || []);
  const series = seriesByCategory(months, stats.trouble_trend_by_category || [], slots);
  const counts = fillMonths(months, stats.trouble_trend || []);
  const total = stats.activity.troubles;
  const hasData = total > 0;
  // 休止時間（トラブル入力の「休止時間」の合計）。古いAPIの応答（downtime なし）でも落ちないようにする
  const downtime = stats.downtime || { total_minutes: 0, counted: 0, unreadable: 0, by_month: [] };
  const dtSeries = downtimeSeries(months, downtime.by_month || []);
  const hasDowntime = downtime.counted > 0;
  const dtByMonth = months.map((_, i) => dtSeries.reduce((a, s) => a + s.hours[i], 0));

  // 前年度（比べる相手）。古いAPIの応答（previous なし）では前年度比を出さない
  const prev = stats.previous || null;
  const prevMonths = fiscalMonths(fy - 1);
  const prevBy = new Map(((prev && prev.trouble_trend) || []).map((r) => [r.month, r.count]));
  // 比べる期間より後の月は線を引かない（null）
  const prevCounts = prev && prev.troubles > 0 ? prevMonths.map((m) => (m <= cmp.to.slice(0, 7) ? (prevBy.get(m) ?? 0) : null)) : null;
  const prevLabel = cmp && cmp.partial ? `前年度の同じ時期（〜${md(cmp.to)}）` : `前年度（FY${fy - 1}）`;

  const equip = stats.equipment_trouble_counts || [];
  const worstCount = worstEquipment(equip, 'trouble_count', 5);
  const worstTime = worstEquipment(equip, 'downtime_minutes', 5);
  const repeats = repeatEquipment(equip, 3);
  const unassigned = unassignedCount(equip);

  const byCategory = stats.trouble_by_category || [];

  render(box, [
    fyBar,
    el('div', { class: 'dash-kpis' }, [
      el('div', { class: 'dash-kpi is-blue', id: 'trouble-card' }, [
        el('div', { class: 'dash-kpi-label' }, [el('span', { class: 'dash-kpi-icon', 'aria-hidden': 'true' }, '⚠️'), 'トラブル']),
        el('div', { class: 'dash-kpi-value' }, [String(total), el('small', {}, '件')]),
        deltaLine('trouble-delta', total, prev ? prev.troubles : null, (n) => `${n}件`, prevLabel, !!prev && prev.troubles === 0),
        miniBars(counts),
      ]),
      el('div', { class: 'dash-kpi is-orange', id: 'downtime-card' }, [
        el('div', { class: 'dash-kpi-label' }, [el('span', { class: 'dash-kpi-icon', 'aria-hidden': 'true' }, '⏱'), '休止時間']),
        el('div', { class: 'dash-kpi-value is-text' }, formatDowntime(downtime.total_minutes)),
        deltaLine('downtime-delta', downtime.total_minutes, prev ? prev.downtime.total_minutes : null, formatDowntime, prevLabel, !!prev && prev.downtime.counted === 0),
        el('div', { class: 'dash-kpi-foot' }, `入力のあった ${downtime.counted} 件の合計`),
        miniBars(dtByMonth),
      ]),
    ]),
    total > 0 ? el('div', { class: 'dash-insights', id: 'dash-insights' }, [
      byCategory[0] ? el('div', { class: 'dash-insight' }, [
        el('span', { class: 'dash-insight-dot', style: `background:${catColor(slots, byCategory[0].category_id)}` }),
        el('div', {}, [el('div', { class: 'dash-insight-label' }, '最も多いジャンル'),
          el('div', { class: 'dash-insight-value' }, `${byCategory[0].category_name}（${byCategory[0].count}件）`)]),
      ]) : null,
      worstCount[0] ? el('div', { class: 'dash-insight' }, [
        el('span', { class: 'dash-insight-dot', style: `background:${SERIES[0]}` }),
        el('div', {}, [el('div', { class: 'dash-insight-label' }, '最も多い設備'),
          el('a', { class: 'dash-insight-value', href: equipHref(worstCount[0]) }, `${equipLabel(worstCount[0])}（${worstCount[0].trouble_count}件）`)]),
      ]) : null,
    ]) : null,
    downtime.unreadable > 0
      ? el('p', { class: 'hint downtime-warn', id: 'downtime-unreadable' },
          `⚠ 休止時間を数字で読み取れない記録が ${downtime.unreadable} 件あり、合計に入っていません（トラブル記録の休止時間を、数字（分）に直すと入ります）。`)
      : null,
    el('div', { class: 'chart-grid' }, [
      card('トラブル月別推移', hasData || prevCounts ? makeCanvas('chart-trend') : empty(),
        prevCounts ? `点線は${prevLabel}` : null, '📈'),
      card('休止時間の月推移（休止区分別）', hasDowntime ? makeCanvas('chart-downtime') : empty('休止時間の入力がありません'), null, '⏱'),
      card('ジャンル別の月推移', hasData ? makeCanvas('chart-category-trend') : empty(), null, '🗂'),
      card('ジャンル別トラブル（年度合計）', byCategory.length > 0
        ? barList('chart-category', byCategory.map((c) => ({
            label: c.category_name, value: c.count, color: catColor(slots, c.category_id),
            text: `${c.count}件（${total > 0 ? Math.round((c.count / total) * 100) : 0}%）`,
          })))
        : empty(), null, '🍰'),
      card('トラブルの多い設備（上位5）', worstCount.length > 0
        ? barList('dash-worst-count', worstCount.map((r) => ({ label: equipLabel(r), value: r.trouble_count, text: `${r.trouble_count}件`, href: equipHref(r) })), { rank: true })
        : empty('設備を指定したトラブルがありません'),
        unassigned > 0 ? `設備を指定していないトラブル ${unassigned} 件は含みません` : null, '🏭'),
      card('休止時間の長い設備（上位5）', worstTime.length > 0
        ? barList('dash-worst-time', worstTime.map((r) => ({ label: equipLabel(r), value: r.downtime_minutes, text: formatDowntime(r.downtime_minutes), href: equipHref(r), color: SERIES[1] })), { rank: true })
        : empty('休止時間の入力がありません'), null, '🛑'),
      card('繰り返しトラブルの設備', repeats.length > 0
        ? el('ul', { class: 'dash-repeat', id: 'dash-repeat' }, repeats.map((r) => el('li', {}, [
            el('a', { href: equipHref(r) }, equipLabel(r)),
            el('span', { class: 'dash-repeat-meta' }, [
              el('strong', { class: 'dash-times' }, `${r.trouble_count}回`),
              r.downtime_minutes > 0 ? ` ・休止 ${formatDowntime(r.downtime_minutes)}` : '',
            ]),
          ])))
        : el('p', { class: 'empty', id: 'dash-repeat' }, '年度内に3回以上トラブルが起きた設備はありません'),
        '年度内に3回以上トラブルが起きた設備（根本的な対策の候補）', '🔁'),
      card('曜日・時間帯別のトラブル', hasData ? heatmap(stats.trouble_by_weekday_hour || []) : empty(),
        '発生日時の曜日と時間帯ごとの件数（色が濃いほど多い）', '🗓'),
    ]),
  ]);

  // グラフ描画（DOMに追加後）
  if (document.getElementById('chart-trend')) drawTroubleTrend('chart-trend', monthLabels, counts, fy, prevCounts);
  if (hasData) {
    drawStacked('chart-category-trend', monthLabels,
      series.map((s) => ({ label: s.category_name, data: s.counts, backgroundColor: s.color })),
      { tooltipLabel: (c) => `${c.dataset.label}: ${c.parsed.y}件` });
  }
  if (hasDowntime) {
    drawStacked('chart-downtime', monthLabels,
      dtSeries.map((s) => ({ label: s.kind, data: s.hours, backgroundColor: s.color })),
      { yTitle: '時間', tooltipLabel: (c) => `${c.dataset.label}: ${formatDowntime(Math.round(c.parsed.y * 60))}` });
  }
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
    el('div', { class: 'tab-bar tab-bar-fit dash-tabs rpt-controls' }, tabBtns),
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
    document.body.classList.add('dash-page');
    setChartDefaults();
    await renderDashboard();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
