// 01 保全計画 — 年間計画表（月ごと一括登録・種別フィルター・出力・月末アラート）
//   URL: /pages/plan-annual
//   ・タスク（設備/担当/種別）を決め、実施月をチェックして一括登録（各月1日付）
//   ・行=タスク／列=12ヶ月の年間グリッド。種別で絞り込み・印刷・CSV出力できる
//   ・グリッドのセルから 完了切替／別の月へ移動／追加／削除 ができる（点検月の変更に対応）
//   ・月末が近いと、今月の未完了予定の完了チェックを促すアラートを表示

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { fetchEquipNames, buildEquipCascade } from '/js/equip-names.js';
import { el, render } from '/js/util.js';
import { buildCsvText, downloadCsv } from '/js/csv.js';

const app = document.getElementById('app');
let currentUser = null;
let equipNames = null;
let year = new Date().getFullYear();
let typeFilter = ''; // '' = 全種別

const PLAN_TYPES = {
  inspection:   { label: '点検',    color: '#1e40af', bg: '#dbeafe' },
  parts:        { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事',    color: '#b45309', bg: '#fef3c7' },
  other:        { label: 'その他',  color: '#6b7280', bg: '#f3f4f6' },
};
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTH_END_WINDOW_DAYS = 7; // 月末これ以内になったらアラート

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

const mm = (m) => String(m).padStart(2, '0');
const monthOf = (p) => Number((p.planned_date || '').slice(5, 7));

// ---------------- アクションシート（編集用の簡易モーダル） ----------------

function openSheet(titleText, actions) {
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const sheet = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-title' }, titleText),
    ...actions.map((a) => el('button', {
      class: 'sheet-btn' + (a.danger ? ' is-danger' : ''),
      onclick: async () => { close(); await a.onClick(); },
    }, a.label)),
    el('button', { class: 'sheet-btn sheet-cancel', onclick: close }, 'キャンセル'),
  ]);
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
}

// 既存予定のセル操作（完了切替・移動・削除・詳細）
function openPlanSheet(plan, monthLabel) {
  const recurring = !!plan.recurrence_rule;
  const isUnsched = !!plan.unscheduled;
  const actions = [
    { label: '詳細を開く', onClick: () => { window.location.href = `/pages/plan?id=${plan.id}`; } },
  ];
  if (recurring) {
    // 繰り返し予定は1件移動・削除すると全体に影響するため、編集は詳細画面に誘導
    openSheet(`${monthLabel}: ${plan.title}（繰り返し予定）`, actions);
    return;
  }
  actions.push(plan.status === 'done'
    ? { label: '未完了に戻す', onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { status: 'pending' })) }
    : { label: '✓ 完了にする', onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { status: 'done' })) });
  if (isUnsched) {
    actions.push({ label: '📅 実施月を割り当て', onClick: () => openMoveSheet(plan) });
  } else {
    actions.push({ label: '📅 別の月へ移動', onClick: () => openMoveSheet(plan) });
    actions.push({ label: '↩ 未定に戻す', onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { unscheduled: 1 })) });
  }
  actions.push({ label: '🗑 削除', danger: true, onClick: () => {
    if (!confirm(`「${plan.title}」(${monthLabel}) を削除しますか？`)) return;
    return mutate(() => api.del(`/api/plans/${plan.id}`));
  } });
  openSheet(`${monthLabel}: ${plan.title}`, actions);
}

// 移動先／割り当て先の月を選ぶ（点検月の変更）。planned_date を選んだ月の1日に更新し、未定を解除する
function openMoveSheet(plan) {
  const cur = monthOf(plan);
  const actions = MONTHS.filter((m) => plan.unscheduled || m !== cur).map((m) => ({
    label: `${m}月へ`,
    onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { planned_date: `${year}-${mm(m)}-01`, unscheduled: 0 })),
  }));
  openSheet(`「${plan.title}」を何月に？`, actions);
}

// 空セルから その月にタスクを追加（行の種別・設備・担当を引き継ぐ）
function openAddSheet(row, m) {
  openSheet(`${m}月に予定を追加`, [
    { label: `「${row.title}」を ${m}月 に追加`, onClick: () => mutate(() => api.post('/api/plans', {
      title: row.title,
      plan_type: row.plan_type,
      planned_date: `${year}-${mm(m)}-01`,
      line_name: row.line_name || null,
      equipment_name: row.equipment_name || null,
      assignee_name: row.assignee_name || null,
    })) },
  ]);
}

// 変更を保存して年間表を再描画（失敗時はアラート）
async function mutate(fn) {
  try { await fn(); await renderYear(); }
  catch (err) { alert(err.message || String(err)); }
}

