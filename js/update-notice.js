// 更新のお知らせ（js/updates.js の内容）
//   ・新しい版が出たあとの最初のホーム表示で、画面の真ん中にダイアログ（ウィンドウ）で出す。
//     読んで「確認した」を押すと閉じて、次回からは出ない（端末ごと＝localStorage）。「あとで」は今回だけ閉じる。
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

/**
 * 更新のお知らせをダイアログ（画面の真ん中のウィンドウ）で出す。
 *   「確認した」＝確認済みにして閉じる（次回からは出ない）／「あとで」＝今回だけ閉じる（次に開いたときまた出る）。
 *   背景のタップ・Esc は「あとで」と同じ。何も出すものが無ければ何もしない。
 */
export function showUpdateDialog() {
  const list = pendingUpdates();
  if (list.length === 0 || document.getElementById('update-dialog')) return;

  const backdrop = el('div', { class: 'modal-backdrop', id: 'update-dialog' });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);

  backdrop.appendChild(el('div', { class: 'modal update-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'update-dialog-title' }, [
    el('h3', { class: 'modal-title', id: 'update-dialog-title' }, '🆕 アプリが更新されました'),
    el('div', { class: 'modal-body update-dialog-body' }, list.map((u) => entryNode(u))),
    el('div', { class: 'modal-actions' }, [
      el('a', { class: 'btn', href: '/pages/updates', id: 'update-history-link' }, 'これまでの更新履歴'),
      el('button', { class: 'btn', type: 'button', id: 'update-later', onclick: close }, 'あとで'),
      el('button', { class: 'btn btn-primary', type: 'button', id: 'update-notice-ok',
        onclick: () => { writeSeen(LATEST_VERSION); close(); } }, '確認した'),
    ]),
  ]));
  document.body.appendChild(backdrop);
  backdrop.querySelector('#update-notice-ok').focus();
}
