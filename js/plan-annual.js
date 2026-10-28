// 01 保全計画 — 年間計画表（月別/全月表示・一括登録・種別フィルター・出力・編集・月末アラート）
//   URL: /pages/plan-annual
//   ・表示は「月別（既定・今月）」と「全月（12ヶ月グリッド）」を切り替え可能
//   ・タスク（設備/点検者/種別）を決め、実施月をチェックして一括登録（各月1日付）
//   ・各予定は 完了切替／点検者変更／別の月へ移動／追加／削除 ができる
//   ・実施月を決めずに登録した予定は「未定」枠に入り、後から月へ割り当てられる
//   ・月末が近いと、今月の未完了予定の完了チェックを促すアラートを表示
//   ・会計年度（10月始まり9月終わり）で表示する（列は 10月〜翌9月）。既定の表示年度は API の
//     fiscal_year（＝最後に年度リセットした年度＋1。完了状態はこの年度のもの）。
//     他の年度は点検実績とタスクの配置だけを表示し、完了状態はリセット時のCSVで確認する

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { fetchEquipNames, buildEquipCascade } from '/js/equip-names.js';
import { el, render, jstTodayStr, toJstDateStr } from '/js/util.js';
import { buildCsvText, downloadCsv } from '/js/csv.js';
import { renderPlanImport } from '/js/plan-import.js';
import { buildInspectionStartUrl } from '/js/plan-inspection-link.js';

const app = document.getElementById('app');
let currentUser = null;
let equipNames = null;
let fy = null;                               // 表示中の会計年度（開始年。FY2026 = 2026/10〜2027/09）。null = API の今年度
let currentFy = null;                        // 完了状態が属する年度（API の fiscal_year）
let resetTargetFy = null;                    // 「🔁 年度リセット」で締める年度（API の reset_target_fy）
let resetAvailable = false;                  // 年度リセットを実行できるか（締める年度の9月以降。API の reset_available）
let resetLogFys = new Set();                 // リセット履歴（CSVスナップショット）がある年度
let rawPlans = [];                           // API から取得したままの予定（年度リセットのCSVはこれから作る）
let typeFilter = '';                       // '' = 全種別
let nameFilter = '';                        // 名称あいまい検索
let statusFilter = '';                      // 状態絞り込み: '' = 全部 | 'pending' = 未実施 | 'done' = 完了
let sortKey = 'equipment';                  // 並び順: 'equipment'（設備順・既定）| 'inspector'（点検者順）
let viewMode = 'month';                     // 'month'（月別・既定）| 'all'（全月）
let viewMonth = Number(jstTodayStr().slice(5, 7)); // 月別表示で見ている月
let plansCache = [];                        // 表示用の予定（今年度以外は完了状態を外したもの）
let inspectionSummary = {};                 // 点検実績の突合用: { "line|equip": { "YYYY-MM": { count, equipment_id } } }

const PLAN_TYPES = {
  inspection:   { label: '点検',    color: '#1e40af', bg: '#dbeafe' },
  parts:        { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事',    color: '#b45309', bg: '#fef3c7' },
  other:        { label: 'その他',  color: '#6b7280', bg: '#f3f4f6' },
};
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };
const FISCAL_YEAR_START_MONTH = 10;
// 会計年度の並び（10月〜翌9月）
const MONTHS = Array.from({ length: 12 }, (_, i) => ((FISCAL_YEAR_START_MONTH - 1 + i) % 12) + 1);
const MONTH_END_WINDOW_DAYS = 7; // 月末これ以内になったらアラート

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

const mm = (m) => String(m).padStart(2, '0');
const monthOf = (p) => Number((p.planned_date || '').slice(5, 7));
const typeOf = (pt) => PLAN_TYPES[pt] || PLAN_TYPES.other;
// 表示中の年度で、その月が属する暦年（10〜12月は開始年、1〜9月は翌年）
const calYear = (m, f = fy) => (m >= FISCAL_YEAR_START_MONTH ? f : f + 1);
const fyLabelOf = (f) => `FY${f}（${f}/10〜${f + 1}/09）`;
// 完了状態を操作できるのは、完了状態が属する年度（今年度）を表示しているときだけ
const isCurrentView = () => fy === currentFy;
const canEditView = () => hasRole(currentUser, 'editor') && isCurrentView();

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

