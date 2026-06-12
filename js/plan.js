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

  // 日→予定リスト のマップ
  const byDay = {};
  for (const p of plans) {
    const day = p.planned_date.slice(8, 10);
    (byDay[day] || (byDay[day] = [])).push(p);
  }

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
    const dayPlans = byDay[dayStr] || [];
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
      infoRow('予定日', formatDate(plan.planned_date)),
      infoRow('設備', plan.equipment_name ? `${plan.equipment_code} ${plan.equipment_name}` : null),
      infoRow('担当者', plan.assignee_name),
      infoRow('繰り返し', plan.recurrence_rule),
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
  const [{ results: equipmentList }, { results: userList }] = await Promise.all([
    api.get('/api/equipment').then((r) => ({ results: r.equipment })),
    api.get('/api/users').then((r) => ({ results: r.users })),
  ]);

  const f = {
    title: el('input', { type: 'text', value: existing?.title || '', placeholder: '例: 1号機 月次点検' }),
    plan_type: el('select', {},
      Object.entries(PLAN_TYPES).map(([value, { label }]) =>
        el('option', { value, selected: (existing?.plan_type || 'inspection') === value }, label)
      )
    ),
    planned_date: el('input', { type: 'date', value: existing?.planned_date || nowLocalInputValue().slice(0, 10) }),
    equipment_id: el('select', {},
      [el('option', { value: '' }, '— 設備を選択（任意）'),
      ...equipmentList.map((e) =>
        el('option', { value: e.id, selected: existing?.equipment_id === e.id }, `${e.code} ${e.name}`)
      )]
    ),
    assignee_id: el('select', {},
      [el('option', { value: '' }, '— 担当者を選択（任意）'),
      ...userList.map((u) =>
        el('option', { value: u.id, selected: existing?.assignee_id === u.id }, u.name || u.email)
      )]
    ),
    status: el('select', {},
      Object.entries(STATUS_LABELS).map(([value, label]) =>
        el('option', { value, selected: (existing?.status || 'pending') === value }, label)
      )
    ),
    recurrence_rule: el('input', { type: 'text', value: existing?.recurrence_rule || '', placeholder: '例: monthly / yearly / every:30' }),
    note: el('textarea', { value: existing?.note || '' }),
  };

  const save = async () => {
    const body = {
      title: f.title.value.trim(),
      plan_type: f.plan_type.value,
      planned_date: f.planned_date.value,
      equipment_id: f.equipment_id.value ? Number(f.equipment_id.value) : null,
      assignee_id: f.assignee_id.value ? Number(f.assignee_id.value) : null,
      status: f.status.value,
      recurrence_rule: f.recurrence_rule.value.trim() || null,
      note: f.note.value.trim() || null,
    };
    if (!body.title) { alert('タイトルは必須です。'); return; }
    if (!body.planned_date) { alert('予定日は必須です。'); return; }
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
      field('タイトル（必須）', f.title),
      field('種別', f.plan_type),
      field('予定日（必須）', f.planned_date),
      field('設備', f.equipment_id),
      field('担当者', f.assignee_id),
      field('状態', f.status),
      field('繰り返し', f.recurrence_rule),
      field('備考', f.note),
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
