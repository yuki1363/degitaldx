// 10 チャット — グループチャット（シフト引き継ぎ・一斉連絡）
//   30秒ポーリングで新着メッセージを自動取得
//   ファイル/写真添付対応、既読数表示

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';
import { uploadFile, resizeImageFile } from '/js/files.js';

const chatList = document.getElementById('chat-list');
const chatForm = document.getElementById('chat-form');
const aiBotPanel = document.getElementById('ai-bot-panel');
const aiBotBtn = document.getElementById('ai-bot-btn');

let currentUser = null;
let lastTimestamp = null;
let pollTimer = null;
const CHANNEL = 'general';

const PI_PATTERNS = [
  /\d{2,4}-\d{2,4}-\d{4}/,
  /0\d{9,10}/,
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
  /〒?\d{3}-\d{4}/,
];
function detectPersonalInfo(text) {
  return PI_PATTERNS.some((p) => p.test(text));
}

// メッセージに添付されたファイルのサムネイル/リンクを描画
async function renderAttachments(fileIds) {
  if (!fileIds || fileIds.length === 0) return null;
  const items = await Promise.all(fileIds.map(async (id) => {
    // ファイル情報取得（失敗しても表示を止めない）
    let meta = null;
    try { meta = await api.get(`/api/files/${id}`).catch(() => null); } catch { /* skip */ }
    const isImage = meta?.content_type?.startsWith('image/');
    if (isImage) {
      return el('a', { href: `/api/files/${id}`, target: '_blank', class: 'chat-img-link' }, [
        el('img', { src: `/api/files/${id}`, class: 'chat-thumb', loading: 'lazy', alt: meta?.file_name || '添付画像' }),
      ]);
    }
    return el('a', { href: `/api/files/${id}`, target: '_blank', class: 'chat-file-link' }, [
      '📎 ', meta?.file_name || `ファイル(${id})`,
    ]);
  }));
  return el('div', { class: 'chat-attachments' }, items);
}

// メッセージをDOMに追加（最下部へ）
async function appendMessages(messages) {
  if (messages.length === 0) return;
  const atBottom = chatList.scrollHeight - chatList.scrollTop <= chatList.clientHeight + 60;

  for (const msg of messages) {
    const isMine = msg.created_by === currentUser.email;
    const isAdmin = currentUser.role === 'admin';

    // 既読数バッジ
    const readBadge = msg.read_count != null
      ? el('span', { class: 'chat-read-count', title: `${msg.read_count}人が既読` }, `既読${msg.read_count}`)
      : null;

    // 添付ファイル
    const fileIds = (() => { try { return JSON.parse(msg.file_ids_json || 'null') || []; } catch { return []; } })();
    const attachEl = el('div', { class: 'chat-attachments' }, []);
    if (fileIds.length > 0) {
      renderAttachments(fileIds).then((el2) => { if (el2) render(attachEl, el2.childNodes ? Array.from(el2.childNodes) : [el2]); });
    }

    const row = el('div', { class: `chat-msg ${isMine ? 'is-mine' : ''}`, dataset: { id: String(msg.id) } }, [
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
      msg.body ? el('div', { class: 'chat-body', style: 'white-space:pre-wrap' }, msg.body) : null,
      fileIds.length > 0 ? attachEl : null,
      isMine && readBadge ? el('div', { class: 'chat-read-row' }, [readBadge]) : null,
    ]);
    chatList.appendChild(row);
    if (msg.created_at > (lastTimestamp || '')) lastTimestamp = msg.created_at;
  }

  if (atBottom) chatList.scrollTop = chatList.scrollHeight;
}

async function loadInitial() {
  render(chatList, el('p', { class: 'loading' }, '読み込み中…'));
  const { messages } = await api.get(`/api/chat?channel=${CHANNEL}&limit=50`);
  chatList.innerHTML = '';
  if (messages.length === 0) {
    chatList.appendChild(el('p', { class: 'empty', style: 'text-align:center;margin-top:40px' }, 'メッセージはありません。最初のメッセージを送ってみましょう！'));
  } else {
    await appendMessages(messages);
    chatList.scrollTop = chatList.scrollHeight;
  }
  // 既読位置を更新
  api.put(`/api/chat?channel=${CHANNEL}`).catch(() => {});
}

async function poll() {
  try {
    if (!lastTimestamp) return;
    const { messages } = await api.get(`/api/chat?channel=${CHANNEL}&since=${encodeURIComponent(lastTimestamp)}`);
    if (messages.length > 0) {
      await appendMessages(messages);
      api.put(`/api/chat?channel=${CHANNEL}`).catch(() => {});
    }
  } catch { /* オフライン時は無視 */ }
}

