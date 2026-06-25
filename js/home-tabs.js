// ホーム概要タブ（期限超過 / 直近 / 年間計画 / 通知）
//   通知タブ: チャット未読（ユーザー別既読数付き）＋システム通知を集約
//   年間計画タブ: 今月の未完了・期限超過・直近14日を表示

import { api } from '/js/api.js';
import { el, render, formatDate, formatDateTime } from '/js/util.js';
import { fetchPlanStatus } from '/js/plan-summary.js';

const TYPE_BADGE = {
  inspection:   { label: '点検',    color: '#1e40af', bg: '#dbeafe' },
  parts:        { label: '部品交換', color: '#15803d', bg: '#dcfce7' },
  construction: { label: '工事',    color: '#b45309', bg: '#fef3c7' },
  other:        { label: 'その他',  color: '#6b7280', bg: '#f3f4f6' },
};
const LEVEL_DOT = { alert: '#dc2626', warning: '#b45309', info: '#1e40af' };

// ─── 年間計画アラート取得 ────────────────────────────────────────────────
async function fetchAnnualAlerts() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth(); // 0-indexed
  const monthEnd = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10); // exclusive
  const soonStr  = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10);

  const { plans } = await api.get('/api/plans?annual_only=1');
  const overdue = [], thisMonth = [], approaching = [];

  for (const p of plans || []) {
    if (p.status === 'done') continue;
    const d = (p.planned_date || '').slice(0, 10);
    if (!d) continue;
    if (d < todayStr) {
      overdue.push(p);
    } else if (d < monthEnd) {
      thisMonth.push(p);
    } else if (d <= soonStr) {
      approaching.push(p);
    }
  }
  const byDate = (a, b) => a.planned_date.localeCompare(b.planned_date);
  overdue.sort(byDate);
  thisMonth.sort(byDate);
  approaching.sort(byDate);
  return { overdue, thisMonth, approaching };
}

// ─── チャット未読ステータス取得 ──────────────────────────────────────────
function fetchChatStatus() {
  return api.get('/api/chat?count_unread=1&channel=general')
    .catch(() => ({ unread_count: 0, readers: 0, total_users: 0 }));
}

// ─── 通知バッジ更新（ベル・タイル共通） ──────────────────────────────────
function updateNotifBadges(unread) {
  const bell = document.getElementById('notif-bell');
  if (bell) bell.hidden = unread === 0;
  const text = unread > 99 ? '99+' : String(unread);
  for (const id of ['notif-bell-badge', 'tile-notif-badge']) {
    const b = document.getElementById(id);
    if (!b) continue;
    if (unread > 0) { b.textContent = text; b.hidden = false; } else b.hidden = true;
  }
}

// ─── 保全計画行 ──────────────────────────────────────────────────────────
function planRow(p, over) {
  const t = TYPE_BADGE[p.plan_type] || TYPE_BADGE.other;
  const eq = [p.line_name, p.equipment_name].filter(Boolean).join(' ');
  return el('a', { class: 'plan-sum-item', href: `/pages/plan?id=${p.id}` }, [
    el('span', { class: 'plan-sum-date' + (over ? ' is-over' : '') }, formatDate(p.planned_date)),
    el('span', { class: 'plan-sum-badge', style: `background:${t.bg};color:${t.color}` }, t.label),
    el('span', { class: 'plan-sum-title' }, p.title + (eq ? `（${eq}）` : '')),
  ]);
}

// ─── タブコンテンツ: 期限超過 / 直近 ────────────────────────────────────
function planTabContent(list, over, emptyMsg) {
  if (!list || list.length === 0) return el('p', { class: 'home-tab-empty' }, emptyMsg);
  return el('div', {}, [
    ...list.slice(0, 8).map((p) => planRow(p, over)),
    list.length > 8 ? el('p', { class: 'hint', style: 'margin:4px 0' }, `…ほか ${list.length - 8} 件`) : null,
    el('a', { class: 'home-activity-more', style: 'display:inline-block;margin-top:8px', href: '/pages/plan' }, 'カレンダーで見る ›'),
  ]);
}

