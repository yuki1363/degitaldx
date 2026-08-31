// 01 保全計画 — カレンダー表示・予定登録・編集
//   URL: /pages/plan            … カレンダー（今月 / 今週）
//        /pages/plan?new=1      … 新規登録
//        /pages/plan?edit=N     … 編集
//        /pages/plan?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { fetchEquipNames, buildEquipCascade } from '/js/equip-names.js';
import { el, render, formatDate, formatDateTime, ACTION_LABELS, nowLocalInputValue } from '/js/util.js';
import { openExcelExport } from '/js/excel-fill.js';
import { CONSTRUCTION_NOTICE_FIELDS } from '/js/permit-fields.js';
import { buildInspectionStartUrl } from '/js/plan-inspection-link.js';

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

// 指定日の予定一覧シート。refresh は削除後にカレンダーを再描画するためのコールバック。
function showDaySheet(fullDate, dateLabel, dayPlans, refresh) {
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const canEdit = hasRole(currentUser, 'editor');
  const sheet = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-title' }, `${dateLabel}（${dayPlans.length}件）`),
    el('div', { class: 'day-plan-list' }, dayPlans.map((p) => {
      const type = PLAN_TYPES[p.plan_type] || PLAN_TYPES.other;
      const canStart = p.plan_type === 'inspection' && p.status !== 'done' && canEdit;
      // 複数日にまたがる予定かどうか（判定用。単日なら「削除」＝全期間削除と同じ）
      const isPeriod = p.planned_end_date && p.planned_end_date.slice(0, 10) !== p.planned_date.slice(0, 10);
      const canComplete = p.status !== 'done' && canEdit;
      return el('div', { class: 'day-plan-row' }, [
        el('a', { class: 'day-plan-item', href: `/pages/plan?id=${p.id}` }, [
          el('span', { class: 'annual-type-badge', style: `background:${type.bg};color:${type.color}` }, type.label),
          el('span', { class: 'day-plan-title' }, p.title),
          el('span', { class: 'day-plan-status' }, STATUS_LABELS[p.status] || p.status),
        ]),
        canStart
          ? el('button', {
              class: 'day-plan-start-btn', title: '点検を開始（計画の設備・日付・点検者を引き継ぎ）',
              onclick: async (e) => {
                e.currentTarget.disabled = true;
                window.location.href = await buildInspectionStartUrl(p, fullDate);
              },
            }, '✅')
          : null,
        canComplete
          ? el('button', {
              class: 'day-plan-done-btn',
              title: isPeriod ? 'この日だけ完了にする（他の日程は未完了のまま残ります）' : '完了にする',
              onclick: async (e) => {
                const msg = isPeriod
                  ? `「${p.title}」の${dateLabel}だけ完了にしますか？\n他の日程は未完了のまま残ります（全期間を完了にしたい場合は詳細画面から）。`
                  : `「${p.title}」を完了にしますか？`;
                if (!confirm(msg)) return;
                e.currentTarget.disabled = true;
                try {
                  await api.post(`/api/plans/${p.id}/complete-day`, { date: fullDate });
                  close();
                  refresh?.();
                } catch (err) {
                  alert(err.message);
                  e.currentTarget.disabled = false;
                }
              },
            }, '✓')
          : null,
        canEdit
          ? el('button', {
              class: 'day-plan-del-btn',
              title: isPeriod ? 'この日だけ削除（他の日程は残ります）' : '削除',
              onclick: async (e) => {
                const msg = isPeriod
                  ? `「${p.title}」の${dateLabel}だけ削除しますか？\n他の日程は残ります（全期間を削除したい場合は詳細画面から）。`
                  : `「${p.title}」を削除しますか？`;
                if (!confirm(msg)) return;
                e.currentTarget.disabled = true;
                try {
                  await api.post(`/api/plans/${p.id}/delete-day`, { date: fullDate });
                  close();
                  refresh?.();
                } catch (err) {
                  alert(err.message);
                  e.currentTarget.disabled = false;
                }
              },
            }, '🗑')
          : null,
      ]);
    })),
    canEdit
      ? el('button', { class: 'sheet-btn', onclick: () => { close(); go(`?new=1&date=${fullDate}`); } }, '＋ この日に予定を追加')
      : null,
    el('button', { class: 'sheet-btn sheet-cancel', onclick: close }, '閉じる'),
  ]);
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
}