// ---------------- 一括登録フォーム ----------------

function buildBulkForm() {
  const cascade = buildEquipCascade(equipNames, { idPrefix: 'annual' });
  const titleInput = el('input', { type: 'text', placeholder: '例: 月次点検' });
  const typeSelect = el('select', {},
    Object.entries(PLAN_TYPES).map(([v, { label }]) => el('option', { value: v }, label)));
  const assigneeInput = el('input', { type: 'text', placeholder: '点検者・担当者名（任意）' });
  const noteInput = el('textarea', { placeholder: '備考（任意）' });

  const monthChecks = MONTHS.map((m) => {
    const cb = el('input', { type: 'checkbox', value: String(m) });
    return { m, cb, label: el('label', { class: 'annual-month-check' }, [cb, ` ${m}月`]) };
  });
  const setAll = (on) => monthChecks.forEach(({ cb }) => { cb.checked = on; });

  const submit = async () => {
    const title = titleInput.value.trim();
    if (!title) { alert('タイトルは必須です。'); return; }
    const selectedMonths = monthChecks.filter(({ cb }) => cb.checked).map(({ m }) => m);
    const common = {
      title,
      plan_type: typeSelect.value,
      line_name: cascade.lineInput.value.trim() || null,
      equipment_name: cascade.equipInput.value.trim() || null,
      assignee_name: assigneeInput.value.trim() || null,
      note: noteInput.value.trim() || null,
    };
    // 月を選ばない場合は「未定」枠に1件登録（後から月へ割り当て可）。
    // 月を選んだ場合は各月1日付で作成（実施日は使わない。月単位で管理）。
    const items = selectedMonths.length === 0
      ? [{ ...common, planned_date: `${year}-01-01`, unscheduled: 1 }]
      : selectedMonths.map((m) => ({ ...common, planned_date: `${year}-${mm(m)}-01` }));

    try {
      const { created } = await api.post('/api/plans/batch', { items });
      alert(`${created}件の予定を登録しました。`);
      await renderYear();
    } catch (err) { alert(err.message); }
  };

  return el('div', { class: 'card no-print' }, [
    el('h3', { class: 'card-title' }, `${year}年の予定を一括登録`),
    el('p', { class: 'hint' }, 'タイトル・設備・点検者を決め、実施する月をチェックして登録すると、その月ぶんの予定がまとめて作られます。月を選ばない場合は「未定」として登録できます（後から割り当て可）。'),
    el('div', { class: 'field' }, [el('label', {}, 'タイトル（必須）'), titleInput]),
    el('div', { class: 'field' }, [el('label', {}, '種別'), typeSelect]),
    el('div', { class: 'field' }, [el('label', {}, '設備名'), cascade.lineInput]), cascade.lineDatalist,
    el('div', { class: 'field' }, [el('label', {}, '機器名'), cascade.equipInput]), cascade.equipDatalist,
    el('div', { class: 'field' }, [el('label', {}, '点検者・担当者'), assigneeInput]),
    el('div', { class: 'field' }, [
      el('label', {}, '実施する月（複数選択可）'),
      el('div', { class: 'annual-month-actions' }, [
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => setAll(true) }, '毎月'),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => setAll(false) }, 'クリア'),
      ]),
      el('div', { class: 'annual-month-grid' }, monthChecks.map(({ label }) => label)),
    ]),
    el('div', { class: 'field' }, [el('label', {}, '備考'), noteInput]),
    el('div', { class: 'action-row' }, [
      el('button', { class: 'btn btn-primary', onclick: submit }, '選択した月にまとめて登録'),
    ]),
  ]);
}

// ---------------- グリッド構築 ----------------

// 月ごとの予定をまとめて表示用の情報を返す
function summarizeMonth(list) {
  if (!list || list.length === 0) return { empty: true, mark: '', text: '' };
  const done = list.every((x) => x.status === 'done');
  const overdue = list.some((x) => x.status === 'overdue');
  const multi = list.length > 1;
  return {
    empty: false, done, overdue, plan: list[0], count: list.length,
    mark: multi ? String(list.length) : (done ? '✓' : overdue ? '!' : '●'),
    text: multi ? `${list.length}件` : (done ? '完了' : overdue ? '期限超過' : '予定'),
  };
}