// 1つの値を入力してもらうシート（prompt() の代わり。スマホで押しやすい・日付は日付ピッカーが出る）
//   キャンセル時は null を返す
function openInputSheet(titleText, { type = 'text', value = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type, value, placeholder, style: 'width:100%;box-sizing:border-box;font-size:16px;padding:10px' });
    const backdrop = el('div', { class: 'sheet-backdrop' });
    const done = (v) => { backdrop.remove(); resolve(v); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
    backdrop.appendChild(el('div', { class: 'sheet' }, [
      el('div', { class: 'sheet-title' }, titleText),
      el('div', { style: 'padding:4px 8px 8px' }, [input]),
      el('button', { class: 'sheet-btn', onclick: () => done(input.value) }, '決定'),
      el('button', { class: 'sheet-btn sheet-cancel', onclick: () => done(null) }, 'キャンセル'),
    ]));
    document.body.appendChild(backdrop);
    input.focus();
  });
}

// 年間計画のタスクを、指定日付でカレンダーにも表示する（on_calendar=1）。
// 別レコードは作らず同じ予定の planned_date を指定日にして on_calendar を立てるだけなので、
// 年間計画表にそのまま残りつつ、同じ予定がカレンダーにも出る（完了状態も常に一致する）。
async function registerToCalendar(plan) {
  const defaultDate = (plan.planned_date || '').slice(0, 10) || `${calYear(1)}-01-01`;
  const date = await openInputSheet('カレンダーに表示する日付', { type: 'date', value: defaultDate });
  if (date === null) return;
  const d = String(date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { alert('日付を選択してください。'); return; }
  await mutate(() => api.put(`/api/plans/${plan.id}`, { planned_date: d, on_calendar: 1 }));
}

// 既存予定の操作（完了切替・点検者変更・移動・削除・詳細）
function openPlanSheet(plan, monthLabel) {
  const recurring = !!plan.recurrence_rule;
  const isUnsched = !!plan.unscheduled;
  const actions = [
    { label: '詳細を開く', onClick: () => { window.location.href = `/pages/plan?id=${plan.id}&from=annual`; } },
    { label: '📝 日時・内容を編集', onClick: () => { window.location.href = `/pages/plan?edit=${plan.id}`; } },
    plan.on_calendar
      ? { label: '📅 カレンダー表示を解除', onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { on_calendar: 0 })) }
      : { label: '📅 カレンダーに表示（日付指定）', onClick: () => registerToCalendar(plan) },
  ];
  // 点検タスクは点検入力へ直接ジャンプ（設備・実施日・点検者を引き継ぐ）
  if (plan.plan_type === 'inspection' && plan.status !== 'done') {
    actions.push({ label: '✅ 点検を開始', onClick: async () => { window.location.href = await buildInspectionStartUrl(plan); } });
  }
  if (recurring) {
    openSheet(`${monthLabel}: ${plan.title}（繰り返し予定）`, actions);
    return;
  }
  actions.push(plan.status === 'done'
    ? { label: '未完了に戻す', onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { status: 'pending' })) }
    : { label: '✓ 完了にする', onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { status: 'done' })) });
  actions.push({ label: '👤 点検者を変更', onClick: async () => {
    const name = await openInputSheet('点検者名を入力', { value: plan.inspector_name || '', placeholder: '点検者名（空で未設定に）' });
    if (name === null) return; // キャンセル
    return mutate(() => api.put(`/api/plans/${plan.id}`, { inspector_name: name.trim() || null }));
  } });
  actions.push({ label: '👥 担当者を変更', onClick: async () => {
    const name = await openInputSheet('担当者名を入力', { value: plan.assignee_name || '', placeholder: '担当者名（空で未設定に）' });
    if (name === null) return; // キャンセル
    return mutate(() => api.put(`/api/plans/${plan.id}`, { assignee_name: name.trim() || null }));
  } });
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
    onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { planned_date: `${calYear(m)}-${mm(m)}-01`, unscheduled: 0 })),
  }));
  openSheet(`「${plan.title}」を何月に？`, actions);
}

// 空セルから その月にタスクを追加（行の種別・設備・点検者を引き継ぐ）
function openAddSheet(row, m) {
  openSheet(`${m}月に予定を追加`, [
    { label: `「${row.title}」を ${m}月 に追加`, onClick: () => mutate(() => api.post('/api/plans', {
      title: row.title,
      plan_type: row.plan_type,
      planned_date: `${calYear(m)}-${mm(m)}-01`,
      line_name: row.line_name || null,
      equipment_name: row.equipment_name || null,
      inspector_name: row.inspector_name || null,
      assignee_name: row.assignee_name || null,
      annual_only: 1,
    })) },
  ]);
}

