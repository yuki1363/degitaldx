// ホーム概要タブ（期限超過 / 直近 / 通知）
//   「期限超過」: カレンダー超過 ＋ 年間計画の超過分
//   「直近」    : カレンダー7日以内 ＋ 年間計画の今月末までの未完了（超過しそう）
//   「通知」    : チャット未読（ユーザー別既読数付き）＋ システム通知

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

// ─── 年間計画: 期限超過 ＋ 今月末までの未完了（超過しそう）────────────
//   年間計画のタスクは各月「1日」の日付で登録される（月単位の管理）。
//   日単位で比較すると月の2日以降に当月分が「超過」になってしまうため、
//   判定は年月（YYYY-MM）単位で行う: 予定月が過ぎたら超過、当月中は「今月末までにやる」。
async function fetchAnnualAlerts() {
  // JSTの今日を基準にする（toISOStringはUTCのため朝9時まで前日扱いになる）
  const curYm = new Date().toLocaleDateString('sv-SE').slice(0, 7); // 例: '2026-07'

  const { plans } = await api.get('/api/plans?annual_only=1');
  const overdue = [], thisMonth = [];

  for (const p of plans || []) {
    if (p.status === 'done') continue;
    if (p.unscheduled) continue;          // 未定は表示しない
    const ym = (p.planned_date || '').slice(0, 7);
    if (!ym) continue;
    if (ym < curYm) {
      overdue.push(p);                    // 予定月が終わっても未完了 = 超過
    } else if (ym === curYm) {
      thisMonth.push(p);                  // 今月分 = 月末までにやる（超過ではない）
    }
  }
  const byDate = (a, b) => a.planned_date.localeCompare(b.planned_date);
  overdue.sort(byDate);
  thisMonth.sort(byDate);
  return { overdue, thisMonth };
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

// 1件だけ表示して保全計画ページへ誘導するセクション
function planSection(list, over, label) {
  if (!list.length) return null;
  const total = list.length;
  return el('div', { style: 'margin-bottom:6px' }, [
    el('div', { class: 'plan-sum-head' + (over ? ' is-over' : '') }, label),
    planRow(list[0], over),
    total > 1
      ? el('a', {
          class: 'home-activity-more',
          style: 'display:inline-block;margin-top:4px',
          href: '/pages/plan',
        }, `他 ${total - 1} 件 — 保全計画で確認 ›`)
      : el('a', {
          class: 'home-activity-more',
          style: 'display:inline-block;margin-top:4px',
          href: '/pages/plan',
        }, '保全計画で確認 ›'),
  ]);
}

// ─── タブコンテンツ: 期限超過（カレンダー ＋ 年間計画超過分） ────────────
function overdueTabContent(calOverdue, annualOverdue) {
  if (!calOverdue.length && !annualOverdue.length) {
    return el('p', { class: 'home-tab-empty' }, '期限超過の予定はありません。');
  }
  return el('div', {}, [
    planSection(calOverdue,   true,  '📅 カレンダー予定'),
    planSection(annualOverdue, true, '⚠ 年間計画 期限超過'),
  ].filter(Boolean));
}

// ─── タブコンテンツ: 直近（カレンダー7日 ＋ 年間計画の今月末まで） ────────
function upcomingTabContent(calUpcoming, annualThisMonth) {
  if (!calUpcoming.length && !annualThisMonth.length) {
    return el('p', { class: 'home-tab-empty' }, '直近の予定はありません。');
  }
  return el('div', {}, [
    planSection(calUpcoming,    false, '📅 カレンダー予定（7日以内）'),
    planSection(annualThisMonth, false, '⏰ 年間計画 今月末までの未完了'),
  ].filter(Boolean));
}

// ─── 通知1行（確認ボタン付き） ──────────────────────────────────────────
function notifRow(n, reload) {
  const isAck = !!n.acknowledged_at;
  const dot  = el('span', { class: 'home-activity-dot', style: `background:${LEVEL_DOT[n.level] || LEVEL_DOT.info}` });
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
  let annualAlerts = { overdue: [], thisMonth: [] };
  let chatStatus = { unread_count: 0, readers: 0, total_users: 0 };

  try {
    const [status, notif, annual, chat] = await Promise.all([
      fetchPlanStatus(7).catch(() => ({ overdue: [], upcoming: [] })),
      api.get('/api/notifications?limit=8').catch(() => ({ notifications: [], unread_count: 0 })),
      fetchAnnualAlerts().catch(() => ({ overdue: [], thisMonth: [] })),
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

  const overdueCount  = overdue.length + annualAlerts.overdue.length;
  const upcomingCount = upcoming.length + annualAlerts.thisMonth.length;
  const activityCount = notifUnread + (chatStatus.unread_count || 0);

  if (!overdueCount && !upcomingCount && !activityCount && !notifications.length) {
    render(container, []);
    return;
  }

  const tabs = [
    {
      key: 'overdue', label: '期限超過', count: overdueCount, over: true,
      content: () => overdueTabContent(overdue, annualAlerts.overdue),
    },
    {
      key: 'upcoming', label: '直近', count: upcomingCount,
      content: () => upcomingTabContent(upcoming, annualAlerts.thisMonth),
    },
    {
      key: 'activity', label: '通知', count: activityCount,
      content: () => activityTabContent(notifications, chatStatus, notifUnread),
    },
  ];

  // 期限超過 → 直近 → 通知 の順で優先タブを決定
  let active = 'activity';
  if (upcomingCount) active = 'upcoming';
  if (overdueCount)  active = 'overdue';

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