// タスク単位（種別+設備+機器+タイトル）に集約し、月ごとに予定を割り当てた行配列を返す
function buildRows(plans) {
  const rowsMap = new Map();
  for (const p of plans) {
    if (typeFilter && p.plan_type !== typeFilter) continue;
    const key = `${p.plan_type}|${p.line_name || ''}|${p.equipment_name || ''}|${p.title}`;
    if (!rowsMap.has(key)) {
      rowsMap.set(key, {
        plan_type: p.plan_type, line_name: p.line_name, equipment_name: p.equipment_name,
        title: p.title, assignee_name: p.assignee_name || '', months: new Map(), unscheduledList: [],
      });
    }
    const row = rowsMap.get(key);
    if (!row.assignee_name && p.assignee_name) row.assignee_name = p.assignee_name;
    if (p.unscheduled) { row.unscheduledList.push(p); continue; }
    const month = monthOf(p);
    if (!row.months.has(month)) row.months.set(month, []);
    row.months.get(month).push(p);
  }
  return [...rowsMap.values()].sort((a, b) =>
    (a.line_name || '').localeCompare(b.line_name || '', 'ja') ||
    (a.title || '').localeCompare(b.title || '', 'ja'));
}

function buildYearGrid(rows) {
  if (rows.length === 0) {
    return el('p', { class: 'empty' },
      typeFilter ? `${year}年の「${PLAN_TYPES[typeFilter].label}」の予定はありません。`
                 : `${year}年の予定はまだありません。上のフォームから登録してください。`);
  }
  const canEdit = hasRole(currentUser, 'editor');

  const head = el('tr', {}, [
    el('th', { class: 'annual-task-col' }, 'タスク / 設備 / 担当'),
    el('th', { class: 'annual-unsched-col' }, '未定'),
    ...MONTHS.map((m) => el('th', {}, `${m}月`)),
  ]);

  const body = rows.map((row) => {
    const type = PLAN_TYPES[row.plan_type] || PLAN_TYPES.other;
    const eqLabel = [row.line_name, row.equipment_name].filter(Boolean).join(' ');
    const us = summarizeMonth(row.unscheduledList);
    const unschedCell = el('td', { class: 'annual-cell annual-unsched-col' }, us.empty
      ? ''
      : (canEdit
          ? [el('button', { class: 'annual-mark', title: `未定: ${row.title}`, onclick: () => openPlanSheet(us.plan, '未定') }, us.mark)]
          : [el('span', { class: 'annual-mark' }, us.mark)]));
    return el('tr', {}, [
      el('td', { class: 'annual-task-col' }, [
        el('span', { class: 'annual-type-badge', style: `background:${type.bg};color:${type.color}` }, type.label),
        el('div', { class: 'annual-task-title' }, row.title),
        eqLabel ? el('div', { class: 'annual-task-eq' }, eqLabel) : null,
        row.assignee_name ? el('div', { class: 'annual-task-person' }, `担当: ${row.assignee_name}`) : null,
      ]),
      unschedCell,
      ...MONTHS.map((m) => {
        const s = summarizeMonth(row.months.get(m));
        if (s.empty) {
          // 空セル: 編集権限があればその月に追加できる
          return el('td', { class: 'annual-cell' }, canEdit
            ? [el('button', { class: 'annual-add no-print', title: `${m}月に追加`, onclick: () => openAddSheet(row, m) }, '＋')]
            : '');
        }
        const cls = `annual-mark${s.done ? ' is-done' : ''}${s.overdue ? ' is-overdue' : ''}`;
        const tip = `${row.title}（${STATUS_LABELS[s.plan.status] || s.plan.status}${row.assignee_name ? '・担当: ' + row.assignee_name : ''}）`;
        return el('td', { class: 'annual-cell' },
          canEdit
            ? [el('button', { class: cls, style: `color:${type.color}`, title: tip, onclick: () => openPlanSheet(s.plan, m) }, s.mark)]
            : [el('a', { class: cls, style: `color:${type.color}`, title: tip, href: `/pages/plan?id=${s.plan.id}` }, s.mark)]);
      }),
    ]);
  });

  return el('div', { class: 'report-table-wrap' }, [
    el('table', { class: 'report-table annual-grid' }, [el('thead', {}, [head]), el('tbody', {}, body)]),
  ]);
}

// ---------------- 出力（印刷・CSV） ----------------

function typeLabel() {
  return typeFilter ? PLAN_TYPES[typeFilter].label : '全種別';
}

