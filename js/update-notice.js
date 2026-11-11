// 更新のお知らせ（js/updates.js の内容）
//   ・新しい版が出たあとの最初のホーム表示で、ホームの上のタブ（期限超過・直近・通知）に「🆕 更新」タブが出る。
//     中を読んで「確認した」を押すとタブごと消える（端末ごと＝localStorage）。js/home-tabs.js が使う。
//   ・過去の更新は、ホームのタイル「🆕 更新履歴」（/pages/updates）でいつでも見られる。
//   ・localStorage が使えない環境（プライベートモード等）でも、表示はできる（毎回出る）。
import { el } from '/js/util.js';
import { UPDATES, LATEST_VERSION } from '/js/updates.js';

const SEEN_KEY = 'updates:seen';
const MAX_UNSEEN = 3;   // 何版もまとめて見逃していても、出すのは新しい3件まで

const readSeen = () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } };
const writeSeen = (v) => { try { localStorage.setItem(SEEN_KEY, v); } catch { /* 保存できなくても閉じられる */ } };

const dateText = (d) => d.replace(/-/g, '/');

/** 1件の更新（見出し・版・日付・変更点の一覧） */
export function entryNode(u) {
  return el('div', { class: 'update-entry' }, [
    el('div', {}, [
      el('span', { class: 'update-entry-title' }, u.title),
      el('span', { class: 'update-entry-date' }, `v${u.version}・${dateText(u.date)}`),
    ]),
    el('ul', {}, u.items.map((t) => el('li', {}, t))),
  ]);
}

/** 未確認の更新（新しい順）。初めて使う端末（記録なし）は最新の1件だけ */
export function unseenUpdates(seen) {
  if (!seen) return UPDATES.slice(0, 1);
  const idx = UPDATES.findIndex((u) => u.version === seen);
  const list = idx === -1 ? UPDATES.slice(0, 1) : UPDATES.slice(0, idx);
  return list.slice(0, MAX_UNSEEN);
}

/** いま見せるべき更新（確認済みなら空） */
export function pendingUpdates() {
  const seen = readSeen();
  return seen === LATEST_VERSION ? [] : unseenUpdates(seen);
}

/** 「🆕 更新」タブの中身。「確認した」で onConfirm が呼ばれる（タブを消すのは呼び出し側） */
export function updatesTabContent(list, onConfirm) {
  return el('div', { class: 'update-notice', id: 'update-tab-card' }, [
    ...list.map((u) => entryNode(u)),
    el('div', { class: 'action-row', style: 'margin-top:8px' }, [
      el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'update-notice-ok',
        onclick: () => { writeSeen(LATEST_VERSION); onConfirm(); } }, '確認した'),
      el('a', { class: 'btn btn-sm', href: '/pages/updates' }, 'これまでの更新履歴'),
    ]),
  ]);
}
