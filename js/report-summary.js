// 08 保全レポート（印刷用1枚）— /pages/report-summary
//   期間（今週・先週・今月・先月・任意）を選ぶと、概要・ジャンル別・設備別ランキング・トラブル一覧・
//   未完了の業務依頼・期限超過の保全計画をA4 1ページ前後にまとめる。「印刷」でブラウザの印刷（PDF保存も可）。
//   既存の API（/api/stats・/api/troubles・/api/repairs・/api/plans）の読み取りだけを使う。
//   ※ 点検実施率は /api/stats と同じ（期間内の「点検」計画のうち完了したものの割合）。
import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render, formatDate, jstTodayStr, toJstDateStr } from '/js/util.js';
import { periodFor, isValidPeriod, shiftDate } from '/js/report-period.js';

document.body.classList.add('rpt-page'); // 印刷用CSSをこのページだけに効かせる
const app = document.getElementById('app');
const REPAIR_STATUS = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };
const PLAN_TYPE = { inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他' };
const KINDS = [['week', '今週'], ['lastweek', '先週'], ['month', '今月'], ['lastmonth', '先月']];
const TROUBLE_ROWS = 40;   // 一覧に出す件数（超えたら「ほかN件」）
const REPAIR_ROWS = 25;
const PLAN_ROWS = 25;

let user = null;
let from = '';
let to = '';
let activeKind = 'month';
const docBox = el('div', { id: 'report-doc', class: 'rpt-doc' });

const trunc = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const cell = (v, cls) => el('td', cls ? { class: cls } : {}, v == null || v === '' ? '—' : String(v));

function table(headers, rows, emptyText) {
  if (rows.length === 0) return el('p', { class: 'rpt-empty' }, emptyText);
  return el('table', { class: 'rpt-table' }, [
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows),
  ]);
}
const section = (title, body) => el('section', { class: 'rpt-section' }, [el('h3', { class: 'rpt-h3' }, title), body]);

