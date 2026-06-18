// 通知センター（最近の動き・アラート）
//   トピック別（部品/点検/トラブル）にフィルタし、各通知を確認（チーム共有）できる。
//   既読はチーム共有方式: 誰か1人が「確認」すると全員の未読数が減る。

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';

const app = document.getElementById('app');
let currentUser = null;

// トピック（type）とラベル
const TOPICS = [
  { key: '',                      label: '全部' },
  { key: 'parts_zero,parts_low,parts_restock', label: '📦 部品' }, // 在庫切れ・発注アラート・入庫
  { key: 'inspection_abnormal',   label: '✅ 点検' },
  { key: 'trouble',               label: '⚠️ トラブル' },
];

// レベルごとの色とラベル
const LEVEL_STYLE = {
  alert:   { bg: 'var(--color-danger-bg)',  color: 'var(--color-danger)',  label: 'アラート', dot: '#dc2626' },
  warning: { bg: 'var(--color-warning-bg)', color: 'var(--color-warning)', label: '警告',     dot: '#b45309' },
  info:    { bg: '#eff6ff',                  color: '#1e40af',              label: 'お知らせ', dot: '#1e40af' },
};

let currentType = '';     // トピック絞り込み
let unreadOnly = false;   // 未確認のみ表示

// ---------------- 1件の通知カード ----------------

function notificationCard(n, reload) {
  const lv = LEVEL_STYLE[n.level] || LEVEL_STYLE.info;
  const isAck = !!n.acknowledged_at;

  const headTag = n.link_url ? 'a' : 'div';
  const headAttrs = n.link_url ? { class: 'notif-main', href: n.link_url } : { class: 'notif-main' };
  const main = el(headTag, headAttrs, [
    el('div', { class: 'notif-head' }, [
      el('span', { class: 'notif-level', style: `background:${lv.bg};color:${lv.color}` }, lv.label),
      el('span', { class: 'notif-title' }, n.title),
    ]),
    n.body ? el('div', { class: 'notif-body' }, n.body) : null,
    el('div', { class: 'notif-time' }, formatDateTime(n.created_at)),
  ]);

  let footer;
  if (isAck) {
    footer = el('div', { class: 'notif-ack is-done' },
      `✓ 確認済み（${maskEmail(n.acknowledged_by) || '—'}・${formatDateTime(n.acknowledged_at)}）`);
  } else if (hasRole(currentUser, 'editor')) {
    const btn = el('button', { class: 'btn btn-sm' }, '確認');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        await api.post(`/api/notifications/${n.id}`);
        await reload();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
    footer = el('div', { class: 'notif-ack' }, [btn]);
  } else {
    footer = el('div', { class: 'notif-ack' }, el('span', { class: 'list-item-sub' }, '未確認'));
  }

  return el('div', { class: `notif-card ${isAck ? 'is-ack' : 'is-unack'}` }, [main, footer]);
}

// ---------------- 一覧読み込み ----------------

async function load(ctx) {
  const { listBox, summaryBox } = ctx;
  render(listBox, el('p', { class: 'loading' }, '読み込み中…'));

  const sp = new URLSearchParams();
  if (currentType) sp.set('type', currentType);
  if (unreadOnly) sp.set('status', 'unread');

  let data;
  try {
    data = await api.get(`/api/notifications?${sp}`);
  } catch (err) {
    render(listBox, el('p', { class: 'notice is-error' }, err.message || String(err)));
    return;
  }

  const { notifications, unread_count } = data;
  render(summaryBox, el('p', { class: 'notif-summary' },
    unread_count > 0 ? `未確認の通知が ${unread_count} 件あります` : '未確認の通知はありません'));

  if (!notifications || notifications.length === 0) {
    render(listBox, el('p', { class: 'empty', style: 'text-align:center;margin-top:32px' },
      unreadOnly ? '未確認の通知はありません。' : '通知はまだありません。'));
    return;
  }

  const reload = () => load(ctx);
  render(listBox, notifications.map((n) => notificationCard(n, reload)));
}

// ---------------- 画面構築 ----------------

async function renderPage() {
  const summaryBox = el('div', {});
  const listBox = el('div', { class: 'notif-list' });
  const ctx = { summaryBox, listBox };

  // トピックチップ
  const chipRow = el('div', { class: 'filter-bar chip-row' }, TOPICS.map((t) => {
    const b = el('button', { class: 'chip' + (t.key === currentType ? ' is-active' : '') }, t.label);
    b.addEventListener('click', () => {
      currentType = t.key;
      [...chipRow.children].forEach((c, i) => c.classList.toggle('is-active', TOPICS[i].key === currentType));
      load(ctx);
    });
    return b;
  }));

  // 未確認のみトグル
  const statusToggle = el('button', { class: 'btn btn-sm' }, '未確認のみ');
  statusToggle.addEventListener('click', () => {
    unreadOnly = !unreadOnly;
    statusToggle.classList.toggle('is-active', unreadOnly);
    statusToggle.textContent = unreadOnly ? '☑ 未確認のみ' : '未確認のみ';
    load(ctx);
  });

  // すべて確認（editor 以上）
  const actions = [statusToggle];
  if (hasRole(currentUser, 'editor')) {
    const ackAllBtn = el('button', { class: 'btn btn-sm' }, 'すべて確認');
    ackAllBtn.addEventListener('click', async () => {
      const msg = currentType
        ? 'このトピックの未確認をすべて確認済みにしますか？'
        : '未確認の通知をすべて確認済みにしますか？';
      if (!confirm(msg)) return;
      ackAllBtn.disabled = true;
      try {
        await api.post('/api/notifications/ack-all', currentType ? { type: currentType } : {});
        await load(ctx);
      } catch (err) {
        alert(err.message);
      } finally {
        ackAllBtn.disabled = false;
      }
    });
    actions.push(ackAllBtn);
  }

  render(app, [
    summaryBox,
    chipRow,
    el('div', { class: 'action-row' }, actions),
    listBox,
  ]);

  // 通知センターを開いたら未確認をまとめて確認済みにする（閲覧＝確認。
  // チーム共有方式なので全員の未読バッジが消える）。viewer は確認権限が無いので対象外。
  if (hasRole(currentUser, 'editor')) {
    try { await api.post('/api/notifications/ack-all', {}); }
    catch { /* 確認に失敗しても一覧表示は続行する */ }
  }

  await load(ctx);
}

// ---------------- 起動 ----------------

(async () => {
  try {
    currentUser = await getCurrentUser();
    await renderPage();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
