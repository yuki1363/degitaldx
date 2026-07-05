// 10 チャット — グループチャット（シフト引き継ぎ・一斉連絡）
//   画面表示中は5秒ポーリングで新着メッセージをほぼ即時に表示
//   （タブが裏に回ったら停止して無駄なリクエストを出さない）
//   ファイル/写真添付対応、既読数表示（送信者本人は既読に数えない）
//   メッセージは送信から10日で自動削除される（サーバー側・DBを軽く保つ）
//   投稿を記録化: 有益な投稿をトラブル/業務依頼/日報へ昇格（本文をプリフィル）。10日で消える前に正式記録へ
//   申し送りテンプレート: 定型文をタップで入力欄へ挿入（現場スマホの入力を軽く・書き方を統一）

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';
import { uploadFile, resizeImageFile } from '/js/files.js';

const chatList = document.getElementById('chat-list');
const chatForm = document.getElementById('chat-form');

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

// 申し送りの定型文（タップで入力欄へ挿入）。現場スマホでの入力を減らし、書き方を統一する。
const HANDOFF_TEMPLATES = [
  '【引き継ぎ】次の当番へ：',
  '【対応中】設備：\n状況：',
  '【要確認】',
  '【完了報告】',
  '【部品発注】品番：\n数量：',
];

// チャット投稿を正式な記録へ「昇格」させるリンク群を作る。
//   10日で自動削除されるチャットの中で、有益な情報をトラブル/業務依頼/日報として残せるようにする。
//   遷移先フォームは既存の URL プリフィルに対応済み（本文を引き継ぐ）。写真は引き継がないので別途添付する。
function buildRecordActions(body) {
  const title = body.split('\n')[0].slice(0, 40); // 業務依頼の件名は1行目のみ（長すぎ防止）
  const links = [
    ['🔧 トラブル記録', `/pages/trouble?${new URLSearchParams({ new: '1', phenomenon: body })}`],
    ['🛠 業務依頼',    `/pages/repair?${new URLSearchParams({ new: '1', title, description: body })}`],
    ['📝 日報',        `/pages/report?${new URLSearchParams({ body })}`],
  ];
  return el('div', { class: 'chat-record-actions', style: 'display:none' },
    links.map(([label, href]) => el('a', { class: 'btn btn-sm', href }, label))
  );
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

    // 記録化: 本文のある投稿を、editor 以上がトラブル/業務依頼/日報へ昇格できる（📋で開閉）
    const canRecord = hasRole(currentUser, 'editor') && !!msg.body;
    const recordActions = canRecord ? buildRecordActions(msg.body) : null;
    const recordBtn = canRecord ? el('button', {
      class: 'btn-icon',
      title: '記録化（トラブル/業務依頼/日報に変換）',
      onclick: () => {
        recordActions.style.display = recordActions.style.display === 'none' ? 'flex' : 'none';
      },
    }, '📋') : null;

    const row = el('div', { class: `chat-msg ${isMine ? 'is-mine' : ''}`, dataset: { id: String(msg.id) } }, [
      el('div', { class: 'chat-meta' }, [
        el('span', { class: 'chat-author' }, msg.author_name || maskEmail(msg.created_by)),
        el('span', { class: 'chat-time' }, formatDateTime(msg.created_at)),
        recordBtn,
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
      recordActions,
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

  // 申し送りテンプレート: タップで入力欄へ挿入（既存文があれば改行して追記）
  const insertTemplate = (t) => {
    const cur = textarea.value;
    textarea.value = cur.trim() ? cur.replace(/\s*$/, '') + '\n' + t : t;
    textarea.focus();
    const end = textarea.value.length;
    try { textarea.setSelectionRange(end, end); } catch { /* 一部環境で失敗しても無害 */ }
  };
  const templateRow = el('div', { class: 'chat-templates' },
    HANDOFF_TEMPLATES.map((t) => el('button', {
      type: 'button', class: 'chat-tpl-chip', title: 'タップで入力欄に挿入',
      onclick: () => insertTemplate(t),
    }, t.split('\n')[0]))
  );

  render(chatForm, [
    templateRow,
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
    el('p', { class: 'hint', style: 'margin:2px 0 0;font-size:11px' }, 'メッセージは送信から10日で自動削除されます'),
  ]);
  textarea.focus();
}

(async () => {
  try {
    currentUser = await getCurrentUser();
    await loadInitial();
    renderForm();
    // 画面表示中は5秒間隔でポーリング（送信されたらほぼ即時に表示される）。
    // タブが裏に回ったら停止し、戻ったら即取得＋再開（無駄なリクエストを出さない）。
    const POLL_MS = 5000;
    const startPolling = () => { if (!pollTimer) pollTimer = setInterval(poll, POLL_MS); };
    const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };
    startPolling();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopPolling(); }
      else { poll(); startPolling(); }
    });
    window.addEventListener('pagehide', stopPolling);
  } catch (err) {
    render(chatList, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
