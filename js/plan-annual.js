// 01 保全計画 — 年間計画表（月ごとの一括登録 + 年間グリッド表示）
//   URL: /pages/plan-annual
//   設備・タスクを決め、実施する月をチェックして登録すると、その月ぶんの
//   予定（maintenance_plan）がまとめて作成される。下に年間の一覧（行=タスク／
//   列=12ヶ月）を表示し、各セルから予定詳細へ移動できる。

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { fetchEquipNames, buildEquipCascade } from '/js/equip-names.js';
import { el, render } from '/js/util.js';

const app = document.getElementById('app');
let currentUser = null;
let equipNames = null;
let year = new Date().getFullYear();

const PLAN_TYPES = {
  inspection:   { label: '点検',    color: '#1e40af', bg: '#dbeafe' },
  parts:        { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事',    color: '#b45309', bg: '#fef3c7' },
  other:        { label: 'その他',  color: '#6b7280', bg: '#f3f4f6' },
};
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 一括登録フォーム ----------------

function buildBulkForm(onSubmitted) {
  const cascade = buildEquipCascade(equipNames, { idPrefix: 'annual' });
  const titleInput = el('input', { type: 'text', placeholder: '例: 月次点検' });
  const typeSelect = el('select', {},
    Object.entries(PLAN_TYPES).map(([v, { label }]) => el('option', { value: v }, label)));
  const assigneeInput = el('input', { type: 'text', placeholder: '担当者名（任意）' });
  const dayInput = el('input', { type: 'number', min: '1', max: '31', value: '1', style: 'width:90px' });
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
    if (selectedMonths.length === 0) { alert('実施する月を1つ以上選んでください。'); return; }

    const day = Math.max(1, Math.min(31, parseInt(dayInput.value, 10) || 1));
    const items = selectedMonths.map((m) => {
      const lastDay = new Date(year, m, 0).getDate(); // 1始まりの月 m の末日
      const d = String(Math.min(day, lastDay)).padStart(2, '0');
      return {
        title,
        plan_type: typeSelect.value,
        planned_date: `${year}-${String(m).padStart(2, '0')}-${d}`,
        line_name: cascade.lineInput.value.trim() || null,
        equipment_name: cascade.equipInput.value.trim() || null,
        assignee_name: assigneeInput.value.trim() || null,
        note: noteInput.value.trim() || null,
      };
    });

    try {
      const { created } = await api.post('/api/plans/batch', { items });
      alert(`${created}件の予定を登録しました。`);
      await onSubmitted();
    } catch (err) { alert(err.message); }
  };

  return el('div', { class: 'card' }, [
    el('h3', { class: 'card-title' }, `${year}年の予定を一括登録`),
    el('p', { class: 'hint' }, 'タイトル・設備・担当を決め、実施する月をチェックして登録すると、その月ぶんの予定がまとめて作られます。'),
    el('div', { class: 'field' }, [el('label', {}, 'タイトル（必須）'), titleInput]),
    el('div', { class: 'field' }, [el('label', {}, '種別'), typeSelect]),
    el('div', { class: 'field' }, [el('label', {}, '設備名'), cascade.lineInput]), cascade.lineDatalist,
    el('div', { class: 'field' }, [el('label', {}, '機器名'), cascade.equipInput]), cascade.equipDatalist,
    el('div', { class: 'field' }, [el('label', {}, '担当者'), assigneeInput]),
    el('div', { class: 'field' }, [
      el('label', {}, '各月の実施日'),
      dayInput,
      el('p', { class: 'hint' }, '日（1〜31）。末日が無い月は自動でその月の末日に調整します。'),
    ]),
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

// ---------------- 年間グリッド ----------------

function buildYearGrid(plans) {
  // タスク単位（種別+設備+機器+タイトル）にまとめ、月ごとに予定を割り当てる
  const rowsMap = new Map();
  for (const p of plans) {
    const key = `${p.plan_type}|${p.line_name || ''}|${p.equipment_name || ''}|${p.title}`;
    if (!rowsMap.has(key)) {
      rowsMap.set(key, {
        plan_type: p.plan_type, line_name: p.line_name,
        equipment_name: p.equipment_name, title: p.title, months: new Map(),
      });
    }
    const month = Number((p.planned_date || '').slice(5, 7));
    const row = rowsMap.get(key);
    if (!row.months.has(month)) row.months.set(month, []);
    row.months.get(month).push(p);
  }
  const rows = [...rowsMap.values()].sort((a, b) =>
    (a.line_name || '').localeCompare(b.line_name || '', 'ja') ||
    (a.title || '').localeCompare(b.title || '', 'ja'));

  if (rows.length === 0) {
    return el('p', { class: 'empty' }, `${year}年の予定はまだありません。上のフォームから登録してください。`);
  }

  const head = el('tr', {}, [
    el('th', { class: 'annual-task-col' }, 'タスク / 設備'),
    ...MONTHS.map((m) => el('th', {}, `${m}月`)),
  ]);

  const body = rows.map((row) => {
    const type = PLAN_TYPES[row.plan_type] || PLAN_TYPES.other;
    const eqLabel = [row.line_name, row.equipment_name].filter(Boolean).join(' ');
    return el('tr', {}, [
      el('td', { class: 'annual-task-col' }, [
        el('span', { class: 'annual-type-badge', style: `background:${type.bg};color:${type.color}` }, type.label),
        el('div', { class: 'annual-task-title' }, row.title),
        eqLabel ? el('div', { class: 'annual-task-eq' }, eqLabel) : null,
      ]),
      ...MONTHS.map((m) => {
        const list = row.months.get(m) || [];
        if (list.length === 0) return el('td', { class: 'annual-cell' }, '');
        const p = list[0];
        const done = list.every((x) => x.status === 'done');
        const overdue = list.some((x) => x.status === 'overdue');
        const mark = list.length > 1 ? String(list.length) : (done ? '✓' : (overdue ? '!' : '●'));
        return el('td', { class: 'annual-cell' }, [
          el('a', {
            class: `annual-mark${done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}`,
            href: `/pages/plan?id=${p.id}`,
            title: `${row.title}（${STATUS_LABELS[p.status] || p.status}）`,
            style: `color:${type.color}`,
          }, mark),
        ]);
      }),
    ]);
  });

  return el('div', { class: 'report-table-wrap' }, [
    el('table', { class: 'report-table annual-grid' }, [
      el('thead', {}, [head]),
      el('tbody', {}, body),
    ]),
  ]);
}

// ---------------- 年ナビ・全体描画 ----------------

function yearNav() {
  return el('div', { class: 'cal-nav', style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
    el('a', { class: 'btn btn-sm', href: '/pages/plan' }, '‹ カレンダー'),
    el('button', { class: 'btn btn-sm', onclick: () => { year -= 1; renderYear().catch(showError); } }, '‹'),
    el('span', { style: 'flex:1;text-align:center;font-weight:600' }, `${year}年`),
    el('button', { class: 'btn btn-sm', onclick: () => { year += 1; renderYear().catch(showError); } }, '›'),
  ]);
}

async function renderYear() {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`; // to は排他
  const { plans } = await api.get(`/api/plans?from=${from}&to=${to}`);
  const canEdit = hasRole(currentUser, 'editor');

  render(app, [
    yearNav(),
    canEdit ? buildBulkForm(renderYear) : null,
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, `${year}年 年間計画表`),
      el('div', { class: 'cal-legend', style: 'margin-bottom:8px' },
        Object.values(PLAN_TYPES).map(({ label, color, bg }) =>
          el('span', { class: 'cal-legend-item', style: `background:${bg};color:${color}` }, label))),
      buildYearGrid(plans),
      el('p', { class: 'hint', style: 'margin-top:8px' }, '● 予定 ／ ✓ 完了 ／ ! 期限超過 ／ 数字は同月複数件。タップで詳細へ。'),
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