async function load() {
  render(docBox, el('p', { class: 'loading' }, '読み込み中…'));
  if (!isValidPeriod(from, to)) { render(docBox, el('p', { class: 'empty' }, '期間を正しく指定してください（開始日 ≦ 終了日）。')); return; }
  // /api/plans の to は「含まない」ため、終了日の翌日を渡す
  const planTo = shiftDate(to, 1);
  const [stats, troublesRes, repairsRes, plansRes] = await Promise.all([
    api.get(`/api/stats?from=${from}&to=${to}`),
    api.get(`/api/troubles?from=${from}&to=${to}`),
    api.get('/api/repairs'),
    api.get(`/api/plans?from=${from}&to=${planTo}`).catch(() => ({ plans: [] })),
  ]);
  const troubles = troublesRes.troubles || [];
  const openRepairs = (repairsRes.repairs || []).filter((r) => r.status !== 'done');
  const overduePlans = (plansRes.plans || []).filter((p) => p.status === 'overdue');
  const rate = stats.inspection_rate || {};
  const act = stats.activity || {};
  const maxCat = Math.max(1, ...(stats.trouble_by_category || []).map((c) => c.count));

  const tile = (label, value, sub) => el('div', { class: 'rpt-tile' }, [
    el('div', { class: 'rpt-tile-value' }, String(value)),
    el('div', { class: 'rpt-tile-label' }, label),
    sub ? el('div', { class: 'rpt-tile-sub' }, sub) : null,
  ]);

  render(docBox, [
    el('div', { class: 'rpt-head' }, [
      el('h2', { class: 'rpt-title' }, '保全レポート'),
      el('div', { class: 'rpt-meta' }, `期間: ${formatDate(from)} 〜 ${formatDate(to)}`),
      el('div', { class: 'rpt-meta' }, `出力: ${formatDate(jstTodayStr())}${user?.name ? `　出力者: ${user.name}` : ''}`),
    ]),
    el('div', { class: 'rpt-tiles' }, [
      tile('トラブル', act.troubles ?? 0, '件'),
      tile('業務依頼（新規）', act.repairs ?? 0, '件'),
      tile('点検記録', act.inspections ?? 0, '件'),
      tile('日報', act.reports ?? 0, '件'),
      tile('点検計画の実施率', rate.rate != null ? `${rate.rate}%` : '—', rate.planned ? `${rate.done}/${rate.planned}件` : '計画なし'),
      tile('未完了の依頼', openRepairs.length, '件（現時点）'),
    ]),
    section('ジャンル別トラブル', table(['ジャンル', '件数', ''],
      (stats.trouble_by_category || []).map((c) => el('tr', {}, [
        cell(c.category_name), cell(c.count, 'rpt-num'),
        el('td', { class: 'rpt-bar-cell' }, el('span', { class: 'rpt-bar', style: `width:${Math.round((c.count / maxCat) * 100)}%` })),
      ])), 'この期間のトラブルはありません。')),
    section('設備別 故障ランキング（上位）', table(['設備', '件数'],
      (stats.equipment_ranking || []).map((r) => el('tr', {}, [cell(r.equipment_code ? `${r.equipment_code} ${r.equipment_name}` : r.equipment_name), cell(r.trouble_count, 'rpt-num')])),
      'この期間のトラブルはありません。')),
    section(`期間内のトラブル（${troubles.length}件）`, el('div', {}, [
      table(['発生日', '設備', 'ジャンル', '現象'],
        troubles.slice(0, TROUBLE_ROWS).map((t) => el('tr', {}, [
          cell(formatDate(toJstDateStr(t.occurred_at))), cell(t.equipment_name), cell(t.category_name), cell(trunc(t.phenomenon, 60)),
        ])), 'この期間のトラブルはありません。'),
      troubles.length > TROUBLE_ROWS ? el('p', { class: 'rpt-more' }, `ほか ${troubles.length - TROUBLE_ROWS} 件（一覧はトラブル記録画面で確認できます）`) : null,
    ])),
    section(`未完了の業務依頼（${openRepairs.length}件）`, el('div', {}, [
      table(['依頼', '設備', '状況', '優先度', '期限'],
        openRepairs.slice(0, REPAIR_ROWS).map((r) => el('tr', { class: r.is_overdue ? 'rpt-overdue' : '' }, [
          cell(trunc(r.title, 40)), cell(r.equipment_name), cell(REPAIR_STATUS[r.status] || r.status), cell(r.priority),
          cell(r.due_date ? `${formatDate(r.due_date)}${r.is_overdue ? ' ⚠超過' : ''}` : ''),
        ])), '未完了の業務依頼はありません。'),
      openRepairs.length > REPAIR_ROWS ? el('p', { class: 'rpt-more' }, `ほか ${openRepairs.length - REPAIR_ROWS} 件`) : null,
    ])),
    section(`期限超過の保全計画（${overduePlans.length}件）`, el('div', {}, [
      table(['予定日', '種別', '内容', '設備'],
        overduePlans.slice(0, PLAN_ROWS).map((p) => el('tr', {}, [
          cell(formatDate(p.planned_date)), cell(PLAN_TYPE[p.plan_type] || p.plan_type), cell(trunc(p.title, 40)),
          cell([p.line_name, p.equipment_name].filter(Boolean).join(' ')),
        ])), 'この期間に期限超過の計画はありません。'),
      overduePlans.length > PLAN_ROWS ? el('p', { class: 'rpt-more' }, `ほか ${overduePlans.length - PLAN_ROWS} 件`) : null,
    ])),
  ]);
}

function setPeriod(kind) {
  activeKind = kind;
  const p = periodFor(kind, jstTodayStr());
  from = p.from; to = p.to;
  fromInput.value = from; toInput.value = to;
  chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.kind === kind));
}

const fromInput = el('input', { type: 'date', 'aria-label': '開始日' });
const toInput = el('input', { type: 'date', 'aria-label': '終了日' });
const chips = el('div', { class: 'chip-row' }, KINDS.map(([kind, label]) =>
  el('button', { class: 'chip', type: 'button', 'data-kind': kind, onclick: () => { setPeriod(kind); load().catch(showError); } }, label)));
const showError = (err) => render(docBox, el('p', { class: 'empty' }, `レポートを作成できませんでした: ${err.message}`));

(async () => {
  try { user = await getCurrentUser(); } catch { user = null; }
  render(app, [
    el('div', { class: 'card rpt-controls' }, [
      chips,
      el('div', { class: 'rpt-range' }, [
        fromInput, el('span', {}, '〜'), toInput,
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
          activeKind = ''; from = fromInput.value; to = toInput.value;
          chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
          load().catch(showError);
        } }, '表示'),
        el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'rpt-print', onclick: () => window.print() }, '🖨 印刷 / PDF保存'),
      ]),
      el('p', { class: 'hint' }, '印刷ダイアログで「PDFに保存」を選ぶと、PDFとして残せます（A4・縦）。'),
    ]),
    docBox,
  ]);
  setPeriod('month');
  await load().catch(showError);
})();
