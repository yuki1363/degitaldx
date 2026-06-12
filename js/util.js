// 画面共通ユーティリティ（日時の JST 表示・DOM 生成ヘルパー）
//   保存される日時は UTC の ISO 8601。表示はすべて JST に変換する（CLAUDE.md）。

const JST_DATETIME = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const JST_DATE = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

/** ISO日時 → 'YYYY/MM/DD HH:mm'（JST） */
export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return JST_DATETIME.format(d);
}

/** ISO日時 or 'YYYY-MM-DD' → 'YYYY/MM/DD'（JST） */
export function formatDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll('-', '/');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return JST_DATE.format(d);
}

/** 現在時刻を <input type="datetime-local"> 用の値にする */
export function nowLocalInputValue() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** ISO日時（UTC）→ datetime-local 用の値（端末ローカル時刻） */
export function isoToLocalInputValue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** datetime-local の値（端末ローカル時刻）→ ISO日時（UTC） */
export function localInputToIso(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** バイト数 → 表示用文字列 */
export function formatBytes(bytes) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/**
 * DOM 生成ヘルパー（textContent ベースなので XSS 安全）。
 *   el('button', { class: 'btn', onclick: fn }, 'ラベル')
 *   el('div', { class: 'card' }, [child1, child2, '文字列'])
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (key === 'value') {
      node.value = value;
    } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'multiple') {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  const append = (child) => {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(append);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  };
  append(children);
  return node;
}

/** コンテナを空にして子要素を入れ替える */
export function render(container, children) {
  container.replaceChildren();
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child) container.appendChild(child);
  }
}

/** audit_log の action 表示名 */
export const ACTION_LABELS = {
  create: '登録',
  update: '変更',
  delete: '削除',
  restore: '復元',
};