function exportCsv(rows, enc) {
  if (rows.length === 0) { alert('出力対象がありません。'); return; }
  const columns = [
    { label: '種別', value: (r) => PLAN_TYPES[r.plan_type]?.label || r.plan_type },
    { label: 'タスク', value: (r) => r.title },
    { label: '設備', value: (r) => [r.line_name, r.equipment_name].filter(Boolean).join(' ') },
    { label: '担当者', value: (r) => r.assignee_name || '' },
    { label: '未定', value: (r) => summarizeMonth(r.unscheduledList).text },
    ...MONTHS.map((m) => ({ label: `${m}月`, value: (r) => summarizeMonth(r.months.get(m)).text })),
  ];
  const text = buildCsvText(rows, columns);
  downloadCsv(`annual_plan_${year}_${typeFilter || 'all'}.csv`, text, enc);
}

// ---------------- 月末アラート ----------------

function monthEndAlert(plans) {
  const today = new Date();
  if (year !== today.getFullYear()) return null; // 表示中の年が当年でなければ出さない
  const curMonth = today.getMonth() + 1;
  const daysInMonth = new Date(today.getFullYear(), curMonth, 0).getDate();
  const daysLeft = daysInMonth - today.getDate();
  if (daysLeft > MONTH_END_WINDOW_DAYS) return null;

  const pending = plans.filter((p) => !p.unscheduled && monthOf(p) === curMonth && p.status !== 'done');
  if (pending.length === 0) return null;

  return el('div', { class: 'notice is-warning no-print' }, [
    el('strong', {}, `⚠ 今月（${curMonth}月）の未完了予定が ${pending.length} 件あります。`),
    el('span', {}, ` 月末まであと${daysLeft}日です。完了したものは ✓ で完了チェックをお願いします。`),
  ]);
}

// ---------------- 年ナビ・全体描画 ----------------

function toolbar(rows) {
  const sel = el('select', {
    onchange: (e) => { typeFilter = e.target.value; renderYear().catch(showError); },
  }, [
    el('option', { value: '', selected: typeFilter === '' }, '全種別'),
    ...Object.entries(PLAN_TYPES).map(([v, { label }]) =>
      el('option', { value: v, selected: typeFilter === v }, label)),
  ]);
  return el('div', { class: 'annual-toolbar no-print' }, [
    el('label', { class: 'annual-filter' }, ['種別: ', sel]),
    el('div', { class: 'annual-output-btns' }, [
      el('button', { class: 'btn btn-sm', onclick: () => window.print() }, '🖨 印刷'),
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv(rows, 'UTF-8') }, '📥 CSV'),
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv(rows, 'sjis') }, '📥 CSV(Excel)'),
    ]),
  ]);
}

function yearNav() {
  return el('div', { class: 'cal-nav no-print', style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
    el('a', { class: 'btn btn-sm', href: '/pages/plan' }, '‹ カレンダー'),
    el('button', { class: 'btn btn-sm', onclick: () => { year -= 1; renderYear().catch(showError); } }, '‹'),
    el('span', { style: 'flex:1;text-align:center;font-weight:600' }, `${year}年`),
    el('button', { class: 'btn btn-sm', onclick: () => { year += 1; renderYear().catch(showError); } }, '›'),
  ]);
}

async function renderYear() {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`; // to は排他
  // include_unscheduled=1 で「実施月未定」の予定も取得（カレンダーには出ない）
  const { plans } = await api.get(`/api/plans?from=${from}&to=${to}&include_unscheduled=1`);
  const rows = buildRows(plans);

  render(app, [
    monthEndAlert(plans),
    yearNav(),
    hasRole(currentUser, 'editor') ? buildBulkForm() : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'print-only report-print-header' }, [
        el('h2', {}, `${year}年 年間計画表`),
        el('p', {}, `種別: ${typeLabel()}　出力日: ${new Date().toLocaleDateString('sv-SE')}`),
      ]),
      el('div', { class: 'card-title-row no-print' }, [
        el('h3', { class: 'card-title' }, `${year}年 年間計画表`),
      ]),
      toolbar(rows),
      el('div', { class: 'cal-legend no-print', style: 'margin-bottom:8px' },
        Object.values(PLAN_TYPES).map(({ label, color, bg }) =>
          el('span', { class: 'cal-legend-item', style: `background:${bg};color:${color}` }, label))),
      buildYearGrid(rows),
      el('p', { class: 'hint no-print', style: 'margin-top:8px' },
        hasRole(currentUser, 'editor')
          ? '● 予定／✓ 完了／! 期限超過／数字は同月複数件。セルをタップで 完了・移動・削除、空欄の＋でその月に追加できます。'
          : '● 予定／✓ 完了／! 期限超過。タップで詳細へ。'),
    ]),
  ]);
}

(async () => {
  try {
    currentUser = await getCurrentUser();
    equipNames = await fetchEquipNames();
    await renderYear();
  } catch (err) {
    showError(err);
  }
})();
