// ホーム概要をタブ1つにまとめる。
//   タブ: 期限超過 / 直近 / 最近の動き。各タブに件数バッジを表示する。
//   従来は「月末アラート」「保全予定の状況」「最近の動き」が縦に並んで同じ予定が
//   重複表示されていたのを、1つのカードにまとめて切り替えで見られるようにする。

import { api } from '/js/api.js';
import { el, render, formatDate, formatDateTime } from '/js/util.js';
import { fetchPlanStatus } from '/js/plan-summary.js';

const TYPE_BADGE = {
  inspection: { label: '点検', color: '#1e40af', bg: '#dbeafe' },
  parts: { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事', color: '#b45309', bg: '#fef3c7' },
  other: { label: 'その他', color: '#6b7280', bg: '#f3f4f6' },
};
const ACTIVITY_DOT = { alert: '#dc2626', warning: '#b45309', info: '#1e40af' };

function planRow(p, over) {
  const t = TYPE_BADGE[p.plan_type] || TYPE_BADGE.other;
  const eq = [p.line_name, p.equipment_name].filter(Boolean).join(' ');
  return el('a', { class: 'plan-sum-item', href: `/pages/plan?id=${p.id}` }, [
    el('span', { class: 'plan-sum-date' + (over ? ' is-over' : '') }, formatDate(p.planned_date)),
    el('span', { class: 'plan-sum-badge', style: `background:${t.bg};color:${t.color}` }, t.label),
    el('span', { class: 'plan-sum-title' }, p.title + (eq ? `（${eq}）` : '')),
  ]);
}

function activityRow(n) {
  return el('a', {
    class: 'home-activity-item' + (n.acknowledged_at ? '' : ' is-unack'),
    href: n.link_url || '/pages/notifications',
  }, [
    el('span', { class: 'home-activity-dot', style: `background:${ACTIVITY_DOT[n.level] || ACTIVITY_DOT.info}` }),
    el('span', { class: 'home-activity-text' }, n.title),
    el('span', { class: 'home-activity-time' }, formatDateTime(n.created_at)),
  ]);
}

function planTabContent(list, over, emptyMsg) {
  if (list.length === 0) return el('p', { class: 'home-tab-empty' }, emptyMsg);
  return el('div', {}, [
    ...list.slice(0, 8).map((p) => planRow(p, over)),
    list.length > 8 ? el('p', { class: 'hint', style: 'margin:4px 0' }, `…ほか ${list.length - 8} 件`) : null,
    el('a', { class: 'home-activity-more', style: 'display:inline-block;margin-top:8px', href: '/pages/plan' }, 'カレンダーで見る ›'),
  ]);
}

function activityTabContent(notifications) {
  if (!notifications || notifications.length === 0) return el('p', { class: 'home-tab-empty' }, '最近の動きはありません。');
  return el('div', {}, [
    ...notifications.map(activityRow),
    el('a', { class: 'home-activity-more', style: 'display:inline-block;margin-top:8px', href: '/pages/notifications' }, 'すべて見る ›'),
  ]);
}

// 通知のバッジ（ベル・通知タイル）を更新する
function updateNotifBadges(unread) {
  const bell = document.getElementById('notif-bell');
  if (bell) bell.hidden = false;
  const badgeText = unread > 99 ? '99+' : String(unread);
  for (const id of ['notif-bell-badge', 'tile-notif-badge']) {
    const b = document.getElementById(id);
    if (!b) continue;
    if (unread > 0) { b.textContent = badgeText; b.hidden = false; } else b.hidden = true;
  }
}

// ホーム概要タブを描画（取得失敗しても画面を妨げない）
export async function loadHomeTabs(container) {
  let overdue = [], upcoming = [], notifications = [], unread = 0;
  try {
    const [status, notif] = await Promise.all([
      fetchPlanStatus(7).catch(() => ({ overdue: [], upcoming: [] })),
      api.get('/api/notifications?limit=6').catch(() => ({ notifications: [], unread_count: 0 })),
    ]);
    overdue = status.overdue || [];
    upcoming = status.upcoming || [];
    notifications = notif.notifications || [];
    unread = notif.unread_count || 0;
  } catch { /* 失敗時は空のまま */ }

  updateNotifBadges(unread);

  // すべて空なら何も表示しない
  if (overdue.length === 0 && upcoming.length === 0 && notifications.length === 0) {
    render(container, []);
    return;
  }

  const tabs = [
    { key: 'overdue', label: '期限超過', count: overdue.length, over: true, content: () => planTabContent(overdue, true, '期限超過の予定はありません。') },
    { key: 'upcoming', label: '直近', count: upcoming.length, content: () => planTabContent(upcoming, false, '直近7日の予定はありません。') },
    { key: 'activity', label: '最近の動き', count: notifications.length, content: () => activityTabContent(notifications) },
  ];

  // 既定タブ: 期限超過があればそれ、なければ直近、なければ最近の動き
  let active = overdue.length ? 'overdue' : (upcoming.length ? 'upcoming' : 'activity');

  const bar = el('div', { class: 'home-tabs-bar', role: 'tablist' });
  const body = el('div', { class: 'home-tabs-body' });

  const renderActive = () => {
    const tab = tabs.find((t) => t.key === active);
    render(body, tab.content());
    [...bar.children].forEach((btn, i) => btn.classList.toggle('is-active', tabs[i].key === active));
  };

  tabs.forEach((t) => {
    const badge = t.count > 0
      ? el('span', { class: 'home-tab-count' + (t.over ? ' is-over' : '') }, String(t.count))
      : null;
    bar.appendChild(el('button', {
      class: 'home-tab', type: 'button',
      onclick: () => { active = t.key; renderActive(); },
    }, [el('span', { class: 'home-tab-label' }, t.label), badge]));
  });

  render(container, el('section', { class: 'home-tabs' }, [bar, body]));
  renderActive();
}
