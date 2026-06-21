// 01 保全計画 — カレンダー表示・予定登録・編集
//   URL: /pages/plan            … カレンダー（今月 / 今週）
//        /pages/plan?new=1      … 新規登録
//        /pages/plan?edit=N     … 編集
//        /pages/plan?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { fetchEquipNames, buildEquipCascade } from '/js/equip-names.js';
import { el, render, formatDate, formatDateTime, ACTION_LABELS, nowLocalInputValue } from '/js/util.js';
import { buildCommentsCard } from '/js/comments.js';
import { openExcelExport } from '/js/excel-fill.js';

const PLAN_TYPES = {
  inspection:   { label: '点検',    color: '#1e40af', bg: '#dbeafe' },
  parts:        { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事',    color: '#b45309', bg: '#fef3c7' },
  other:        { label: 'その他',  color: '#6b7280', bg: '#f3f4f6' },
};
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };

const RECUR_LABELS = {
  daily: '毎日', weekly: '毎週', monthly: '毎月', yearly: '毎年',
};

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/plan${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// 繰り返しルールを日本語に変換
function formatRecurrence(ruleJson) {
  if (!ruleJson) return 'なし';
  try {
    const { freq, interval = 1, until } = JSON.parse(ruleJson);
    let label = freq === 'daily' && interval > 1
      ? `${interval}日ごと`
      : (RECUR_LABELS[freq] || freq);
    if (interval > 1 && freq !== 'daily') label = `${interval}${label.replace('毎', '')}ごと`;
    if (until) label += ` (〜${until})`;
    return label;
  } catch {
    return ruleJson;
  }
}

// 月の最初の日の曜日と日数を返す
function monthInfo(year, month) {
  return {
    firstDay: new Date(year, month - 1, 1).getDay(),
    daysInMonth: new Date(year, month, 0).getDate(),
  };
}

// 週の月曜日（または日曜日）の Date を返す（日本では日曜始まりでも月曜始まりでも）
// ここでは日曜始まりにする（カレンダーヘッダーと一致させる）
function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay()); // 直前の日曜日へ
  return d;
}

function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------- カレンダー共通UI ----------------

function buildCalNavAndToggle({ label, onPrev, onNext, viewMode, onMonthView, onWeekView }) {
  return el('div', { class: 'cal-nav', style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px' }, [
    el('button', { class: 'btn btn-sm', onclick: onPrev }, '‹'),
    el('span', { class: 'cal-month-label', style: 'flex:1;text-align:center' }, label),
    el('button', { class: 'btn btn-sm', onclick: onNext }, '›'),
    el('div', { style: 'display:flex;gap:4px' }, [
      el('button', {
        class: `btn btn-sm${viewMode === 'month' ? ' btn-primary' : ''}`,
        onclick: onMonthView,
      }, '月'),
      el('button', {
        class: `btn btn-sm${viewMode === 'week' ? ' btn-primary' : ''}`,
        onclick: onWeekView,
      }, '週'),
    ]),
  ]);
}

// ---------------- 日付クリック時のシート（その日の全予定） ----------------

function showDaySheet(fullDate, dateLabel, dayPlans) {
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const sheet = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-title' }, `${dateLabel}（${dayPlans.length}件）`),
    el('div', { class: 'day-plan-list' }, dayPlans.map((p) => {
      const type = PLAN_TYPES[p.plan_type] || PLAN_TYPES.other;
      const canStart = p.plan_type === 'inspection' && p.status !== 'done' && hasRole(currentUser, 'editor');
      const inspectionUrl = (() => {
        if (!canStart) return null;
        const q = new URLSearchParams({ new: '1', plan_id: String(p.id), date: fullDate });
        const assignee = p.inspector_name || p.assignee_name || '';
        if (assignee) q.set('assignee', assignee);
        return `/pages/inspection?${q}`;
      })();
      return el('div', { class: 'day-plan-row' }, [
        el('a', { class: 'day-plan-item', href: `/pages/plan?id=${p.id}` }, [
          el('span', { class: 'annual-type-badge', style: `background:${type.bg};color:${type.color}` }, type.label),
          el('span', { class: 'day-plan-title' }, p.title),
          el('span', { class: 'day-plan-status' }, STATUS_LABELS[p.status] || p.status),
        ]),
        canStart
          ? el('a', { class: 'day-plan-start-btn', href: inspectionUrl, title: '点検を開始' }, '✅')
          : null,
      ]);
    })),
    hasRole(currentUser, 'editor')
      ? el('button', { class: 'sheet-btn', onclick: () => { close(); go(`?new=1&date=${fullDate}`); } }, '＋ この日に予定を追加')
      : null,
    el('button', { class: 'sheet-btn sheet-cancel', onclick: close }, '閉じる'),
  ]);
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
}

