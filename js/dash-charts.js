// 08 グラフの描画（ダッシュボードのサマリーと、印刷用レポートで共有）。Chart.js（グローバル `Chart`）を使う。
//   色は「何番目に多いか」ではなく「どのジャンル／休止区分か」で決める（年度・期間を変えても同じ色）。
//   canvas は要素でも id でもよい。extra に { animation: false, responsive: false, devicePixelRatio: 2 } を渡すと、
//   画面に出さずに描いて画像にできる（印刷用レポートはこれで画像にして埋め込む）。
import { formatDowntime } from '/js/downtime.js';
import { categorySlots, kindSlots } from '/js/dashboard-calc.js';

// 色。どちらも色覚の違いがあっても隣どうしを見分けられる検証済みの順番（並べ替えない）。
//   色は「何番目に多いか」ではなく「どのジャンル／休止区分か」で決める（年度・期間を変えても同じ色）。
const COLORS = {
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  neutral: '#94a3b8', surface: '#ffffff', ink: '#64748b', grid: '#eef2f7', axis: '#cbd5e1', tooltip: '#1e293b',
};
const T = () => COLORS;
// 系列の色の数（CSS 側の --s0〜--s7 と対応）
export const SERIES_COUNT = 8;
export const seriesColor = (i) => COLORS.series[i];
export const slotColor = (slot) => (slot >= 0 && slot < SERIES_COUNT ? COLORS.series[slot] : COLORS.neutral);
// 画面の HTML（棒グラフ・点など）用。CSS 変数（--s0〜）を使う
export const slotVar = (slot) => (slot >= 0 && slot < SERIES_COUNT ? `var(--s${slot})` : 'var(--s-neutral)');
export const catVar = (slots, id) => slotVar(id == null ? -1 : (slots.get(Number(id)) ?? -1));

// 画面の単色の棒は光るグラデーション。印刷用に描くときは flat にしてベタ塗りにする（インクを使いすぎない）
let flat = false;
export function setChartFlat(on) { flat = !!on; }

export function setChartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = COLORS.ink;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.padding = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = COLORS.tooltip;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
}

const nodeOf = (c) => (typeof c === 'string' ? document.getElementById(c) : c);
function fresh(c) {
  const node = nodeOf(c);
  const existing = Chart.getChart(node);
  if (existing) existing.destroy();
  return node;
}

// 重なるときだけ月ラベルを間引く。色はテーマで変わるので、描くたびに作る
const xScale = () => ({ grid: { display: false }, border: { color: T().axis }, ticks: { maxRotation: 0, autoSkip: true } });
const yScale = (extra = {}) => ({ beginAtZero: true, grid: { color: T().grid }, border: { display: false }, ...extra });
const bar = () => ({ borderRadius: 6, maxBarThickness: 24, borderColor: T().surface });

// 単色の棒は、グラフの下に向かって少し透けるグラデーションにする（光って見える）。印刷（flat）・積み上げはベタ塗り。
//   色が '#rrggbb' のときだけ。グラフ全体の高さ（横棒は幅）に対するグラデーション（Chart.js の標準的な方法）。
//   ※ 棒ごとの位置（element の y〜base）に合わせたグラデーションは、棒が描かれなくなるので使わない
const glow = (hex) => {
  if (flat || typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return (ctx) => {
    const { chart } = ctx;
    const area = chart && chart.chartArea;
    if (!area) return hex; // 描き始め・凡例の見本はベタ塗り
    const horizontal = chart.options.indexAxis === 'y';
    const g = horizontal ? chart.ctx.createLinearGradient(area.left, 0, area.right, 0) : chart.ctx.createLinearGradient(0, area.bottom, 0, area.top);
    g.addColorStop(0, `${hex}a6`);
    g.addColorStop(1, hex);
    return g;
  };
};

// トラブル月別推移（棒）。prevCounts があれば前年度を点線で重ねる
export function drawTroubleTrend(canvas, labels, counts, fy, prevCounts, extra = {}) {
  const node = fresh(canvas);
  const datasets = [{ type: 'bar', label: fy ? `FY${fy}` : 'トラブル件数', data: counts, backgroundColor: glow(seriesColor(0)), ...bar(), order: 2, pointStyle: 'rect' }];
  if (prevCounts) {
    datasets.push({
      type: 'line', label: `前年度（FY${fy - 1}）`, data: prevCounts, order: 1,
      borderColor: T().neutral, backgroundColor: T().surface, borderWidth: 2, borderDash: [5, 4],
      pointRadius: 3, pointHoverRadius: 5, pointBorderWidth: 2, pointBackgroundColor: T().surface, tension: 0.25, spanGaps: false,
      pointStyle: 'line',
    });
  }
  return new Chart(node, {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !!prevCounts, position: 'bottom', reverse: true, labels: { usePointStyle: true, pointStyleWidth: 22 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y ?? 0}件` } },
      },
      scales: { x: xScale(), y: yScale({ ticks: { precision: 0 } }) },
      ...extra,
    },
  });
}

// 積み上げ棒グラフ（区切りは地の色の細い線）
export function drawStacked(canvas, labels, datasets, { yTitle, tooltipLabel, extra = {} } = {}) {
  const node = fresh(canvas);
  return new Chart(node, {
    type: 'bar',
    data: { labels, datasets: datasets.map((d) => ({ ...bar(), borderRadius: 3, borderWidth: { top: 1, right: 0, bottom: 0, left: 0 }, ...d })) },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { filter: (c) => (c.parsed.y ?? 0) > 0, callbacks: tooltipLabel ? { label: tooltipLabel } : {} },
      },
      scales: {
        x: { ...xScale(), stacked: true },
        y: yScale({ stacked: true, ticks: { precision: yTitle ? undefined : 0 }, title: yTitle ? { display: true, text: yTitle } : undefined }),
      },
      ...extra,
    },
  });
}

// 横棒グラフ（ジャンル別など。色は1本ずつ指定）。valueText で右の数字の書き方を決める
export function drawHBar(canvas, labels, values, colors, { valueText = (v) => `${v}件`, extra = {} } = {}) {
  const node = fresh(canvas);
  return new Chart(node, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors.map(glow), ...bar(), borderRadius: 4, maxBarThickness: 18 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => valueText(c.parsed.x) } } },
      scales: { x: yScale({ ticks: { precision: 0 } }), y: { grid: { display: false }, border: { color: T().axis } } },
      ...extra,
    },
  });
}

// ---- データの整形 ----

// 月のリストに合わせて、データの無い月は0件で埋める
export function fillMonths(months, rows) {
  const by = new Map(rows.map((r) => [r.month, r.count]));
  return months.map((m) => by.get(m) ?? 0);
}

export const catColor = (slots, id) => slotColor(id == null ? -1 : (slots.get(Number(id)) ?? -1));
export { categorySlots };

// 月×ジャンルの行 → ジャンルごとの月ぶんの件数（色の枠の順＝ジャンルのID順。未分類は最後）
export function seriesByCategory(months, rows, slots) {
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

// 月×休止区分の行（分）→ 休止区分ごとの月ぶんの時間（色の枠の順）
export function downtimeSeries(months, rows) {
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

export const hoursTooltip = (c) => `${c.dataset.label}: ${formatDowntime(Math.round(c.parsed.y * 60))}`;