// ─── タブコンテンツ: 年間計画 ────────────────────────────────────────────
function annualTabContent({ overdue, thisMonth, approaching }) {
  const total = overdue.length + thisMonth.length + approaching.length;
  if (total === 0) return el('p', { class: 'home-tab-empty' }, '今月・直近の未完了年間計画はありません。');

  const sections = [];
  const addSection = (list, label, over) => {
    if (!list.length) return;
    sections.push(el('div', {
      class: 'plan-sum-head' + (over ? ' is-over' : ''),
      style: sections.length ? 'margin-top:10px' : '',
    }, label));
    list.slice(0, 5).forEach((p) => sections.push(planRow(p, over)));
    if (list.length > 5) sections.push(el('p', { class: 'hint', style: 'margin:2px 0' }, `…ほか ${list.length - 5} 件`));
  };

  addSection(overdue,     `⚠ 期限超過 ${overdue.length}件`,       true);
  addSection(thisMonth,   `📅 今月の未完了 ${thisMonth.length}件`,  false);
  addSection(approaching, `⏰ 直近2週間 ${approaching.length}件`,   false);
  sections.push(el('a', {
    class: 'home-activity-more', style: 'display:inline-block;margin-top:8px',
    href: '/pages/plan-annual',
  }, '年間計画表を見る ›'));
  return el('div', {}, sections);
}

// ─── 通知1行（確認ボタン付き） ──────────────────────────────────────────
function notifRow(n, reload) {
  const isAck = !!n.acknowledged_at;
  const dot = el('span', { class: 'home-activity-dot', style: `background:${LEVEL_DOT[n.level] || LEVEL_DOT.info}` });
  const text = el('span', { class: 'home-activity-text' }, n.title);
  const time = el('span', { class: 'home-activity-time' }, formatDateTime(n.created_at));

  let ackBtn = null;
  if (!isAck) {
    ackBtn = el('button', {
      class: 'btn btn-sm',
      style: 'font-size:11px;padding:1px 6px;flex-shrink:0',
      onclick: async (e) => {
        e.preventDefault(); e.stopPropagation();
        ackBtn.disabled = true;
        try { await api.post(`/api/notifications/${n.id}`); if (reload) reload(); }
        catch { ackBtn.disabled = false; }
      },
    }, '確認');
  }

  const inner = [dot, text, time, ackBtn].filter(Boolean);
  if (n.link_url) {
    return el('a', { class: 'home-activity-item' + (isAck ? '' : ' is-unack'), href: n.link_url }, inner);
  }
  return el('div', { class: 'home-activity-item' + (isAck ? '' : ' is-unack') }, inner);
}