// ---------------- 月表示 ----------------

async function renderMonthCalendar(year, month) {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { plans } = await api.get(`/api/plans?month=${monthStr}`);

  const inRange = (p, fullDate) => {
    const s = p.planned_date.slice(0, 10);
    const e = (p.planned_end_date || p.planned_date).slice(0, 10);
    return s <= fullDate && fullDate <= e;
  };

  const { firstDay, daysInMonth } = monthInfo(year, month);
  const todayStr = new Date().toISOString().slice(0, 10);

  const cells = [];
  for (let i = 0; i < firstDay; i++) {
    cells.push(el('div', { class: 'cal-cell is-empty' }, []));
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, '0');
    const fullDate = `${year}-${String(month).padStart(2, '0')}-${dayStr}`;
    const dayPlans = plans.filter((p) => inRange(p, fullDate));
    const isToday = fullDate === todayStr;
    const handleDayClick = dayPlans.length > 0
      ? () => showDaySheet(fullDate, `${month}月${d}日`, dayPlans)
      : null;
    cells.push(
      el('div', { class: `cal-cell${isToday ? ' is-today' : ''}` }, [
        handleDayClick
          ? el('button', { class: 'cal-day-num is-clickable', onclick: handleDayClick }, String(d))
          : el('div', { class: 'cal-day-num' }, String(d)),
        ...dayPlans.slice(0, 3).map((p) =>
          el('a', {
            class: 'cal-event',
            href: `/pages/plan?id=${p.id}`,
            style: `background:${PLAN_TYPES[p.plan_type]?.bg || '#f3f4f6'};color:${PLAN_TYPES[p.plan_type]?.color || '#374151'}`,
          }, p.title)
        ),
        dayPlans.length > 3
          ? el('button', { class: 'cal-more', onclick: handleDayClick }, `他${dayPlans.length - 3}件`)
          : null,
      ])
    );
  }

  const prevMonth = month === 1 ? [year - 1, 12] : [year, month - 1];
  const nextMonth = month === 12 ? [year + 1, 1] : [year, month + 1];

  render(app, [
    buildCalNavAndToggle({
      label: `${year}年${month}月`,
      onPrev: () => renderMonthCalendar(...prevMonth).catch(showError),
      onNext: () => renderMonthCalendar(...nextMonth).catch(showError),
      viewMode: 'month',
      onMonthView: () => renderMonthCalendar(year, month).catch(showError),
      onWeekView: () => {
        const today = new Date();
        renderWeekCalendar(getWeekStart(today)).catch(showError);
      },
    }),
    el('div', { class: 'action-row', style: 'margin-bottom:8px' }, [
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 予定を追加')
        : null,
      el('a', { class: 'btn', href: '/pages/plan-annual' }, '📅 年間計画表'),
    ]),
    el('div', { class: 'cal-grid' }, [
      ...['日', '月', '火', '水', '木', '金', '土'].map((d) =>
        el('div', { class: 'cal-weekday' }, d)
      ),
      ...cells,
    ]),
    el('div', { class: 'cal-legend' }, [
      ...Object.entries(PLAN_TYPES).map(([, { label, color, bg }]) =>
        el('span', { class: 'cal-legend-item', style: `background:${bg};color:${color}` }, label)
      ),
    ]),
  ]);
}

