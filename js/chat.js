// 10 チャット — グループチャット（シフト引き継ぎ・一斉連絡）
//   30秒ポーリングで新着メッセージを自動取得

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';

const chatList = document.getElementById('chat-list');
const chatForm = document.getElementById('chat-form');

let currentUser = null;
let lastTimestamp = null;
let pollTimer = null;

// 個人情報パターン検出
const PI_PATTERNS = [
  /\d{2,4}-\d{2,4}-\d{4}/,
  /0\d{9,10}/,
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
  /〒?\d{3}-\d{4}/,
];
function detectPersonalInfo(text) {
  return PI_PATTERNS.some((p) => p.test(text));
}

// メッセージをDOMに追加（最下部へ）
function appendMessages(messages) {
  if (messages.length === 0) return;
  const atBottom = chatList.scrollHeight - chatList.scrollTop <= chatList.clientHeight + 60;

  for (const msg of messages) {
    const isMine = msg.created_by === currentUser.email;
    const isAdmin = currentUser.role === 'admin';
    const row = el('div', { class: `chat-msg ${isMine ? 'is-mine' : ''}` }, [
      el('div', { class: 'chat-meta' }, [
        el('span', { class: 'chat-author' }, msg.author_name || maskEmail(msg.created_by)),
        el('span', { class: 'chat-time' }, formatDateTime(msg.created_at)),
        (isMine || isAdmin) ? el('button', {
          class: 'btn-icon',
          title: '削除',
          onclick: async () => {
            if (!confirm('このメッセージを削除しますか？')) return;
            await api.del(`/api/chat/${msg.id}`);
            row.remove();
          },
        }, '✕') : null,
      ]),
      el('div', { class: 'chat-body', style: 'white-space:pre-wrap' }, msg.body),
    ]);
    chatList.appendChild(row);
    if (msg.created_at > (lastTimestamp || '')) lastTimestamp = msg.created_at;
  }

  if (atBottom) chatList.scrollTop = chatList.scrollHeight;
}

// 初回ロード
async function loadInitial() {
  render(chatList, el('p', { class: 'loading' }, '読み込み中…'));
  const { messages } = await api.get('/api/chat?limit=50');
  chatList.innerHTML = '';
  if (messages.length === 0) {
    chatList.appendChild(el('p', { class: 'empty', style: 'text-align:center;margin-top:40px' }, 'メッセージはありません。最初のメッセージを送ってみましょう！'));
  } else {
    appendMessages(messages);
    chatList.scrollTop = chatList.scrollHeight;
  }
}

// ポーリング（30秒ごとに新着取得）
async function poll() {
  try {
    if (!lastTimestamp) return;
    const { messages } = await api.get(`/api/chat?since=${encodeURIComponent(lastTimestamp)}`);
    if (messages.length > 0) appendMessages(messages);
  } catch { /* オフライン時は無視 */ }
}

// フォーム描画
function renderForm() {
  if (!hasRole(currentUser, 'editor')) {
    render(chatForm, el('p', { class: 'hint', style: 'text-align:center' }, '閲覧のみ権限ではメッセージを送信できません。'));
    return;
  }

  const textarea = el('textarea', {
    placeholder: '氏名・電話番号・住所等の個人情報は入力しないでください',
    rows: 2,
    style: 'resize:none;flex:1',
    onkeydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    },
  });

  const sendBtn = el('button', { class: 'btn btn-primary', style: 'align-self:flex-end', onclick: () => send() }, '送信');

  const send = async () => {
    const body = textarea.value.trim();
    if (!body) return;
    if (detectPersonalInfo(body)) {
      if (!confirm('電話番号・メールアドレス・郵便番号などの個人情報が含まれている可能性があります。このまま送信しますか？')) return;
    }
    sendBtn.disabled = true;
    try {
      await api.post('/api/chat', { body });
      textarea.value = '';
      // 即時ポーリングで新着取得
      await poll();
    } catch (err) {
      alert(err.message);
    } finally {
      sendBtn.disabled = false;
      textarea.focus();
    }
  };

  render(chatForm, el('div', { class: 'chat-input-row' }, [
    textarea,
    sendBtn,
  ]));
  textarea.focus();
}

// ---------------- 起動 ----------------

(async () => {
  try {
    currentUser = await getCurrentUser();
    await loadInitial();
    renderForm();
    pollTimer = setInterval(poll, 30000);
    // ページ離脱時にポーリング停止
    window.addEventListener('pagehide', () => clearInterval(pollTimer));
  } catch (err) {
    render(chatList, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
