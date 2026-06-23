// 01 保全計画 — 年間計画表（月別/全月表示・一括登録・種別フィルター・出力・編集・月末アラート）
//   URL: /pages/plan-annual
//   ・表示は「月別（既定・今月）」と「全月（12ヶ月グリッド）」を切り替え可能
//   ・タスク（設備/点検者/種別）を決め、実施月をチェックして一括登録（各月1日付）
//   ・各予定は 完了切替／点検者変更／別の月へ移動／追加／削除 ができる
//   ・実施月を決めずに登録した予定は「未定」枠に入り、後から月へ割り当てられる
//   ・月末が近いと、今月の未完了予定の完了チェックを促すアラートを表示

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { fetchEquipNames, buildEquipCascade } from '/js/equip-names.js';
import { el, render } from '/js/util.js';
import { buildCsvText, downloadCsv } from '/js/csv.js';
import { renderPlanImport } from '/js/plan-import.js';
import { buildInspectionStartUrl } from '/js/plan-inspection-link.js';

const app = document.getElementById('app');
let currentUser = null;
let equipNames = null;
let year = new Date().getFullYear();
let typeFilter = '';                       // '' = 全種別
let nameFilter = '';                        // 名称あいまい検索
let viewMode = 'month';                     // 'month'（月別・既定）| 'all'（全月）
let viewMonth = new Date().getMonth() + 1;  // 月別表示で見ている月
let plansCache = [];                        // 取得済みの当年の予定（再取得を避ける）
let inspectionSummary = {};                 // 点検実績の突合用: { "line|equip": { "YYYY-MM": { count, equipment_id } } }

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
const typeOf = (pt) => PLAN_TYPES[pt] || PLAN_TYPES.other;

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

// 年間計画のタスクを、指定日付でカレンダーにも表示する（on_calendar=1）。
// 別レコードは作らず同じ予定の planned_date を指定日にして on_calendar を立てるだけなので、
// 年間計画表にそのまま残りつつ、同じ予定がカレンダーにも出る（完了状態も常に一致する）。
async function registerToCalendar(plan) {
  const defaultDate = (plan.planned_date || '').slice(0, 10) || `${year}-01-01`;
  const date = prompt('カレンダーに表示する日付（YYYY-MM-DD）', defaultDate);
  if (date === null) return;
  const d = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { alert('日付は YYYY-MM-DD の形式で入力してください。'); return; }
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
  // 完了は年ごとに記録（annual_year=表示年）。新年は自動で未実施から始まる
  actions.push(plan.status === 'done'
    ? { label: `未完了に戻す（${year}年）`, onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { status: 'pending', annual_year: year })) }
    : { label: `✓ 完了にする（${year}年）`, onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { status: 'done', annual_year: year })) });
  actions.push({ label: '👤 点検者を変更', onClick: () => {
    const name = prompt('点検者名を入力', plan.inspector_name || '');
    if (name === null) return; // キャンセル
    return mutate(() => api.put(`/api/plans/${plan.id}`, { inspector_name: name.trim() || null }));
  } });
  actions.push({ label: '👥 担当者を変更', onClick: () => {
    const name = prompt('担当者名を入力', plan.assignee_name || '');
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
    onClick: () => mutate(() => api.put(`/api/plans/${plan.id}`, { planned_date: `${year}-${mm(m)}-01`, unscheduled: 0 })),
  }));
  openSheet(`「${plan.title}」を何月に？`, actions);
}

