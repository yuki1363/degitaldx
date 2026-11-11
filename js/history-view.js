// 変更履歴の表示（詳細画面の「変更履歴」カード共通）。
//   これまで各画面が同じ3つ（操作・操作者・日時）だけを出していたため、「誰かが変えたが何を変えたか分からない」
//   状態だった。ここで共通化し、変更があった履歴には「状態・担当者を変更」のような要約と、
//   タップで開く「項目：前 → 後」の一覧を出す。差分の解釈は js/history-diff.js（純粋関数）。
import { el, formatDateTime, ACTION_LABELS, maskEmail } from '/js/util.js';
import { parseHistoryChanges, summarizeChanges } from '/js/history-diff.js';

/** 履歴1件ぶんの表示（操作・操作者・日時＋変更内容） */
export function buildHistoryItem(h) {
  const head = el('div', { class: 'history-row' }, [
    el('span', { class: `action-badge is-${h.action}` }, ACTION_LABELS[h.action] || h.action),
    el('span', {}, maskEmail(h.changed_by)),
    el('span', { class: 'list-item-sub' }, formatDateTime(h.changed_at)),
  ]);
  const changes = parseHistoryChanges(h.diff_json, h.action);
  if (changes.length === 0) return el('div', { class: 'history-item' }, [head]);

  const lines = changes.map((c) => el('li', {}, [
    el('span', { class: 'history-diff-label' }, c.label),
    c.opaque
      ? el('span', { class: 'history-diff-val' }, '変更あり')
      : c.added
        ? el('span', { class: 'history-diff-val' }, c.to)
        : el('span', { class: 'history-diff-val' }, [
            el('span', { class: 'history-from' }, c.from),
            el('span', { class: 'history-arrow' }, ' → '),
            el('span', { class: 'history-to' }, c.to),
          ]),
  ]));
  return el('div', { class: 'history-item' }, [
    head,
    el('details', { class: 'history-diff' }, [
      el('summary', {}, summarizeChanges(changes)),
      el('ul', { class: 'history-diff-list' }, lines),
    ]),
  ]);
}

/** 履歴の一覧（空のときは「履歴はありません。」） */
export function buildHistoryList(history) {
  if (!history || history.length === 0) return el('p', { class: 'empty' }, '履歴はありません。');
  return el('div', { class: 'row-list' }, history.map(buildHistoryItem));
}
