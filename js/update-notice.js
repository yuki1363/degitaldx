// ホームの「更新のお知らせ」（js/updates.js の内容を表示する）
//   ・新しい版が出たあとの最初の表示で、上に「🆕 更新しました」カードを出す。「確認した」で閉じる（端末ごと）。
//   ・過去の更新は、ホーム下の「更新履歴」からいつでも見られる。
//   ・localStorage が使えない環境（プライベートモード等）でも、表示はできる（毎回出る）。
import { el, render } from '/js/util.js';
import { UPDATES, LATEST_VERSION } from '/js/updates.js';

const SEEN_KEY = 'updates:seen';
const MAX_UNSEEN = 3;   // 何版もまとめて見逃していても、出すのは新しい3件まで

const readSeen = () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } };
const writeSeen = (v) => { try { localStorage.setItem(SEEN_KEY, v); } catch { /* 保存できなくても閉じられる */ } };

const dateText = (d) => d.replace(/-/g, '/');

function entryNode(u, { titleTag = 'div' } = {}) {
  return el('div', { class: 'update-entry' }, [
    el(titleTag, {}, [
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

/** noticeBox にお知らせカード、historyBox に更新履歴を描く */
export function showUpdateNotice(noticeBox, historyBox) {
  const unseen = readSeen() === LATEST_VERSION ? [] : unseenUpdates(readSeen());
  if (unseen.length > 0) {
    render(noticeBox, el('section', { class: 'update-notice', id: 'update-notice-card', 'aria-label': '更新のお知らせ' }, [
      el('h2', {}, '🆕 更新しました'),
      ...unseen.map((u) => entryNode(u)),
      el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'update-notice-ok',
        onclick: () => { writeSeen(LATEST_VERSION); render(noticeBox, []); } }, '確認した'),
    ]));
  } else {
    render(noticeBox, []);
  }
  render(historyBox, el('details', { class: 'update-history', id: 'update-history' }, [
    el('summary', {}, '🆕 更新履歴'),
    ...UPDATES.map((u) => entryNode(u)),
  ]));
}