// 予定が指定日に含まれるか（開始日〜終了日の期間予定は全日に表示する。月表示・週表示で共用）
function inRange(p, fullDate) {
  const s = p.planned_date.slice(0, 10);
  const e = (p.planned_end_date || p.planned_date).slice(0, 10);
  return s <= fullDate && fullDate <= e;
}

// ---------------- 月表示 ----------------

async function renderMonthCalendar(year, month) {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { plans } = await api.get(`/api/plans?month=${monthStr}`);

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
    // 予定の有無に関わらず日付をクリックでき、その日のシート（＋この日に予定を追加）を開く
    const handleDayClick = () => showDaySheet(fullDate, `${month}月${d}日`, dayPlans,
      () => renderMonthCalendar(year, month).catch(showError));
    cells.push(
      el('div', { class: `cal-cell${isToday ? ' is-today' : ''}` }, [
        el('button', { class: 'cal-day-num is-clickable', onclick: handleDayClick }, String(d)),
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
    // 期間予定（開始〜終了）は期間中の全日に表示する（月表示と同じ判定）
    const dayPlans = plans.filter((p) => inRange(p, dayStr));
    const isToday = dayStr === todayStr;
    const isWeekend = i === 0 || i === 6;
    return el('div', {
      class: `cal-week-col${isToday ? ' is-today' : ''}`,
      style: isWeekend ? 'background:#fafafa' : '',
    }, [
      el('div', { class: 'cal-week-header' }, [
        el('span', { class: 'cal-weekday-short', style: isWeekend ? 'color:#6b7280' : '' }, WEEKDAYS[i]),
        el('button', {
          class: `cal-day-num is-clickable${isToday ? ' is-today' : ''}`,
          onclick: () => showDaySheet(dayStr, `${day.getMonth() + 1}月${day.getDate()}日`, dayPlans,
            () => renderWeekCalendar(weekStart).catch(showError)),
        }, String(day.getDate())),
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

// 工事連絡書テンプレートの「入力項目」をまとめる（同じタグは1つに）。
// テンプレート未登録時は標準項目にフォールバック。詳細(renderDetail)と編集(renderForm)で共有。
function buildPermitFields(templates) {
  const seen = new Set();
  const fields = [];
  for (const t of (templates || [])) {
    if (t.template_type !== 'construction_notice') continue;
    let fs = [];
    try { fs = JSON.parse(t.fields_json || '[]'); } catch { fs = []; }
    for (const f of (Array.isArray(fs) ? fs : [])) {
      if (f && f.tag && !seen.has(f.tag)) {
        seen.add(f.tag);
        fields.push({ tag: f.tag, label: f.label || f.tag, type: f.type || 'text' });
      }
    }
  }
  if (fields.length === 0) {
    return CONSTRUCTION_NOTICE_FIELDS.map((f) => ({ tag: f.tag, label: f.label || f.tag, type: f.type || 'text' }));
  }
  return fields;
}

// plan.form_values_json を安全にパース
function parseFormValues(jsonStr) {
  try { return jsonStr ? (JSON.parse(jsonStr) || {}) : {}; }
  catch { return {}; }
}

async function renderDetail(id, fromAnnual = false) {
  // 計画と工事連絡書テンプレートを並行取得（テンプレートは入力状態の総数算出に使う）
  const [{ plan }, tmplRes] = await Promise.all([
    api.get(`/api/plans/${id}`),
    api.get('/api/print-templates').catch(() => ({ templates: [] })),
  ]);
  const canEdit = hasRole(currentUser, 'editor');
  const type = PLAN_TYPES[plan.plan_type] || PLAN_TYPES.other;
  // 複数日にまたがる期間予定か（このページの「削除」「完了にする」は常に全期間が対象。
  // 1日だけの削除・完了はカレンダーの日付シートから行う）
  const isPeriodPlan = !!(plan.planned_end_date && plan.planned_end_date.slice(0, 10) !== plan.planned_date.slice(0, 10));

  // 時間帯・工事連絡書（帳票）の入力状態を form_values_json から算出
  const formValues = parseFormValues(plan.form_values_json);
  const timeStart = formValues['開始時間'] ? String(formValues['開始時間']) : '';
  const timeEnd = formValues['終了時間'] ? String(formValues['終了時間']) : '';
  const timeText = timeStart || timeEnd
    ? `${timeStart || '—'} 〜 ${timeEnd || '—'}`
    : '';

  // 帳票入力欄（開始/終了時間は時間帯で表示済みなので集計から除外）
  const permitFields = buildPermitFields(tmplRes.templates)
    .filter((f) => f.tag !== '開始時間' && f.tag !== '終了時間');
  const isFilled = (v) => v != null && String(v).trim() !== '';
  const filledFields = permitFields.filter((f) => isFilled(formValues[f.tag]));
  const permitTotal = permitFields.length;
  const permitFilled = filledFields.length;
  // 種別=工事、または時間帯/帳票に入力があるときだけ関連行を表示する
  const showConstructionInfo = plan.plan_type === 'construction' || timeText || permitFilled > 0;

  // 工事連絡書の入力状態バッジ（未入力/一部入力/入力済み）
  const permitStatusEl = (() => {
    if (permitTotal === 0) return null;
    let label, color, bg;
    if (permitFilled === 0) { label = '未入力'; color = '#64748b'; bg = '#f1f5f9'; }
    else if (permitFilled < permitTotal) { label = `一部入力（${permitFilled}/${permitTotal}項目）`; color = '#1e40af'; bg = '#eff6ff'; }
    else { label = `入力済み（${permitFilled}/${permitTotal}項目）`; color = '#15803d'; bg = '#f0fdf4'; }
    return el('span', { class: 'status-badge', style: `background:${bg};color:${color}` }, label);
  })();

  // 入力済みの帳票内容（チェックは ✓、それ以外は値）を折りたたみ表示
  const permitDetailsEl = filledFields.length > 0
    ? el('details', { class: 'permit-detail' }, [
        el('summary', {}, `工事連絡書の入力内容（${permitFilled}件）`),
        el('div', { class: 'permit-detail-list' },
          filledFields.map((f) => el('div', { class: 'permit-detail-row' }, [
            el('span', { class: 'permit-detail-label' }, f.label),
            el('span', { class: 'permit-detail-value' }, f.type === 'check' ? '✓' : String(formValues[f.tag])),
          ]))
        ),
      ])
    : null;

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
      infoRow('設備名', plan.line_name),
      infoRow('機器名', plan.equipment_name),
      infoRow('点検者', plan.inspector_name),
      infoRow('担当者', plan.assignee_name),
      showConstructionInfo ? infoRow('時間帯', timeText) : null,
      showConstructionInfo && permitStatusEl
        ? el('div', { class: 'info-row' }, [
            el('span', { class: 'info-label' }, '工事連絡書'),
            el('span', { class: 'info-value' }, [permitStatusEl]),
          ])
        : null,
      showConstructionInfo
        ? infoRow('工事連絡書 印刷日', plan.printed_at ? formatDate(plan.printed_at) : '未印刷')
        : null,
      showConstructionInfo ? permitDetailsEl : null,
      infoRow('備考', plan.note),
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          plan.plan_type === 'inspection'
            ? el('button', {
                class: 'btn btn-primary',
                // 計画の設備・実施日・点検者を引き継いで点検入力へ。設備が一致すれば点検項目も読み込まれる。
                // plan_id を渡すので点検保存時にこの計画は自動で完了になる。
                onclick: async (e) => {
                  e.currentTarget.disabled = true;
                  window.location.href = await buildInspectionStartUrl(plan);
                },
              }, '✅ 点検を開始')
            : null,
          plan.status !== 'done'
            ? el('button', {
                class: plan.plan_type === 'inspection' ? 'btn' : 'btn btn-primary',
                title: isPeriodPlan ? `${formatDate(plan.planned_date)} 〜 ${formatDate(plan.planned_end_date)} の全期間を完了にします` : undefined,
                onclick: async () => {
                  if (isPeriodPlan) {
                    const msg = `「${plan.title}」の全期間（${formatDate(plan.planned_date)} 〜 ${formatDate(plan.planned_end_date)}）を完了にしますか？\n1日だけ完了にしたい場合はカレンダーの日付をタップして完了にしてください。`;
                    if (!confirm(msg)) return;
                  }
                  await api.put(`/api/plans/${id}`, { status: 'done' });
                  go(`?id=${id}`);
                },
              }, isPeriodPlan ? '🏁 全期間を完了にする' : '✓ 完了にする')
            : null,
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}${fromAnnual ? '&from=annual' : ''}`) }, '編集'),
          el('button', { class: 'btn', onclick: () => openExcelExport('construction_notice', plan) }, '📄 帳票(Excel)出力'),
          el('button', {
            class: 'btn btn-danger',
            title: isPeriodPlan ? `${formatDate(plan.planned_date)} 〜 ${formatDate(plan.planned_end_date)} の全期間を削除します` : undefined,
            onclick: async () => {
              const msg = isPeriodPlan
                ? `「${plan.title}」の全期間（${formatDate(plan.planned_date)} 〜 ${formatDate(plan.planned_end_date)}）を削除しますか？\n1日だけ削除したい場合はカレンダーの日付をタップして削除してください。`
                : `「${plan.title}」を削除しますか？`;
              if (!confirm(msg)) return;
              await api.del(`/api/plans/${id}`);
              go('');
            },
          }, isPeriodPlan ? '🗑 全期間を削除' : '削除'),
        ])
      : null,
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
  // 工事連絡書テンプレートの「入力項目」（テンプレート未登録時は標準項目）。計画ページで入力する欄
  const permitFields = buildPermitFields(tmplRes.templates);
  const permitValues = parseFormValues(existing?.form_values_json);

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
  // 開始時間・終了時間は日付の隣に表示し、計画の帳票入力値（form_values_json）に保存する
  const timeStart = el('input', { type: 'time', value: permitValues['開始時間'] != null ? String(permitValues['開始時間']) : '' });
  timeStart.addEventListener('input', () => { permitValues['開始時間'] = timeStart.value; });
  const timeEnd = el('input', { type: 'time', value: permitValues['終了時間'] != null ? String(permitValues['終了時間']) : '' });
  timeEnd.addEventListener('input', () => { permitValues['終了時間'] = timeEnd.value; });
  const inspectorInput = el('input', { type: 'text', value: existing?.inspector_name || '', placeholder: '点検者名（任意）' });
  const assigneeInput = el('input', { type: 'text', value: existing?.assignee_name || '', placeholder: '担当者名（任意）' });
  const statusSelect = el('select', {},
    Object.entries(STATUS_LABELS).map(([value, label]) =>
      el('option', { value, selected: (existing?.status || 'pending') === value }, label)
    )
  );
  const noteInput    = el('textarea', { value: existing?.note || '' });

  // 年間計画のタスクを編集しているとき、上の日付でカレンダーにも表示するチェック。
  // 年間計画表にはそのまま残り、同じ予定がカレンダーにも出る（on_calendar=1）。
  const isAnnualTask = !!existing?.annual_only;
  const onCalCheckbox = el('input', { type: 'checkbox' });
  onCalCheckbox.checked = !!existing?.on_calendar;

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
    return el('div', { class: 'field' + (f.type === 'textarea' ? ' pf-full' : '') }, [el('label', {}, f.label), input]);
  };
  // 帳票入力欄は種別に関わらず表示する（工事以外の予定でも工事連絡書を出せるように）
  const renderPermit = () => {
    if (permitFields.length === 0) { render(permitBox, []); return; }
    // 開始時間/終了時間は日付の隣に表示済みなので除外。似た項目をまとめて表示する
    const fields = permitFields.filter((f) => f.tag !== '開始時間' && f.tag !== '終了時間');
    const inputs = fields.filter((f) => f.type !== 'check');
    const checks = fields.filter((f) => f.type === 'check');
    const children = [
      el('h4', { style: 'margin:0 0 4px;font-size:14px;color:#374151' }, '帳票（工事連絡許可書）の入力'),
      el('p', { class: 'hint', style: 'margin:0 0 8px' }, 'ここで入力した内容が「帳票出力」でExcelに差し込まれます（種別に関わらず入力できます）。'),
    ];
    if (inputs.length) children.push(el('div', { class: 'pf-grid' }, inputs.map(permitInput)));
    if (checks.length) {
      children.push(el('div', { class: 'pt-tags-label', style: 'margin:8px 0 4px' }, '許可必要作業（該当をチェック）'));
      children.push(el('div', { class: 'pf-checklist' }, checks.map(permitInput)));
    }
    render(permitBox, el('div', { class: 'card', style: 'background:#f8fafc;margin:12px 0 0' }, children));
  };

  const save = async () => {
    const body = {
      title: titleInput.value.trim(),
      plan_type: typeSelect.value,
      planned_date: startInput.value,
      planned_end_date: endInput.value || null,
      line_name: cascade.lineInput.value.trim() || null,
      equipment_name: cascade.equipInput.value.trim() || null,
      inspector_name: inspectorInput.value.trim() || null,
      assignee_name: assigneeInput.value.trim() || null,
      status: statusSelect.value,
      note: noteInput.value.trim() || null,
      recurrence_rule: null,
      form_values_json: Object.keys(permitValues).length ? JSON.stringify(permitValues) : null,
      // 同時編集ガード: 編集開始時点の updated_at を送り、他の人が先に更新していたら409で知らせる
      ...(existing ? { expected_updated_at: existing.updated_at } : {}),
    };
    // 年間計画タスクは「カレンダーにも表示」フラグを送る（年間計画表にはそのまま残る）
    if (isAnnualTask) body.on_calendar = onCalCheckbox.checked ? 1 : 0;
    if (!body.title) { alert('タイトルは必須です。'); return; }
    if (!body.planned_date) { alert('開始日は必須です。'); return; }
    if (body.planned_end_date && body.planned_end_date < body.planned_date) {
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
      el('div', { class: 'field-pair' }, [field('開始日（必須）', startInput), field('開始時間', timeStart)]),
      el('div', { class: 'field-pair' }, [field('終了日（空欄なら1日のみ）', endInput), field('終了時間', timeEnd)]),
      isAnnualTask
        ? el('label', { class: 'plan-oncal-check', style: 'display:flex;align-items:center;gap:8px;margin:4px 0 8px;padding:8px 10px;background:#eff6ff;border-radius:6px;font-size:14px;cursor:pointer' },
            [onCalCheckbox, el('span', {}, '📅 この予定を上の日付でカレンダーにも表示する（年間計画表にもそのまま残ります）')])
        : null,
      field('設備名', cascade.lineInput),
      cascade.lineDatalist,
      field('機器名', cascade.equipInput),
      cascade.equipDatalist,
      field('点検者', inspectorInput),
      field('担当者', assigneeInput),
      field('状態', statusSelect),
      field('備考', noteInput),
      permitBox,
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