// ---------------- 週表示 ----------------

async function renderWeekCalendar(weekStart) {
  // 週の7日間（日〜土）
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  const fromStr = dateToStr(days[0]);
  // to は exclusive: 土曜の翌日（日曜）
  const toDate = new Date(days[6]);
  toDate.setDate(toDate.getDate() + 1);
  const toStr = dateToStr(toDate);

  const { plans } = await api.get(`/api/plans?from=${fromStr}&to=${toStr}`);

  const todayStr = new Date().toISOString().slice(0, 10);
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  const prevWeek = new Date(weekStart);
  prevWeek.setDate(prevWeek.getDate() - 7);
  const nextWeek = new Date(weekStart);
  nextWeek.setDate(nextWeek.getDate() + 7);

  // 年月表示（週が複数月にまたがる場合は "M月DD日〜M月DD日" 形式）
  const startLabel = `${days[0].getMonth() + 1}/${days[0].getDate()}`;
  const endLabel = `${days[6].getMonth() + 1}/${days[6].getDate()}`;
  const weekLabel = `${days[0].getFullYear()}年 ${startLabel}〜${endLabel}`;

  const weekCols = days.map((day, i) => {
    const dayStr = dateToStr(day);
    const dayPlans = plans.filter((p) => p.planned_date.slice(0, 10) === dayStr);
    const isToday = dayStr === todayStr;
    const isWeekend = i === 0 || i === 6;
    return el('div', {
      class: `cal-week-col${isToday ? ' is-today' : ''}`,
      style: isWeekend ? 'background:#fafafa' : '',
    }, [
      el('div', { class: 'cal-week-header' }, [
        el('span', { class: 'cal-weekday-short', style: isWeekend ? 'color:#6b7280' : '' }, WEEKDAYS[i]),
        el('div', { class: `cal-day-num${isToday ? ' is-today' : ''}` }, String(day.getDate())),
      ]),
      ...dayPlans.map((p) =>
        el('a', {
          class: 'cal-event',
          href: `/pages/plan?id=${p.id}`,
          style: `background:${PLAN_TYPES[p.plan_type]?.bg || '#f3f4f6'};color:${PLAN_TYPES[p.plan_type]?.color || '#374151'};display:block;margin:2px 0`,
        }, p.title)
      ),
      dayPlans.length === 0
        ? el('div', { class: 'cal-week-empty' }, '')
        : null,
    ]);
  });

  render(app, [
    buildCalNavAndToggle({
      label: weekLabel,
      onPrev: () => renderWeekCalendar(prevWeek).catch(showError),
      onNext: () => renderWeekCalendar(nextWeek).catch(showError),
      viewMode: 'week',
      onMonthView: () => {
        const now = new Date();
        renderMonthCalendar(now.getFullYear(), now.getMonth() + 1).catch(showError);
      },
      onWeekView: () => renderWeekCalendar(weekStart).catch(showError),
    }),
    el('div', { class: 'action-row', style: 'margin-bottom:8px' }, [
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 予定を追加')
        : null,
      el('a', { class: 'btn', href: '/pages/plan-annual' }, '📅 年間計画表'),
    ]),
    el('div', { class: 'cal-week-grid' }, weekCols),
    el('div', { class: 'cal-legend' }, [
      ...Object.entries(PLAN_TYPES).map(([, { label, color, bg }]) =>
        el('span', { class: 'cal-legend-item', style: `background:${bg};color:${color}` }, label)
      ),
    ]),
  ]);
}

// ---------------- 詳細 ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