// 変更を保存して再取得・再描画（失敗時はアラート）
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
  const inspectorInput = el('input', { type: 'text', placeholder: '点検者名（任意）' });
  const assigneeInput = el('input', { type: 'text', placeholder: '担当者名（任意）' });
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
      inspector_name: inspectorInput.value.trim() || null,
      assignee_name: assigneeInput.value.trim() || null,
      note: noteInput.value.trim() || null,
    };
    // 月を選ばない場合は「未定」枠に1件登録（後から月へ割り当て可）。
    // 月を選んだ場合は各月1日付で作成（実施日は使わない。月単位で管理）。
    // annual_only=1 でカレンダーには表示しない（年間計画表専用）。
    const items = selectedMonths.length === 0
      ? [{ ...common, planned_date: `${calYear(1)}-01-01`, unscheduled: 1, annual_only: 1 }]
      : selectedMonths.map((m) => ({ ...common, planned_date: `${calYear(m)}-${mm(m)}-01`, annual_only: 1 }));

    try {
      const { created } = await api.post('/api/plans/batch', { items });
      alert(`${created}件の予定を登録しました。`);
      await renderYear();
    } catch (err) { alert(err.message); }
  };

  return el('details', { class: 'card no-print annual-form' }, [
    el('summary', { class: 'card-title' }, '＋ 予定を一括登録（毎年共通）'),
    el('p', { class: 'hint' }, 'タイトル・設備・点検者を決め、実施する月をチェックして登録すると、その月ぶんの予定がまとめて作られます。年間計画表は毎年共通で表示されます。月を選ばない場合は「未定」として登録できます（後から割り当て可）。'),
    el('div', { class: 'field' }, [el('label', {}, 'タイトル（必須）'), titleInput]),
    el('div', { class: 'field' }, [el('label', {}, '種別'), typeSelect]),
    el('div', { class: 'field' }, [el('label', {}, '設備名'), cascade.lineInput]), cascade.lineDatalist,
    el('div', { class: 'field' }, [el('label', {}, '機器名'), cascade.equipInput]), cascade.equipDatalist,
    el('div', { class: 'field' }, [el('label', {}, '点検者'), inspectorInput]),
    el('div', { class: 'field' }, [el('label', {}, '担当者'), assigneeInput]),
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

// ---------------- 集約（タスク単位） ----------------

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

// 状態フィルタ: 1予定が現在の statusFilter に一致するか（未実施=完了以外＝pending/overdue）
function matchesStatus(p) {
  if (!statusFilter) return true;
  if (statusFilter === 'done') return p.status === 'done';
  return p.status !== 'done';
}

// 状態フィルタ: 集約行（年間グリッド用）が、年内のいずれかの予定で statusFilter に一致するか
function matchesRowStatus(row) {
  if (!statusFilter) return true;
  const all = [...row.unscheduledList, ...[...row.months.values()].flat()];
  return all.some(matchesStatus);
}

// 名称・設備・点検者・担当者(業者)・備考のどれかに含まれれば一致（複数語はスペース区切りでAND）
function matchesName(p) {
  if (!nameFilter) return true;
  const hay = [p.title, p.line_name, p.equipment_name, p.inspector_name, p.assignee_name, p.note]
    .filter(Boolean).join(' ').toLowerCase();
  return nameFilter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function buildRows(plans) {
  const rowsMap = new Map();
  for (const p of plans) {
    if (typeFilter && p.plan_type !== typeFilter) continue;
    if (!matchesName(p)) continue;
    const key = `${p.plan_type}|${p.line_name || ''}|${p.equipment_name || ''}|${p.title}`;
    if (!rowsMap.has(key)) {
      rowsMap.set(key, {
        plan_type: p.plan_type, line_name: p.line_name, equipment_name: p.equipment_name,
        title: p.title, inspector_name: p.inspector_name || '', assignee_name: p.assignee_name || '',
        hasNote: false, months: new Map(), unscheduledList: [],
      });
    }
    const row = rowsMap.get(key);
    if (!row.inspector_name && p.inspector_name) row.inspector_name = p.inspector_name;
    if (!row.assignee_name && p.assignee_name) row.assignee_name = p.assignee_name;
    if (!row.hasNote && p.note) row.hasNote = true;
    if (p.unscheduled) { row.unscheduledList.push(p); continue; }
    const month = monthOf(p);
    if (!row.months.has(month)) row.months.set(month, []);
    row.months.get(month).push(p);
  }
  return [...rowsMap.values()].sort(compareBySort);
}

// 並び替え比較。点検者順は 点検者 → 設備 → タスク名、既定（設備順）は 設備 → タスク名。
// rows（集約行）にも plan（個別予定）にも inspector_name/line_name/title があるため共用できる。
function compareBySort(a, b) {
  const byEquip = (a.line_name || '').localeCompare(b.line_name || '', 'ja')
    || (a.title || '').localeCompare(b.title || '', 'ja');
  if (sortKey === 'inspector') {
    return (a.inspector_name || '').localeCompare(b.inspector_name || '', 'ja') || byEquip;
  }
  return byEquip;
}

// ---------------- 月別表示（既定） ----------------

// 1予定を1行のカードで表示（点検者・状態つき。タップで編集シート／詳細）
function planRow(p, monthLabel) {
  const type = typeOf(p.plan_type);
  const eqLabel = [p.line_name, p.equipment_name].filter(Boolean).join(' ');
  const statusCls = p.status === 'done' ? ' is-done' : (p.status === 'overdue' ? ' is-overdue' : '');
  const canEdit = canEditView();
  const inner = [
    el('div', { class: 'mplan-body' }, [
      el('div', { class: 'mplan-head' }, [
        el('span', { class: 'annual-type-badge', style: `background:${type.bg};color:${type.color}` }, type.label),
        el('span', { class: 'mplan-title' }, p.title),
        p.on_calendar ? el('span', { style: 'margin-left:4px', title: `カレンダー表示中（${(p.planned_date || '').slice(0, 10)}）` }, '📅') : null,
      ]),
      el('div', { class: 'mplan-sub' }, [
        eqLabel ? el('span', { class: 'mplan-eq' }, eqLabel) : null,
        el('span', { class: 'mplan-person' }, `点検者: ${p.inspector_name || '未設定'}`),
        p.assignee_name ? el('span', { class: 'mplan-person' }, `担当者: ${p.assignee_name}`) : null,
      ]),
      p.note ? el('div', { class: 'mplan-note' }, `📝 ${p.note}`) : null,
    ]),
    el('span', { class: `mplan-status${statusCls}` }, STATUS_LABELS[p.status] || p.status),
  ];
  return canEdit
    ? el('button', { class: 'mplan-row', onclick: () => openPlanSheet(p, monthLabel) }, inner)
    : el('a', { class: 'mplan-row', href: `/pages/plan?id=${p.id}` }, inner);
}

function buildMonthView() {
  // 種別・名称で絞った当月分（状態の集計はこの全体に対して出す）
  const inMonthAll = plansCache.filter((p) =>
    !p.unscheduled && monthOf(p) === viewMonth && (!typeFilter || p.plan_type === typeFilter) && matchesName(p));
  const doneCount = inMonthAll.filter((p) => p.status === 'done').length;
  // 状態フィルタを適用した表示用リスト
  const inMonth = inMonthAll.filter(matchesStatus);
  inMonth.sort(compareBySort);

  const undecided = plansCache.filter((p) =>
    p.unscheduled && (!typeFilter || p.plan_type === typeFilter) && matchesName(p) && matchesStatus(p));

  const statusNote = statusFilter ? `（${statusFilter === 'done' ? '完了' : '未実施'}のみ）` : '';
  const list = inMonth.length === 0
    ? el('p', { class: 'empty' }, `${viewMonth}月の予定はありません${statusNote}。`)
    : el('div', { class: 'mplan-list' }, inMonth.map((p) => planRow(p, `${viewMonth}月`)));

  return el('div', {}, [
    monthNav(),
    inMonthAll.length > 0
      ? el('p', { class: 'hint no-print' },
          `${viewMonth}月: ${inMonthAll.length}件（完了 ${doneCount} / 未完了 ${inMonthAll.length - doneCount}）${statusFilter ? ` ・表示中 ${inMonth.length}件${statusNote}` : ''}`)
      : null,
    list,
    undecided.length > 0
      ? el('div', { class: 'mplan-unsched no-print' }, [
          el('h4', { class: 'mplan-unsched-title' }, `未定（実施月が未設定）${undecided.length}件`),
          el('div', { class: 'mplan-list' }, undecided.map((p) => planRow(p, '未定'))),
        ])
      : null,
  ]);
}

function monthNav() {
  const stepTo = (m) => { viewMonth = m; renderView(); };
  // 会計年度の並び（10月〜翌9月）で前後へ。年度の端では止める（9月の次は来年度の10月＝別の表示年度）
  const idx = MONTHS.indexOf(viewMonth);
  return el('div', { class: 'cal-nav no-print', style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
    el('button', { class: 'btn btn-sm', disabled: idx <= 0, onclick: () => stepTo(MONTHS[idx - 1]) }, '‹'),
    el('select', { onchange: (e) => stepTo(Number(e.target.value)) },
      MONTHS.map((m) => el('option', { value: m, selected: m === viewMonth }, `${calYear(m)}年${m}月`))),
    el('button', { class: 'btn btn-sm', disabled: idx >= MONTHS.length - 1, onclick: () => stepTo(MONTHS[idx + 1]) }, '›'),
  ]);
}

// ---------------- 全月グリッド表示 ----------------

function buildYearGrid(rows) {
  if (rows.length === 0) {
    return el('p', { class: 'empty' },
      (typeFilter || statusFilter || nameFilter)
        ? '条件に一致する予定はありません。'
        : '予定はまだありません。上の「一括登録」から登録してください。');
  }
  const canEdit = canEditView();

  const head = el('tr', {}, [
    el('th', { class: 'annual-task-col' }, 'タスク / 設備 / 点検者'),
    el('th', { class: 'annual-unsched-col' }, '未定'),
    ...MONTHS.map((m) => el('th', {}, m === FISCAL_YEAR_START_MONTH || m === 1 ? `${calYear(m)}年${m}月` : `${m}月`)),
  ]);

  const body = rows.map((row) => {
    const type = typeOf(row.plan_type);
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
        el('div', { class: 'annual-task-person' }, `点検者: ${row.inspector_name || '未設定'}`),
        row.assignee_name ? el('div', { class: 'annual-task-person' }, `担当者: ${row.assignee_name}`) : null,
        row.hasNote ? el('div', { class: 'annual-task-note' }, '📝 備考あり') : null,
      ]),
      unschedCell,
      ...MONTHS.map((m) => {
        const s = summarizeMonth(row.months.get(m));

        // 点検種別かつ設備が設定されている場合、表示年度のその月の実績件数を表示
        const inspKey = `${row.line_name || ''}|${row.equipment_name || ''}`;
        const y = calYear(m);
        const inspMonthKey = `${y}-${mm(m)}`;
        const inspData = (row.plan_type === 'inspection' && (row.line_name || row.equipment_name))
          ? inspectionSummary[inspKey]?.[inspMonthKey]
          : null;
        const lastDay = new Date(y, m, 0).getDate();
        const inspBadge = inspData
          ? el('a', {
              class: 'annual-insp-count',
              href: `/pages/inspection?equipment_id=${inspData.equipment_id}&from=${y}-${mm(m)}-01&to=${y}-${mm(m)}-${String(lastDay).padStart(2, '0')}`,
              title: `${y}年${m}月の点検実績: ${inspData.count}件`,
              onclick: (e) => e.stopPropagation(),
            }, `✓${inspData.count}件`)
          : null;

        if (s.empty) {
          return el('td', { class: 'annual-cell' }, [
            canEdit
              ? el('button', { class: 'annual-add no-print', title: `${m}月に追加`, onclick: () => openAddSheet(row, m) }, '＋')
              : null,
            inspBadge,
          ]);
        }
        const cls = `annual-mark${s.done ? ' is-done' : ''}${s.overdue ? ' is-overdue' : ''}`;
        const tip = `${row.title}（${STATUS_LABELS[s.plan.status] || s.plan.status}${row.inspector_name ? '・点検者: ' + row.inspector_name : ''}${row.assignee_name ? '・担当者: ' + row.assignee_name : ''}${s.plan.note ? '・備考: ' + s.plan.note : ''}）`;
        return el('td', { class: 'annual-cell' }, [
          canEdit
            ? el('button', { class: cls, style: `color:${type.color}`, title: tip, onclick: () => openPlanSheet(s.plan, `${m}月`) }, s.mark)
            : el('a', { class: cls, style: `color:${type.color}`, title: tip, href: `/pages/plan?id=${s.plan.id}` }, s.mark),
          inspBadge,
        ]);
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

// 月セルの完了状態テキスト（CSV出力用）。完了／未実施／期限超過、複数件は「N件(状態)」
function monthCellText(list) {
  const s = summarizeMonth(list);
  if (s.empty) return '';
  const label = s.done ? '完了' : s.overdue ? '期限超過' : '未実施';
  return s.count > 1 ? `${s.count}件(${label})` : label;
}

// CSVは年間表（行=タスク／列=12ヶ月＝10月〜翌9月）を出力。種別フィルターを反映し、各月の完了状態を含める
//   （今年度以外の表示では完了状態を持たないため「未実施」になる。過去年度はリセット時のCSVを使う）
function annualCsvColumns() {
  return [
    { label: '種別', value: (r) => typeOf(r.plan_type).label },
    { label: 'タスク', value: (r) => r.title },
    { label: '設備', value: (r) => [r.line_name, r.equipment_name].filter(Boolean).join(' ') },
    { label: '点検者', value: (r) => r.inspector_name || '' },
    { label: '担当者', value: (r) => r.assignee_name || '' },
    { label: '未定', value: (r) => monthCellText(r.unscheduledList) },
    ...MONTHS.map((m) => ({ label: `${m}月`, value: (r) => monthCellText(r.months.get(m)) })),
  ];
}
function exportCsv(rows, enc, f = fy) {
  if (rows.length === 0) { alert('出力対象がありません。'); return; }
  const text = buildCsvText(rows, annualCsvColumns());
  downloadCsv(`annual_plan_FY${f}_${typeFilter || 'all'}.csv`, text, enc);
}

// ---------------- 月末アラート ----------------

function monthEndAlert() {
  const [ty, tm, td] = jstTodayStr().split('-').map(Number);
  // 月末アラートは、今日が表示年度に入っていて、それが完了状態を持つ年度のときだけ
  if (!isCurrentView() || calYear(tm) !== ty) return null;
  const curMonth = tm;
  const daysInMonth = new Date(ty, curMonth, 0).getDate();
  const daysLeft = daysInMonth - td;
  if (daysLeft > MONTH_END_WINDOW_DAYS) return null;

  const pending = plansCache.filter((p) => !p.unscheduled && monthOf(p) === curMonth && p.status !== 'done');
  if (pending.length === 0) return null;

  return el('div', { class: 'notice is-warning no-print' }, [
    el('strong', {}, `⚠ 今月（${curMonth}月）の未完了予定が ${pending.length} 件あります。`),
    el('span', {}, ` 月末まであと${daysLeft}日です。完了したものは ✓ で完了チェックをお願いします。`),
  ]);
}

// ---------------- ツールバー・年ナビ・描画 ----------------

function toolbar() {
  const sel = el('select', {
    onchange: (e) => { typeFilter = e.target.value; renderView(); },
  }, [
    el('option', { value: '', selected: typeFilter === '' }, '全種別'),
    ...Object.entries(PLAN_TYPES).map(([v, { label }]) =>
      el('option', { value: v, selected: typeFilter === v }, label)),
  ]);
  const nameInput = el('input', {
    type: 'search', placeholder: '名称・設備・業者・点検者で検索', value: nameFilter,
    class: 'annual-name-search',
    // 結果領域だけ再描画（入力欄を作り直さずフォーカスを保つ）。月別/全月の見出しも更新する
    oninput: (e) => { nameFilter = e.target.value; renderResults(); },
  });
  const viewToggle = el('div', { class: 'annual-view-toggle' }, [
    el('button', { class: `btn btn-sm${viewMode === 'month' ? ' btn-primary' : ''}`, onclick: () => { viewMode = 'month'; renderView(); } }, '月別'),
    el('button', { class: `btn btn-sm${viewMode === 'all' ? ' btn-primary' : ''}`, onclick: () => { viewMode = 'all'; renderView(); } }, '全月'),
  ]);
  // 並び順（設備順 / 点検者順）。結果領域だけ再描画して切り替える
  const sortSel = el('select', {
    onchange: (e) => { sortKey = e.target.value; renderResults(); },
  }, [
    el('option', { value: 'equipment', selected: sortKey === 'equipment' }, '設備順'),
    el('option', { value: 'inspector', selected: sortKey === 'inspector' }, '点検者順'),
  ]);
  // 状態フィルタ（全部 / 未実施 / 完了）。月別・全月の両方に効く
  const statusSel = el('select', {
    onchange: (e) => { statusFilter = e.target.value; renderResults(); },
  }, [
    el('option', { value: '', selected: statusFilter === '' }, '全状態'),
    el('option', { value: 'pending', selected: statusFilter === 'pending' }, '未実施'),
    el('option', { value: 'done', selected: statusFilter === 'done' }, '完了'),
  ]);
  return el('div', { class: 'annual-toolbar no-print' }, [
    el('div', { class: 'annual-filter-row' }, [
      el('label', { class: 'annual-filter' }, ['種別: ', sel]),
      el('label', { class: 'annual-filter' }, ['状態: ', statusSel]),
      el('label', { class: 'annual-filter' }, ['並び: ', sortSel]),
      nameInput,
    ]),
    viewToggle,
    el('div', { class: 'annual-output-btns' }, [
      el('button', { class: 'btn btn-sm', onclick: () => window.print() }, '🖨 印刷'),
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv(buildRows(plansCache), 'UTF-8') }, '📥 CSV'),
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv(buildRows(plansCache), 'sjis') }, '📥 CSV(Excel)'),
      canEditView()
        ? el('button', { class: 'btn btn-sm', onclick: () => renderPlanImport((m) => calYear(m), () => renderYear()) }, '📤 CSV取込')
        : null,
      // 締める年度の9月より前（リセットした直後など）は押せない
      hasRole(currentUser, 'admin')
        ? el('button', {
            class: 'btn btn-sm btn-danger',
            disabled: !resetAvailable,
            title: resetAvailable ? `FY${resetTargetFy} を締めて未実施に戻します` : `FY${resetTargetFy} の年度リセットは ${resetTargetFy + 1}年9月から実行できます`,
            onclick: () => runAnnualReset(),
          }, `🔁 年度リセット（FY${resetTargetFy}）`)
        : null,
    ]),
  ]);
}

// 年度ナビ: タスクは毎年共通。完了状態は今年度（最後にリセットした年度＋1）のものだけを持つ
function yearNav() {
  const step = (d) => { fy += d; renderYear().catch(showError); };
  return el('div', { class: 'cal-nav no-print', style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
    el('a', { class: 'btn btn-sm', href: '/pages/plan' }, '‹ カレンダー'),
    el('div', { style: 'flex:1;display:flex;align-items:center;justify-content:center;gap:6px' }, [
      el('button', { class: 'btn btn-sm', title: '前の年度', onclick: () => step(-1) }, '‹'),
      el('span', { class: 'annual-fy-label', style: 'font-weight:600;min-width:96px;text-align:center' },
        `${fyLabelOf(fy)}${isCurrentView() ? '（今年度）' : ''}`),
      el('button', { class: 'btn btn-sm', title: '次の年度', onclick: () => step(1) }, '›'),
    ]),
  ]);
}

// 今年度以外を表示しているときの案内（完了状態はこの年度のものではない）
function otherFyNotice() {
  if (isCurrentView()) return null;
  const back = el('button', { class: 'btn btn-sm', onclick: () => { fy = currentFy; renderYear().catch(showError); } }, `今年度（FY${currentFy}）に戻る`);
  if (fy < currentFy) {
    return el('div', { class: 'notice annual-fy-notice no-print' }, [
      el('span', {}, `${fyLabelOf(fy)} は過去の年度です。表はタスクの配置と点検実績だけを表示しています（完了状態は表示しません）。`),
      resetLogFys.has(fy)
        ? el('a', { class: 'btn btn-sm', href: `/api/plans/annual-reset?fiscal_year=${fy}&csv=1`, download: `annual_plan_FY${fy}.csv` }, `📥 FY${fy} の完了状況（リセット時のCSV）`)
        : el('span', {}, ' この年度のリセット時のCSVはありません。'),
      ' ', back,
    ]);
  }
  return el('div', { class: 'notice annual-fy-notice no-print' }, [
    el('span', {}, `${fyLabelOf(fy)} はまだ始まっていない年度です（完了状態は FY${fy - 1} の年度リセット後に記録します）。`),
    ' ', back,
  ]);
}

// 結果表示領域（月別/全月）。名称検索ではここだけ再描画して入力欄のフォーカスを保つ
let viewBox = el('div', {});

// 絞り込み結果のみ再描画（入力欄・ツールバーは作り直さない）
function renderResults() {
  if (viewMode === 'month') {
    render(viewBox, buildMonthView());
  } else {
    // 全月グリッドは状態フィルタを行単位で適用（年内にその状態の予定がある行だけ表示）
    const rows = buildRows(plansCache).filter(matchesRowStatus);
    render(viewBox, buildYearGrid(rows));
  }
}

// 取得済みデータ（plansCache）から画面全体を描画（再取得なし）
function renderView() {
  const printTitle = viewMode === 'month' ? `${viewMonth}月 点検計画（毎年共通）` : '年間計画表（毎年共通）';
  viewBox = el('div', {});
  renderResults();

  render(app, [
    monthEndAlert(),
    yearNav(),
    otherFyNotice(),
    canEditView() ? buildBulkForm() : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'print-only report-print-header' }, [
        el('h2', {}, `${printTitle} ${fyLabelOf(fy)}`),
        el('p', {}, `種別: ${typeLabel()}　出力日: ${jstTodayStr()}`),
      ]),
      toolbar(),
      el('div', { class: 'cal-legend no-print', style: 'margin-bottom:8px' },
        Object.values(PLAN_TYPES).map(({ label, color, bg }) =>
          el('span', { class: 'cal-legend-item', style: `background:${bg};color:${color}` }, label))),
      viewBox,
      el('p', { class: 'hint no-print', style: 'margin-top:8px' },
        canEditView()
          ? 'タップで 完了・点検者変更・移動・削除ができます。全月表示では空欄の＋でその月に追加できます。'
          : 'タップで詳細へ。'),
    ]),
  ]);
}

