// 入力フォームの「下書き自動保存」と「未保存離脱警告」の共通モジュール
//
//   createDraft(key, collect)
//     - touch(): 入力のたびに呼ぶと、少し待ってから collect() の結果を localStorage に保存
//     - banner(onRestore): 前回の下書きがあれば「復元 / 破棄」バナー要素を返す（無ければ null）
//     - clear(): 保存成功時などに下書きを消す
//     ※ 写真・動画（Fileオブジェクト）は保存できないため対象外（テキスト入力のみ守る）
//
//   installUnsavedGuard()
//     - 実際のユーザー入力（isTrusted）があったら dirty にし、ページ離脱時に
//       ブラウザ標準の「変更が保存されない可能性があります」警告を出す
//     - clear(): 保存成功・明示的なキャンセル時に呼んで警告を解除する

import { el } from '/js/util.js';

const app = () => document.getElementById('app');

export function createDraft(key, collect) {
  const storageKey = `draft:${key}`;
  let timer = null;

  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), data: collect() }));
    } catch { /* 容量超過・プライベートモード等では保存を諦める（本保存には影響しない） */ }
  };

  return {
    // 入力イベントごとに呼ぶ。連打を避けるため800ms待ってから保存
    touch() {
      clearTimeout(timer);
      timer = setTimeout(save, 800);
    },
    load() {
      try {
        const v = JSON.parse(localStorage.getItem(storageKey) || 'null');
        return v && v.data ? v : null;
      } catch { return null; }
    },
    clear() {
      clearTimeout(timer);
      timer = null;
      try { localStorage.removeItem(storageKey); } catch { /* 消せなくても実害なし */ }
    },
    // 下書きがあれば復元バナーを返す。復元ボタンで onRestore(data) を呼ぶ
    banner(onRestore) {
      const saved = this.load();
      if (!saved) return null;
      const when = new Date(saved.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const box = el('div', { class: 'notice is-warning', style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
        el('span', { style: 'flex:1;min-width:180px' }, `📝 入力途中の下書きがあります（${when}）`),
        el('button', { class: 'btn btn-sm btn-primary', onclick: () => { box.remove(); onRestore(saved.data); } }, '復元する'),
        el('button', { class: 'btn btn-sm', onclick: () => { this.clear(); box.remove(); } }, '破棄'),
      ]);
      return box;
    },
  };
}

export function installUnsavedGuard() {
  let dirty = false;
  const root = app() || document.body;
  const markDirty = (e) => { if (e.isTrusted) dirty = true; };
  root.addEventListener('input', markDirty);
  root.addEventListener('change', markDirty);
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  return {
    clear() { dirty = false; },
  };
}

// オフライン起因の保存失敗かを判定し、現場向けの案内文を返す（それ以外は元のメッセージ）
export function saveErrorMessage(err) {
  const offline = err?.offline === true || navigator.onLine === false;
  if (offline) {
    return 'オフラインのため保存できませんでした。\n入力内容はこの画面に残っています。電波の届く場所で、もう一度「保存」を押してください。';
  }
  return err?.message || String(err);
}