function renderForm() {
  if (!hasRole(currentUser, 'editor')) {
    render(chatForm, el('p', { class: 'hint', style: 'text-align:center' }, '閲覧のみ権限ではメッセージを送信できません。'));
    return;
  }

  let pendingFiles = []; // アップロード済みファイルのIDリスト

  const filePreview = el('div', { class: 'chat-file-preview' }, []);
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*,video/*,application/pdf',
    multiple: true,
    style: 'display:none',
    onchange: async (e) => {
      const files = Array.from(e.target.files || []);
      fileInput.value = '';
      for (const file of files) {
        const placeholderId = Date.now() + Math.random();
        const thumb = el('div', { class: 'chat-file-item', dataset: { key: String(placeholderId) } }, [
          el('span', { class: 'chat-file-uploading' }, `⏳ ${file.name}`),
        ]);
        filePreview.appendChild(thumb);
        try {
          const processedFile = file.type.startsWith('image/') ? await resizeImageFile(file, 1280, 0.7) : file;
          const meta = await uploadFile(processedFile);
          pendingFiles.push(meta.id);
          thumb.innerHTML = '';
          thumb.appendChild(el('span', {}, `📎 ${meta.file_name || file.name} `));
          thumb.appendChild(el('button', { class: 'btn-icon', onclick: () => {
            pendingFiles = pendingFiles.filter((id) => id !== meta.id);
            thumb.remove();
          } }, '✕'));
        } catch (err) {
          thumb.innerHTML = '';
          thumb.appendChild(el('span', { class: 'notice is-error', style: 'font-size:12px' }, `❌ ${file.name}: ${err.message}`));
        }
      }
    },
  });

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
    if (!body && pendingFiles.length === 0) return;
    if (body && detectPersonalInfo(body)) {
      if (!confirm('電話番号・メールアドレス・郵便番号などの個人情報が含まれている可能性があります。このまま送信しますか？')) return;
    }
    sendBtn.disabled = true;
    try {
      const fileIds = [...pendingFiles];
      await api.post('/api/chat', { body, channel: CHANNEL, file_ids: fileIds });
      textarea.value = '';
      pendingFiles = [];
      render(filePreview, []);
      await poll();
    } catch (err) {
      alert(err.message);
    } finally {
      sendBtn.disabled = false;
      textarea.focus();
    }
  };

  render(chatForm, [
    filePreview,
    el('div', { class: 'chat-input-row' }, [
      el('button', {
        class: 'btn btn-sm',
        title: 'ファイル・写真を添付',
        style: 'align-self:flex-end;font-size:18px;padding:4px 8px',
        onclick: () => fileInput.click(),
      }, '📎'),
      fileInput,
      textarea,
      sendBtn,
    ]),
  ]);
  textarea.focus();
}

// ---- AI ボット ----

function renderAiBot() {
  if (!aiBotPanel || !aiBotBtn) return;
  let history = [];
  let isOpen = false;

  const toggle = () => {
    isOpen = !isOpen;
    aiBotPanel.style.display = isOpen ? 'block' : 'none';
    aiBotBtn.textContent = isOpen ? '✕ AI' : '🤖 AI';
    if (isOpen) botInput.focus();
  };
  aiBotBtn.addEventListener('click', toggle);

  const botLog = el('div', { class: 'ai-bot-log' }, [
    el('p', { class: 'hint', style: 'margin:8px 12px' }, '保全業務に関する質問を入力してください。AI が回答します（参考情報のため、重要な判断は現場担当者が行ってください）。'),
  ]);
  const botInput = el('input', { type: 'text', placeholder: '例: モーターが過熱する場合の原因は？', style: 'flex:1' });
  const askBtn = el('button', { class: 'btn btn-primary btn-sm', onclick: askAI }, '送信');

  botInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); askAI(); } });

  async function askAI() {
    const msg = botInput.value.trim();
    if (!msg) return;
    botInput.value = '';
    askBtn.disabled = true;

    botLog.appendChild(el('div', { class: 'ai-bot-q' }, ['🙋 ', msg]));
    const thinking = el('div', { class: 'ai-bot-a' }, ['🤖 考え中…']);
    botLog.appendChild(thinking);
    botLog.scrollTop = botLog.scrollHeight;

    try {
      const { reply } = await api.post('/api/ai/chat', { message: msg, history });
      thinking.textContent = '';
      thinking.appendChild(document.createTextNode('🤖 '));
      thinking.appendChild(el('span', { style: 'white-space:pre-wrap' }, reply));
      history.push({ role: 'user', content: msg }, { role: 'ai', content: reply });
      if (history.length > 20) history = history.slice(-20);
    } catch (err) {
      thinking.textContent = `❌ ${err.message}`;
    }
    askBtn.disabled = false;
    botLog.scrollTop = botLog.scrollHeight;
    botInput.focus();
  }

  render(aiBotPanel, [
    el('div', { class: 'ai-bot-wrap' }, [
      botLog,
      el('div', { class: 'chat-input-row', style: 'padding:6px 8px' }, [botInput, askBtn]),
    ]),
  ]);
}

(async () => {
  try {
    currentUser = await getCurrentUser();
    await loadInitial();
    renderForm();
    renderAiBot();
    pollTimer = setInterval(poll, 30000);
    window.addEventListener('pagehide', () => clearInterval(pollTimer));
  } catch (err) {
    render(chatList, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