// 年間計画（annual_only）を全件取得して描画（毎年共通のテンプレート）
// 同時に当年の点検実績も取得し、年間計画グリッドとの突合に使う
async function renderYear() {
  const annual = await api.get('/api/plans?annual_only=1');
  currentFy = annual.fiscal_year;
  resetTargetFy = annual.reset_target_fy ?? currentFy;
  resetAvailable = !!annual.reset_available;
  if (fy === null) fy = currentFy;
  const [equipData, inspData, resetLogs] = await Promise.all([
    api.get('/api/equipment').catch(() => ({ equipment: [] })),
    // 表示年度（10月〜翌9月）の点検実績。limit=5000: 既定200件だと古い月の実績が欠ける。
    // 失敗しても計画表は実績なしで表示する（.catch）
    api.get(`/api/inspections?from=${fy}-10-01&to=${fy + 1}-09-30&limit=5000`).catch(() => ({ inspections: [] })),
    // 過去年度の完了状況（リセット時のCSV）の有無
    fy < currentFy ? api.get('/api/plans/annual-reset').catch(() => ({ logs: [] })) : Promise.resolve(null),
  ]);
  rawPlans = annual.plans || [];
  // 完了状態は今年度のもの。他の年度の表示では「予定」として扱う（前年度の✓が別年度に出ないように）
  plansCache = isCurrentView() ? rawPlans : rawPlans.map((p) => ({ ...p, status: 'pending' }));
  if (resetLogs) resetLogFys = new Set((resetLogs.logs || []).map((l) => Number(l.fiscal_year)));

  // equipment_id → "line_name|equipment_name" の逆引きマップ（inspections API は equipment_id しか返さない）
  const idToLineEquip = new Map();
  for (const eq of equipData.equipment || []) {
    idToLineEquip.set(eq.id, `${eq.line_name || ''}|${eq.equipment_name || ''}`);
  }

  // 点検実績を "line_name|equipment_name" × "YYYY-MM" で集計
  inspectionSummary = {};
  for (const ins of inspData.inspections || []) {
    const lineEquipKey = idToLineEquip.get(ins.equipment_id);
    if (!lineEquipKey) continue;
    const month = toJstDateStr(ins.inspected_at).slice(0, 7); // YYYY-MM（JST。UTCだと毎月1日の0〜9時が前月になる）
    if (!inspectionSummary[lineEquipKey]) inspectionSummary[lineEquipKey] = {};
    if (!inspectionSummary[lineEquipKey][month]) {
      inspectionSummary[lineEquipKey][month] = { count: 0, equipment_id: ins.equipment_id };
    }
    inspectionSummary[lineEquipKey][month].count++;
  }

  renderView();
}