async function renderDetail(id, fromAnnual = false) {
  const { plan } = await api.get(`/api/plans/${id}`);
  const canEdit = hasRole(currentUser, 'editor');
  const type = PLAN_TYPES[plan.plan_type] || PLAN_TYPES.other;

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, plan.title),
        el('span', {
          class: 'status-badge',
          style: `background:${type.bg};color:${type.color}`,
        }, type.label),
      ]),
      infoRow('状態', STATUS_LABELS[plan.status] || plan.status),
      fromAnnual ? null : infoRow(
        plan.planned_end_date && plan.planned_end_date !== plan.planned_date ? '期間' : '予定日',
        plan.planned_end_date && plan.planned_end_date !== plan.planned_date
          ? `${formatDate(plan.planned_date)} 〜 ${formatDate(plan.planned_end_date)}`
          : formatDate(plan.planned_date)
      ),
      infoRow('繰り返し', formatRecurrence(plan.recurrence_rule)),
      infoRow('設備名', plan.line_name),
      infoRow('機器名', plan.equipment_name),
      infoRow('点検者', plan.inspector_name),
      infoRow('担当者', plan.assignee_name),
      infoRow('備考', plan.note),
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          plan.plan_type === 'inspection'
            ? el('button', {
                class: 'btn btn-primary',
                onclick: async () => {
                  let equipmentId = null;
                  try {
                    const { equipment } = await api.get('/api/equipment');
                    const match = equipment.find((e) =>
                      (e.line_name || '') === (plan.line_name || '') &&
                      (e.equipment_name || '') === (plan.equipment_name || '')
                    );
                    if (match) equipmentId = match.id;
                  } catch { /* 設備解決失敗時は未指定で開く */ }
                  // plan_id を渡し、点検保存時にこの計画を自動で完了にする
                  // 計画日・担当者も事前入力するためURLに含める
                  const q = new URLSearchParams({ new: '1', plan_id: String(plan.id) });
                  if (equipmentId) q.set('equipment_id', String(equipmentId));
                  if (plan.planned_date) q.set('date', plan.planned_date.slice(0, 10));
                  const assignee = plan.inspector_name || plan.assignee_name || '';
                  if (assignee) q.set('assignee', assignee);
                  window.location.href = `/pages/inspection?${q}`;
                },
              }, '✅ 点検を開始')
            : null,
          plan.status !== 'done'
            ? el('button', {
                class: plan.plan_type === 'inspection' ? 'btn' : 'btn btn-primary',
                onclick: async () => {
                  await api.put(`/api/plans/${id}`, { status: 'done' });
                  go(`?id=${id}`);
                },
              }, '✓ 完了にする')
            : null,
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}${fromAnnual ? '&from=annual' : ''}`) }, '編集'),
          el('button', { class: 'btn', onclick: () => openExcelExport('construction_notice', plan) }, '📄 帳票(Excel)出力'),
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm(`「${plan.title}」を削除しますか？`)) return;
              await api.del(`/api/plans/${id}`);
              go('');
            },
          }, '削除'),
        ])
      : null,
    buildCommentsCard('maintenance_plan', id, currentUser),
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', {}, label), input]);
}

async function renderForm(existing, fromAnnual = false) {
  const [names, tmplRes] = await Promise.all([
    fetchEquipNames(),
    api.get('/api/print-templates').catch(() => ({ templates: [] })),
  ]);
  // 工事連絡書テンプレートの「入力項目」をまとめる（同じタグは1つに）。計画ページで入力する欄
  const permitFields = [];
  {
    const seen = new Set();
    for (const t of (tmplRes.templates || [])) {
      if (t.template_type !== 'construction_notice') continue;
      let fs = [];
      try { fs = JSON.parse(t.fields_json || '[]'); } catch { fs = []; }
      for (const f of (Array.isArray(fs) ? fs : [])) {
        if (f && f.tag && !seen.has(f.tag)) {
          seen.add(f.tag);
          permitFields.push({ tag: f.tag, label: f.label || f.tag, type: f.type || 'text' });
        }
      }
    }
  }
  const permitValues = (() => {
    try { return existing?.form_values_json ? (JSON.parse(existing.form_values_json) || {}) : {}; }
    catch { return {}; }
  })();
  const existingRule = (() => {
    try { return existing?.recurrence_rule ? JSON.parse(existing.recurrence_rule) : null; } catch { return null; }
  })();

  const cascade = buildEquipCascade(names, {
    line: existing?.line_name || '',
    equip: existing?.equipment_name || '',
    idPrefix: 'plan',
  });

  const today = nowLocalInputValue().slice(0, 10);
  const prefillDate = new URLSearchParams(window.location.search).get('date') || today;

  const titleInput   = el('input', { type: 'text', value: existing?.title || '', placeholder: '例: 1号機 月次点検' });
  const typeSelect   = el('select', {},
    Object.entries(PLAN_TYPES).map(([value, { label }]) =>
      el('option', { value, selected: (existing?.plan_type || 'inspection') === value }, label)
    )
  );
  const startInput   = el('input', { type: 'date', value: existing?.planned_date || prefillDate });
  const endInput     = el('input', { type: 'date', value: existing?.planned_end_date || '' });
  const inspectorInput = el('input', { type: 'text', value: existing?.inspector_name || '', placeholder: '点検者名（任意）' });
  const assigneeInput = el('input', { type: 'text', value: existing?.assignee_name || '', placeholder: '担当者名（任意）' });
  const statusSelect = el('select', {},
    Object.entries(STATUS_LABELS).map(([value, label]) =>
      el('option', { value, selected: (existing?.status || 'pending') === value }, label)
    )
  );
  const noteInput    = el('textarea', { value: existing?.note || '' });

  // ---- 繰り返しUI ----
  const freqOptions = [
    ['', 'なし（1回のみ）'],
    ['daily', '毎日'],
    ['weekly', '毎週'],
    ['monthly', '毎月'],
    ['yearly', '毎年'],
    ['daily_custom', 'N日ごと'],
  ];
  // 既存ルールからUI初期値を決定
  const initFreq = (() => {
    if (!existingRule) return '';
    if (existingRule.freq === 'daily' && existingRule.interval > 1) return 'daily_custom';
    return existingRule.freq || '';
  })();
  const initInterval = existingRule?.interval > 1 ? existingRule.interval : 7;
  const initUntil = existingRule?.until || '';

  const freqSelect = el('select', {},
    freqOptions.map(([v, l]) => el('option', { value: v, selected: v === initFreq }, l))
  );
  const intervalInput = el('input', {
    type: 'number', min: '2', max: '365', value: String(initInterval), style: 'width:80px',
  });
  const untilInput = el('input', { type: 'date', value: initUntil });

  const intervalRow = el('div', { class: 'field-pair', style: 'align-items:center;gap:8px' }, [
    el('div', { class: 'field' }, [el('label', {}, '間隔'), intervalInput]),
    el('span', { style: 'padding-top:22px' }, '日ごと'),
  ]);
  intervalRow.style.display = initFreq === 'daily_custom' ? '' : 'none';

  freqSelect.addEventListener('change', () => {
    intervalRow.style.display = freqSelect.value === 'daily_custom' ? '' : 'none';
  });

  const buildRecurrenceRule = () => {
    const freq = freqSelect.value;
    if (!freq) return null;
    if (freq === 'daily_custom') {
      const n = parseInt(intervalInput.value, 10) || 2;
      const rule = { freq: 'daily', interval: n };
      if (untilInput.value) rule.until = untilInput.value;
      return rule;
    }
    const rule = { freq, interval: 1 };
    if (untilInput.value) rule.until = untilInput.value;
    return rule;
  };

  // ---- 帳票（工事連絡許可書）の入力欄。種別=工事のときに表示し、計画に保存する ----
  const permitBox = el('div', {});
  const permitInput = (f) => {
    const cur = permitValues[f.tag] != null ? String(permitValues[f.tag]) : '';
    if (f.type === 'check') {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = cur === '✓';
      cb.addEventListener('change', () => { permitValues[f.tag] = cb.checked ? '✓' : ''; });
      return el('label', { class: 'pf-input-check' }, [cb, ` ${f.label}`]);
    }
    let input;
    if (f.type === 'textarea') input = el('textarea', { rows: '2', value: cur });
    else if (f.type === 'date') input = el('input', { type: 'date', value: cur });
    else if (f.type === 'time') input = el('input', { type: 'time', value: cur });
    else input = el('input', { type: 'text', value: cur });
    input.addEventListener('input', () => { permitValues[f.tag] = input.value; });
    return el('div', { class: 'field' }, [el('label', {}, f.label), input]);
  };
  const renderPermit = () => {
    if (typeSelect.value !== 'construction' || permitFields.length === 0) { render(permitBox, []); return; }
    render(permitBox, el('div', { class: 'card', style: 'background:#f8fafc;margin:12px 0 0' }, [
      el('h4', { style: 'margin:0 0 4px;font-size:14px;color:#374151' }, '帳票（工事連絡許可書）の入力'),
      el('p', { class: 'hint', style: 'margin:0 0 8px' }, 'ここで入力した内容が「帳票出力」でExcelに差し込まれます。'),
      ...permitFields.map(permitInput),
    ]));
  };
  typeSelect.addEventListener('change', renderPermit);

  const save = async () => {
    const recRule = buildRecurrenceRule();
    const body = {
      title: titleInput.value.trim(),
      plan_type: typeSelect.value,
      planned_date: fromAnnual ? (existing?.planned_date || '') : startInput.value,
      planned_end_date: fromAnnual ? null : (endInput.value || null),
      line_name: cascade.lineInput.value.trim() || null,
      equipment_name: cascade.equipInput.value.trim() || null,
      inspector_name: inspectorInput.value.trim() || null,
      assignee_name: assigneeInput.value.trim() || null,
      status: statusSelect.value,
      note: noteInput.value.trim() || null,
      recurrence_rule: recRule,
      form_values_json: Object.keys(permitValues).length ? JSON.stringify(permitValues) : null,
    };
    if (!body.title) { alert('タイトルは必須です。'); return; }
    if (!fromAnnual && !body.planned_date) { alert('開始日は必須です。'); return; }
    if (!fromAnnual && body.planned_end_date && body.planned_end_date < body.planned_date) {
      alert('終了日は開始日以降にしてください。'); return;
    }
    try {
      if (existing) {
        await api.put(`/api/plans/${existing.id}`, body);
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/plans', body);
        go(`?id=${id}`);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '予定を編集' : '予定を追加'),
      field('タイトル（必須）', titleInput),
      field('種別', typeSelect),
      fromAnnual ? null : field('開始日（必須）', startInput),
      fromAnnual ? null : field('終了日（空欄なら1日のみ）', endInput),
      field('設備名', cascade.lineInput),
      cascade.lineDatalist,
      field('機器名', cascade.equipInput),
      cascade.equipDatalist,
      field('点検者', inspectorInput),
      field('担当者', assigneeInput),
      field('状態', statusSelect),
      field('備考', noteInput),
      permitBox,
      el('div', { class: 'card', style: 'background:#f8fafc;margin:12px 0 0' }, [
        el('h4', { style: 'margin:0 0 8px;font-size:14px;color:#374151' }, '繰り返し設定'),
        field('繰り返し', freqSelect),
        intervalRow,
        field('繰り返し終了日（空欄なら無期限）', untilInput),
      ]),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', {
          class: 'btn',
          onclick: () => (existing ? go(`?id=${existing.id}`) : go('')),
        }, 'キャンセル'),
      ]),
    ]),
  ]);
  renderPermit();
}

// ---------------- 起動 ----------------

(async () => {
  try {
    currentUser = await getCurrentUser();
    const params = new URLSearchParams(window.location.search);
    const fromAnnual = params.get('from') === 'annual';
    if (params.get('id')) {
      await renderDetail(Number(params.get('id')), fromAnnual);
    } else if (params.get('edit')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('編集する権限がありません。');
      const { plan } = await api.get(`/api/plans/${Number(params.get('edit'))}`);
      await renderForm(plan, fromAnnual);
    } else if (params.get('new')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('登録する権限がありません。');
      await renderForm(null, fromAnnual);
    } else {
      const now = new Date();
      await renderMonthCalendar(now.getFullYear(), now.getMonth() + 1);
    }
  } catch (err) {
    showError(err);
  }
})();
