// 01 保全計画 — カレンダー表示・予定登録・編集
//   URL: /pages/plan            … カレンダー（今月）
//        /pages/plan?new=1      … 新規登録
//        /pages/plan?edit=N     … 編集
//        /pages/plan?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDate, formatDateTime, ACTION_LABELS, nowLocalInputValue, isoToLocalInputValue, localInputToIso } from '/js/util.js';

const PLAN_TYPES = {
  inspection:   { label: '点検',    color: '#1e40af', bg: '#dbeafe' },
  parts:        { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事',    color: '#b45309', bg: '#fef3c7' },
  other:        { label: 'その他',  color: '#6b7280', bg: '#f3f4f6' },
};
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/plan${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- カレンダー ----------------

async function renderCalendar(year, month) {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { plans } = await api.get(`/api/plans?month=${monthStr}`);

  // 期間予定（planned_end_date あり）は開始〜終了の各日に表示する
  const inRange = (p, fullDate) => {
    const s = p.planned_date.slice(0, 10);
    const e = (p.planned_end_date || p.planned_date).slice(0, 10);
    return s <= fullDate && fullDate <= e;
  };

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  // カレンダーグリッド
  const cells = [];
  // 空白セル
  for (let i = 0; i < firstDay; i++) {
    cells.push(el('div', { class: 'cal-cell is-empty' }, []));
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, '0');
    const fullDate = `${year}-${String(month).padStart(2, '0')}-${dayStr}`;
    const dayPlans = plans.filter((p) => inRange(p, fullDate));
    const isToday = fullDate === todayStr;
    cells.push(
      el('div', { class: `cal-cell${isToday ? ' is-today' : ''}` }, [
        el('div', { class: 'cal-day-num' }, String(d)),
        ...dayPlans.slice(0, 3).map((p) =>
          el('a', {
            class: 'cal-event',
            href: `/pages/plan?id=${p.id}`,
            style: `background:${PLAN_TYPES[p.plan_type]?.bg || '#f3f4f6'};color:${PLAN_TYPES[p.plan_type]?.color || '#374151'}`,
          }, p.title)
        ),
        dayPlans.length > 3
          ? el('div', { class: 'cal-more' }, `+${dayPlans.length - 3}件`)
          : null,
      ])
    );
  }

  const prevMonth = month === 1 ? [year - 1, 12] : [year, month - 1];
  const nextMonth = month === 12 ? [year + 1, 1] : [year, month + 1];

  render(app, [
    el('div', { class: 'cal-nav' }, [
      el('button', {
        class: 'btn btn-sm',
        onclick: () => renderCalendar(...prevMonth).catch(showError),
      }, '‹'),
      el('span', { class: 'cal-month-label' }, `${year}年${month}月`),
      el('button', {
        class: 'btn btn-sm',
        onclick: () => renderCalendar(...nextMonth).catch(showError),
      }, '›'),
    ]),
    hasRole(currentUser, 'editor')
      ? el('div', { style: 'margin-bottom:12px' }, [
          el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 予定を追加'),
        ])
      : null,
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

// ---------------- 詳細 ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

async function renderDetail(id) {
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
      infoRow(
        plan.planned_end_date && plan.planned_end_date !== plan.planned_date ? '期間' : '予定日',
        plan.planned_end_date && plan.planned_end_date !== plan.planned_date
          ? `${formatDate(plan.planned_date)} 〜 ${formatDate(plan.planned_end_date)}`
          : formatDate(plan.planned_date)
      ),
      infoRow('設備', plan.equipment_name),
      infoRow('担当者', plan.assignee_name),
      infoRow('備考', plan.note),
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          plan.status !== 'done'
            ? el('button', {
                class: 'btn btn-primary',
                onclick: async () => {
                  await api.put(`/api/plans/${id}`, { status: 'done' });
                  go(`?id=${id}`);
                },
              }, '✓ 完了にする')
            : null,
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}`) }, '編集'),
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
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', {}, label), input]);
}

async function renderForm(existing) {
  // 設備欄の入力候補に在庫の「設備名(line_name)」と「機器名(equipment_name)」の両方を使う。
  // どちらでも選べて、自由入力もできる（候補が取れなくても続行）。
  let equipOptions = [];
  try {
    const { parts } = await api.get('/api/parts');
    const names = new Set();
    for (const p of parts || []) {
      if (p.line_name) names.add(p.line_name);
      if (p.equipment_name) names.add(p.equipment_name);
    }
    equipOptions = [...names].sort((a, b) => a.localeCompare(b, 'ja'));
  } catch { /* 候補なしでも続行 */ }

  const today = nowLocalInputValue().slice(0, 10);

  const titleInput = el('input', { type: 'text', value: existing?.title || '', placeholder: '例: 1号機 月次点検' });
  const typeSelect = el('select', {},
    Object.entries(PLAN_TYPES).map(([value, { label }]) =>
      el('option', { value, selected: (existing?.plan_type || 'inspection') === value }, label)
    )
  );
  const startInput = el('input', { type: 'date', value: existing?.planned_date || today });
  const endInput = el('input', { type: 'date', value: existing?.planned_end_date || '' });

  // 設備: 在庫の設備名・機器名を候補に出しつつ自由入力できる datalist
  const datalistId = 'plan-equip-options';
  const datalist = el('datalist', { id: datalistId }, equipOptions.map((n) => el('option', { value: n })));
  const equipInput = el('input', { type: 'text', list: datalistId, value: existing?.equipment_name || '', placeholder: '在庫の設備名・機器名から選択 / 自由入力' });

  // 担当者: 既定は空欄（自由入力）
  const assigneeInput = el('input', { type: 'text', value: existing?.assignee_name || '', placeholder: '担当者名（任意）' });

  const statusSelect = el('select', {},
    Object.entries(STATUS_LABELS).map(([value, label]) =>
      el('option', { value, selected: (existing?.status || 'pending') === value }, label)
    )
  );
  const noteInput = el('textarea', { value: existing?.note || '' });

  // 終了日は常に表示。空なら「1日のみ」、入力すれば「開始日〜終了日」の期間になる
  const endField = field('終了日（空欄なら1日のみ）', endInput);

  const save = async () => {
    const body = {
      title: titleInput.value.trim(),
      plan_type: typeSelect.value,
      planned_date: startInput.value,
      planned_end_date: endInput.value || null,
      equipment_name: equipInput.value.trim() || null,
      assignee_name: assigneeInput.value.trim() || null,
      status: statusSelect.value,
      note: noteInput.value.trim() || null,
    };
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
      field('開始日（必須）', startInput),
      endField,
      field('設備', equipInput),
      datalist,
      field('担当者', assigneeInput),
      field('状態', statusSelect),
      field('備考', noteInput),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', {
          class: 'btn',
          onclick: () => (existing ? go(`?id=${existing.id}`) : go('')),
        }, 'キャンセル'),
      ]),
    ]),
  ]);
}

// ---------------- 起動 ----------------

(async () => {
  try {
    currentUser = await getCurrentUser();
    const params = new URLSearchParams(window.location.search);
    if (params.get('id')) {
      await renderDetail(Number(params.get('id')));
    } else if (params.get('edit')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('編集する権限がありません。');
      const { plan } = await api.get(`/api/plans/${Number(params.get('edit'))}`);
      await renderForm(plan);
    } else if (params.get('new')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('登録する権限がありません。');
      await renderForm(null);
    } else {
      const now = new Date();
      await renderCalendar(now.getFullYear(), now.getMonth() + 1);
    }
  } catch (err) {
    showError(err);
  }
})();