// 年度末リセット実行: CSV をダウンロードしてからサーバーにリセットを依頼
//   ※ リセットは管理者が手動で行う（ツールバーの「🔁 年度リセット」ボタン）。
//      未リセットを促す自動バナーは出さない。
//   締める年度はサーバーが決めた reset_target_fy（通常は最後にリセットした年度＋1）。
//   CSV は表示中の年度ではなく、API から取得したままの完了状態（rawPlans）から作る。
async function runAnnualReset() {
  const target = resetTargetFy;
  const fyLabel = `FY${target}（${target}年10月〜${target + 1}年9月）`;
  if (!confirm(`${fyLabel} の年間計画をリセットします。\n・現在の完了状態をCSVに保存\n・全タスクを「未実施」に戻す\n\n続けますか？`)) return;

  // リセット前の完了状態（全種別）。種別フィルターに関係なく全タスクを残す
  const saved = [typeFilter, nameFilter];
  typeFilter = ''; nameFilter = '';
  const allRows = buildRows(rawPlans);
  [typeFilter, nameFilter] = saved;
  let csvText = '';
  try { csvText = buildCsvText(allRows, annualCsvColumns()); } catch { /* CSV 生成失敗はリセット続行 */ }
  // CSV をダウンロード（リセット前の状態を手元にも保存）
  if (csvText) downloadCsv(`annual_plan_FY${target}_all.csv`, csvText, 'UTF-8');

  try {
    const { reset_count } = await api.post('/api/plans/annual-reset', { fiscal_year: target, csv_snapshot: csvText || null });
    alert(`${fyLabel} のリセットが完了しました（${reset_count}件を未実施に戻しました）。`);
    fy = null; // 新しい今年度を表示する
    await renderYear();
  } catch (err) {
    alert(`リセットに失敗しました: ${err.message}`);
  }
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