// 空セルから その月にタスクを追加（行の種別・設備・点検者を引き継ぐ）
function openAddSheet(row, m) {
  openSheet(`${m}月に予定を追加`, [
    { label: `「${row.title}」を ${m}月 に追加`, onClick: () => mutate(() => api.post('/api/plans', {
      title: row.title,
      plan_type: row.plan_type,
      planned_date: `${year}-${mm(m)}-01`,
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
      ? [{ ...common, planned_date: `${year}-01-01`, unscheduled: 1, annual_only: 1 }]
      : selectedMonths.map((m) => ({ ...common, planned_date: `${year}-${mm(m)}-01`, annual_only: 1 }));

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
  return [...rowsMap.values()].sort((a, b) =>
    (a.line_name || '').localeCompare(b.line_name || '', 'ja') ||
    (a.title || '').localeCompare(b.title || '', 'ja'));
}

// ---------------- 月別表示（既定） ----------------

// 1予定を1行のカードで表示（点検者・状態つき。タップで編集シート／詳細）
function planRow(p, monthLabel) {
  const type = typeOf(p.plan_type);
  const eqLabel = [p.line_name, p.equipment_name].filter(Boolean).join(' ');
  const statusCls = p.status === 'done' ? ' is-done' : (p.status === 'overdue' ? ' is-overdue' : '');
  const canEdit = hasRole(currentUser, 'editor');
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
  const inMonth = plansCache.filter((p) =>
    !p.unscheduled && monthOf(p) === viewMonth && (!typeFilter || p.plan_type === typeFilter) && matchesName(p));
  inMonth.sort((a, b) =>
    (a.line_name || '').localeCompare(b.line_name || '', 'ja') ||
    (a.title || '').localeCompare(b.title || '', 'ja'));

  const undecided = plansCache.filter((p) => p.unscheduled && (!typeFilter || p.plan_type === typeFilter) && matchesName(p));
  const doneCount = inMonth.filter((p) => p.status === 'done').length;

  const list = inMonth.length === 0
    ? el('p', { class: 'empty' }, `${viewMonth}月の予定はありません。`)
    : el('div', { class: 'mplan-list' }, inMonth.map((p) => planRow(p, `${viewMonth}月`)));

  return el('div', {}, [
    monthNav(),
    inMonth.length > 0
      ? el('p', { class: 'hint no-print' }, `${viewMonth}月: ${inMonth.length}件（完了 ${doneCount} / 未完了 ${inMonth.length - doneCount}）`)
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
  return el('div', { class: 'cal-nav no-print', style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
    el('button', { class: 'btn btn-sm', onclick: () => stepTo(viewMonth > 1 ? viewMonth - 1 : 12) }, '‹'),
    el('select', { onchange: (e) => stepTo(Number(e.target.value)) },
      MONTHS.map((m) => el('option', { value: m, selected: m === viewMonth }, `${m}月`))),
    el('button', { class: 'btn btn-sm', onclick: () => stepTo(viewMonth < 12 ? viewMonth + 1 : 1) }, '›'),
  ]);
}

// ---------------- 全月グリッド表示 ----------------

function buildYearGrid(rows) {
  if (rows.length === 0) {
    return el('p', { class: 'empty' },
      typeFilter ? `「${PLAN_TYPES[typeFilter].label}」の予定はありません。`
                 : '予定はまだありません。上の「一括登録」から登録してください。');
  }
  const canEdit = hasRole(currentUser, 'editor');

  const head = el('tr', {}, [
    el('th', { class: 'annual-task-col' }, 'タスク / 設備 / 点検者'),
    el('th', { class: 'annual-unsched-col' }, '未定'),
    ...MONTHS.map((m) => el('th', {}, `${m}月`)),
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

        // 点検種別かつ設備が設定されている場合、当年の実績件数を表示
        const inspKey = `${row.line_name || ''}|${row.equipment_name || ''}`;
        const inspMonthKey = `${year}-${mm(m)}`;
        const inspData = (row.plan_type === 'inspection' && (row.line_name || row.equipment_name))
          ? inspectionSummary[inspKey]?.[inspMonthKey]
          : null;
        const lastDay = new Date(year, m, 0).getDate();
        const inspBadge = inspData
          ? el('a', {
              class: 'annual-insp-count',
              href: `/pages/inspection?equipment_id=${inspData.equipment_id}&from=${year}-${mm(m)}-01&to=${year}-${mm(m)}-${String(lastDay).padStart(2, '0')}`,
              title: `${year}年${m}月の点検実績: ${inspData.count}件`,
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

// CSVは年間表（行=タスク／列=12ヶ月）を出力。種別フィルターを反映し、各月の完了状態を含める
function exportCsv(rows, enc) {
  if (rows.length === 0) { alert('出力対象がありません。'); return; }
  const columns = [
    { label: '種別', value: (r) => typeOf(r.plan_type).label },
    { label: 'タスク', value: (r) => r.title },
    { label: '設備', value: (r) => [r.line_name, r.equipment_name].filter(Boolean).join(' ') },
    { label: '点検者', value: (r) => r.inspector_name || '' },
    { label: '担当者', value: (r) => r.assignee_name || '' },
    { label: '未定', value: (r) => monthCellText(r.unscheduledList) },
    ...MONTHS.map((m) => ({ label: `${m}月`, value: (r) => monthCellText(r.months.get(m)) })),
  ];
  const text = buildCsvText(rows, columns);
  downloadCsv(`annual_plan_${year}_${typeFilter || 'all'}.csv`, text, enc);
}

// ---------------- 月末アラート ----------------

function monthEndAlert() {
  const today = new Date();
  // 月末アラートは「今年」を表示しているときだけ（過去年・来年の表示中は出さない）
  if (year !== today.getFullYear()) return null;
  const curMonth = today.getMonth() + 1;
  const daysInMonth = new Date(today.getFullYear(), curMonth, 0).getDate();
  const daysLeft = daysInMonth - today.getDate();
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
  return el('div', { class: 'annual-toolbar no-print' }, [
    el('div', { class: 'annual-filter-row' }, [
      el('label', { class: 'annual-filter' }, ['種別: ', sel]),
      nameInput,
    ]),
    viewToggle,
    el('div', { class: 'annual-output-btns' }, [
      el('button', { class: 'btn btn-sm', onclick: () => window.print() }, '🖨 印刷'),
      // クリック時点の絞り込み結果で出力（検索中に再描画しても最新を反映）
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv(buildRows(plansCache), 'UTF-8') }, '📥 CSV'),
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv(buildRows(plansCache), 'sjis') }, '📥 CSV(Excel)'),
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-sm', onclick: () => renderPlanImport(year, () => renderYear()) }, '📤 CSV取込')
        : null,
    ]),
  ]);
}

// 年ナビ: タスクは毎年共通だが、完了状況は年ごと。表示年を切り替えられる
function yearNav() {
  const thisYear = new Date().getFullYear();
  return el('div', { class: 'cal-nav no-print', style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
    el('a', { class: 'btn btn-sm', href: '/pages/plan' }, '‹ カレンダー'),
    el('div', { style: 'flex:1;display:flex;align-items:center;justify-content:center;gap:6px' }, [
      el('button', { class: 'btn btn-sm', title: '前の年', onclick: () => { year -= 1; renderYear().catch(showError); } }, '‹'),
      el('span', { style: 'font-weight:600;min-width:96px;text-align:center' },
        `${year}年${year === thisYear ? '（今年）' : ''}`),
      el('button', { class: 'btn btn-sm', title: '次の年', onclick: () => { year += 1; renderYear().catch(showError); } }, '›'),
    ]),
  ]);
}

// 結果表示領域（月別/全月）。名称検索ではここだけ再描画して入力欄のフォーカスを保つ
let viewBox = el('div', {});

// 絞り込み結果のみ再描画（入力欄・ツールバーは作り直さない）
function renderResults() {
  const rows = buildRows(plansCache);
  render(viewBox, viewMode === 'month' ? buildMonthView() : buildYearGrid(rows));
}

// 取得済みデータ（plansCache）から画面全体を描画（再取得なし）
function renderView() {
  const printTitle = viewMode === 'month' ? `${viewMonth}月 点検計画（毎年共通）` : '年間計画表（毎年共通）';
  viewBox = el('div', {});
  renderResults();

  render(app, [
    monthEndAlert(),
    yearNav(),
    hasRole(currentUser, 'editor') ? buildBulkForm() : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'print-only report-print-header' }, [
        el('h2', {}, printTitle),
        el('p', {}, `種別: ${typeLabel()}　出力日: ${new Date().toLocaleDateString('sv-SE')}`),
      ]),
      toolbar(),
      el('div', { class: 'cal-legend no-print', style: 'margin-bottom:8px' },
        Object.values(PLAN_TYPES).map(({ label, color, bg }) =>
          el('span', { class: 'cal-legend-item', style: `background:${bg};color:${color}` }, label))),
      viewBox,
      el('p', { class: 'hint no-print', style: 'margin-top:8px' },
        hasRole(currentUser, 'editor')
          ? 'タップで 完了・点検者変更・移動・削除ができます。全月表示では空欄の＋でその月に追加できます。'
          : 'タップで詳細へ。'),
    ]),
  ]);
}

// 年間計画（annual_only）を年に関係なく全件取得して描画（毎年共通のテンプレート）
// 同時に当年の点検実績も取得し、年間計画グリッドとの突合に使う
async function renderYear() {
  const [{ plans }, equipData, inspData] = await Promise.all([
    api.get(`/api/plans?annual_only=1&year=${year}`),
    api.get('/api/equipment').catch(() => ({ equipment: [] })),
    api.get(`/api/inspections?from=${year}-01-01&to=${year}-12-31`).catch(() => ({ inspections: [] })),
  ]);
  plansCache = plans || [];

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
    const month = (ins.inspected_at || '').slice(0, 7); // YYYY-MM
    if (!inspectionSummary[lineEquipKey]) inspectionSummary[lineEquipKey] = {};
    if (!inspectionSummary[lineEquipKey][month]) {
      inspectionSummary[lineEquipKey][month] = { count: 0, equipment_id: ins.equipment_id };
    }
    inspectionSummary[lineEquipKey][month].count++;
  }

  renderView();
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
