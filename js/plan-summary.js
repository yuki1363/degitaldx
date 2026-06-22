// 保全予定の状況（期限超過・直近）の集計と表示。ホーム/ダッシュボードで共有する。
//   期限超過 = 未完了で終了日（無ければ予定日）が今日より前
//   直近     = 未完了で予定日が今日〜upcomingDays日後
//   対象はカレンダーの予定（年間計画表専用・未定は /api/plans の範囲クエリで除外済み）。

import { api } from '/js/api.js';
import { el, render, formatDate } from '/js/util.js';

const TYPE_BADGE = {
  inspection: { label: '点検', color: '#1e40af', bg: '#dbeafe' },
  parts: { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事', color: '#b45309', bg: '#fef3c7' },
  other: { label: 'その他', color: '#6b7280', bg: '#f3f4f6' },
};

export async function fetchPlanStatus(upcomingDays = 7) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 120 * 86400000);
  const to = new Date(today.getTime() + (upcomingDays + 1) * 86400000);
  const limitStr = fmt(new Date(today.getTime() + upcomingDays * 86400000));

  const { plans } = await api.get(`/api/plans?from=${fmt(from)}&to=${fmt(to)}`);
  const overdue = [];
  const upcoming = [];
  for (const p of (plans || [])) {
    if (p.status === 'done') continue;
    const start = (p.planned_date || '').slice(0, 10);
    const end = (p.planned_end_date || p.planned_date || '').slice(0, 10);
    if (end && end < todayStr) overdue.push(p);
    else if (start >= todayStr && start <= limitStr) upcoming.push(p);
  }
  const byDate = (a, b) => (a.planned_date || '').localeCompare(b.planned_date || '');
  overdue.sort(byDate);
  upcoming.sort(byDate);
  return { overdue, upcoming };
}

function row(p, over) {
  const t = TYPE_BADGE[p.plan_type] || TYPE_BADGE.other;
  const eq = [p.line_name, p.equipment_name].filter(Boolean).join(' ');
  return el('a', { class: 'plan-sum-item', href: `/pages/plan?id=${p.id}` }, [
    el('span', { class: 'plan-sum-date' + (over ? ' is-over' : '') }, formatDate(p.planned_date)),
    el('span', { class: 'plan-sum-badge', style: `background:${t.bg};color:${t.color}` }, t.label),
    el('span', { class: 'plan-sum-title' }, p.title + (eq ? `（${eq}）` : '')),
  ]);
}

export function renderPlanStatus(container, { overdue, upcoming }) {
  if (overdue.length === 0 && upcoming.length === 0) { render(container, []); return; }
  const sections = [el('h2', { class: 'home-activity-title', style: 'margin:0 0 8px' }, '保全予定の状況')];
  if (overdue.length) {
    sections.push(el('div', { class: 'plan-sum-head is-over' }, `⚠ 期限超過 ${overdue.length}件`));
    sections.push(...overdue.slice(0, 5).map((p) => row(p, true)));
  }
  if (upcoming.length) {
    sections.push(el('div', { class: 'plan-sum-head', style: overdue.length ? 'margin-top:8px' : '' }, `📅 直近の予定 ${upcoming.length}件`));
    sections.push(...upcoming.slice(0, 5).map((p) => row(p, false)));
  }
  sections.push(el('a', { class: 'home-activity-more', style: 'display:inline-block;margin-top:8px', href: '/pages/plan' }, 'カレンダーで見る ›'));
  render(container, el('section', { class: 'home-activity' }, sections));
}

// 取得して描画（失敗しても画面を妨げない）
export async function loadPlanStatusInto(container, upcomingDays = 7) {
  try {
    renderPlanStatus(container, await fetchPlanStatus(upcomingDays));
  } catch { /* 取得失敗時は何も出さない */ }
}