// ─── タブコンテンツ: 通知（チャット未読 ＋ 通知一覧） ───────────────────
function activityTabContent(notifications, chatStatus, notifUnread) {
  const children = [];

  // チャット未読セクション
  if (chatStatus && chatStatus.unread_count > 0) {
    const { unread_count, readers, total_users } = chatStatus;
    const readPart = total_users > 0
      ? el('span', { style: 'font-size:11px;color:#64748b;margin-left:4px' },
          `（${total_users}人中${readers}人既読）`)
      : null;
    children.push(el('div', { class: 'home-chat-notice' }, [
      el('span', {}, `💬 チャット ${unread_count}件未読`),
      readPart,
      el('a', { href: '/pages/chat', style: 'margin-left:auto;font-size:12px' }, 'チャットを開く ›'),
    ]));
  }

  // 通知一覧（確認ボタン付き）
  if (!notifications || notifications.length === 0) {
    if (!chatStatus?.unread_count) {
      children.push(el('p', { class: 'home-tab-empty' }, '最近の動きはありません。'));
    }
    return el('div', {}, children.filter(Boolean));
  }

  const notifBox = el('div', {});
  const reload = async () => {
    try {
      const { notifications: nn, unread_count } = await api.get('/api/notifications?limit=8');
      updateNotifBadges(unread_count || 0);
      render(notifBox, (nn || []).map((n) => notifRow(n, reload)));
    } catch { /* 無視 */ }
  };
  render(notifBox, notifications.map((n) => notifRow(n, reload)));

  // 「すべて確認」ボタン（未読があるとき）
  let ackAllBtn = null;
  if (notifUnread > 0) {
    ackAllBtn = el('button', {
      class: 'btn btn-sm',
      style: 'margin-top:8px',
      onclick: async () => {
        if (!confirm('未確認の通知をすべて確認済みにしますか？')) return;
        ackAllBtn.disabled = true;
        try {
          await api.post('/api/notifications/ack-all', {});
          await reload();
        } catch (err) {
          alert(err.message);
          ackAllBtn.disabled = false;
        }
      },
    }, 'すべて確認');
  }

  children.push(notifBox);
  if (ackAllBtn) children.push(ackAllBtn);
  children.push(el('a', {
    class: 'home-activity-more', style: 'display:inline-block;margin-top:8px',
    href: '/pages/notifications',
  }, '通知センターを開く ›'));

  return el('div', {}, children.filter(Boolean));
}

// ─── メイン: ホームタブを描画 ────────────────────────────────────────────
export async function loadHomeTabs(container) {
  let overdue = [], upcoming = [], notifications = [], notifUnread = 0;
  let annualAlerts = { overdue: [], thisMonth: [], approaching: [] };
  let chatStatus = { unread_count: 0, readers: 0, total_users: 0 };

  try {
    const [status, notif, annual, chat] = await Promise.all([
      fetchPlanStatus(7).catch(() => ({ overdue: [], upcoming: [] })),
      api.get('/api/notifications?limit=8').catch(() => ({ notifications: [], unread_count: 0 })),
      fetchAnnualAlerts().catch(() => ({ overdue: [], thisMonth: [], approaching: [] })),
      fetchChatStatus(),
    ]);
    overdue       = status.overdue || [];
    upcoming      = status.upcoming || [];
    notifications = notif.notifications || [];
    notifUnread   = notif.unread_count || 0;
    annualAlerts  = annual;
    chatStatus    = chat;
  } catch { /* 失敗時は空のまま */ }

  updateNotifBadges(notifUnread);

  const annualCount   = annualAlerts.overdue.length + annualAlerts.thisMonth.length + annualAlerts.approaching.length;
  const activityCount = notifUnread + (chatStatus.unread_count > 0 ? chatStatus.unread_count : 0);

  if (!overdue.length && !upcoming.length && !annualCount && !activityCount && !notifications.length) {
    render(container, []);
    return;
  }

  const tabs = [
    {
      key: 'overdue', label: '期限超過', count: overdue.length, over: true,
      content: () => planTabContent(overdue, true, '期限超過の予定はありません。'),
    },
    {
      key: 'upcoming', label: '直近', count: upcoming.length,
      content: () => planTabContent(upcoming, false, '直近7日の予定はありません。'),
    },
    {
      key: 'annual', label: '年間計画', count: annualCount,
      content: () => annualTabContent(annualAlerts),
    },
    {
      key: 'activity', label: '通知', count: activityCount,
      content: () => activityTabContent(notifications, chatStatus, notifUnread),
    },
  ];

  // 期限超過 → 年間計画（超過あり） → 直近 → 通知の順で優先タブを決定
  let active = 'activity';
  if (upcoming.length) active = 'upcoming';
  if (annualAlerts.overdue.length || annualAlerts.thisMonth.length) active = 'annual';
  if (overdue.length) active = 'overdue';

  const bar  = el('div', { class: 'home-tabs-bar', role: 'tablist' });
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
