// 10 チャット — グループチャット（シフト引き継ぎ・一斉連絡）
//   画面表示中は5秒ポーリングで新着メッセージをほぼ即時に表示
//   （タブが裏に回ったら停止して無駄なリクエストを出さない）
//   ファイル/写真添付対応、既読数表示（送信者本人は既読に数えない）
//   メッセージは送信から10日で自動削除される（サーバー側・DBを軽く保つ）
//   投稿を記録化: 有益な投稿をトラブル/業務依頼/日報へ昇格（本文をプリフィル）。10日で消える前に正式記録へ
//   申し送りテンプレート: 定型文をタップで入力欄へ挿入（現場スマホの入力を軽く・書き方を統一）
//   👍確認リアクション: 既読（見た）とは別の「了解した」表明。誰が確認したか名前で表示
//   📌ピン留め: 重要な申し送りを10日自動削除の対象外にして上部バーに常時表示
//   既読数・👍・📌は5秒ポーリングの meta でライブ更新（リロード不要）

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
    // ファイル情報取得（失敗しても表示を止めない）。
    // ?meta=1 でメタだけを JSON で取る（本体GETはバイナリを返すため、
    // メタ無しでは画像判定できずサムネイルにならない＋本体を無駄にDLしてしまう）
    let meta = null;
    try { meta = await api.get(`/api/files/${id}?meta=1`).catch(() => null); } catch { /* skip */ }
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

// 表示名（ユーザー名が無いときはメールを伏せて表示）
const displayName = (s) => (s && s.includes('@') ? maskEmail(s) : (s || ''));

// 行ごとの状態（id → { row, foot, pinBtn, msg, meta }）。
// ポーリングの meta で既読数・👍リアクション・📌ピンをリロードなしで更新するために持つ
const rowState = new Map();

// フッター行（👍確認ボタン・確認者名・既読数）を作り直す
function updateFoot(entry) {
  const { foot, msg } = entry;
  const meta = entry.meta || {};
  const isMine = msg.created_by === currentUser.email;
  const kids = [];

  // 👍確認トグル（他人の投稿・editor以上のみ）。「見た（既読）」とは別に「了解した」を表明する
  if (!isMine && hasRole(currentUser, 'editor')) {
    kids.push(el('button', {
      class: `chat-react-btn${meta.my_react ? ' is-on' : ''}`,
      type: 'button',
      title: meta.my_react ? '確認を取り消す' : '「確認しました」を伝える',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await api.post(`/api/chat/${msg.id}`, { action: 'react' }); await poll(); }
        catch (err) { alert(err.message); }
        finally { btn.disabled = false; }
      },
    }, meta.my_react ? '👍 確認済' : '👍 確認'));
  }

  const names = (meta.reactions || []).map(displayName).filter(Boolean);
  if (names.length > 0) {
    kids.push(el('span', { class: 'chat-react-names' }, `👍 ${names.join('・')}`));
  }
  if (isMine && meta.read_count != null) {
    kids.push(el('span', { class: 'chat-read-count', title: `${meta.read_count}人が既読` }, `既読${meta.read_count}`));
  }

  render(foot, kids);
  foot.style.display = kids.length > 0 ? '' : 'none';
}

// ポーリング結果の meta（直近20件の既読数・リアクション）を各行へ反映
function applyMeta(metaMap) {
  if (!metaMap) return;
  for (const [id, m] of Object.entries(metaMap)) {
    const entry = rowState.get(Number(id));
    if (!entry) continue;
    entry.meta = m;
    updateFoot(entry);
  }
}

// 📌ピン状態を行へ反映
function setPinState(entry, pinned) {
  entry.row.classList.toggle('is-pinned-msg', pinned);
  if (entry.pinBtn) {
    entry.pinBtn.classList.toggle('is-on', pinned);
    entry.pinBtn.title = pinned ? 'ピン解除' : 'ピン留め（10日自動削除の対象外になる）';
  }
}

// ピン留めバー（チャット上部に常時表示。タップで該当メッセージへスクロール）
let pinnedBar = null;

function jumpToMessage(id) {
  const target = chatList.querySelector(`[data-id="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('chat-flash');
  void target.offsetWidth; // アニメーションを再発火させる
  target.classList.add('chat-flash');
}

function renderPinnedBar(pinned) {
  if (!pinnedBar) return;
  const items = pinned || [];
  const pinnedIds = new Set(items.map((p) => p.id));
  // 行側の📌状態も同期（他の人のピン/解除がポーリングで反映される）
  for (const entry of rowState.values()) setPinState(entry, pinnedIds.has(entry.msg.id));

  if (items.length === 0) {
    pinnedBar.style.display = 'none';
    render(pinnedBar, []);
    return;
  }
  pinnedBar.style.display = '';
  render(pinnedBar, items.map((p) => el('div', { class: 'chat-pin-item' }, [
    el('button', { class: 'chat-pin-jump', type: 'button', onclick: () => jumpToMessage(p.id) },
      `📌 ${displayName(p.author_name || p.created_by)}: ${(p.body || '（添付ファイル）').split('\n')[0].slice(0, 50)}`),
    hasRole(currentUser, 'editor') ? el('button', {
      class: 'btn-icon', type: 'button', title: 'ピン解除',
      onclick: async () => {
        try { await api.put(`/api/chat/${p.id}`, { pinned: false }); await poll(); }
        catch (err) { alert(err.message); }
      },
    }, '✕') : null,
  ])));
}

// メッセージをDOMに追加（最下部へ）。同じIDの行は二重に描画しない
async function appendMessages(messages) {
  if (messages.length === 0) return;
  chatList.querySelector('.empty')?.remove(); // 「メッセージはありません」の表示を消す
  const atBottom = chatList.scrollHeight - chatList.scrollTop <= chatList.clientHeight + 60;

  for (const msg of messages) {
    if (msg.created_at > (lastTimestamp || '')) lastTimestamp = msg.created_at;
    // 送信直後の即時取得と5秒ポーリングが並走しても、同じメッセージを二重描画しない
    if (chatList.querySelector(`[data-id="${msg.id}"]`)) continue;

    const isMine = msg.created_by === currentUser.email;
    const isAdmin = currentUser.role === 'admin';

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

    // 📌ピン留めトグル（editor以上）。ピン中は10日自動削除の対象外
    const pinBtn = hasRole(currentUser, 'editor') ? el('button', {
      class: 'btn-icon chat-pin-btn',
      title: 'ピン留め（10日自動削除の対象外になる）',
      onclick: async () => {
        const nowPinned = row.classList.contains('is-pinned-msg');
        try { await api.put(`/api/chat/${msg.id}`, { pinned: !nowPinned }); await poll(); }
        catch (err) { alert(err.message); }
      },
    }, '📌') : null;

    // 既読数・👍リアクションの表示先（updateFoot が中身を作る）
    const foot = el('div', { class: 'chat-foot', style: 'display:none' }, []);

    const row = el('div', { class: `chat-msg ${isMine ? 'is-mine' : ''}`, dataset: { id: String(msg.id) } }, [
      el('div', { class: 'chat-meta' }, [
        el('span', { class: 'chat-author' }, msg.author_name || maskEmail(msg.created_by)),
        el('span', { class: 'chat-time' }, formatDateTime(msg.created_at)),
        pinBtn,
        recordBtn,
        (isMine || isAdmin) ? el('button', {
          class: 'btn-icon',
          title: '削除',
          onclick: async () => {
            if (!confirm('このメッセージを削除しますか？')) return;
            await api.del(`/api/chat/${msg.id}`);
            row.remove();
            rowState.delete(msg.id);
            poll().catch(() => {}); // ピン留め中だった場合にバーを更新する
          },
        }, '✕') : null,
      ]),
      msg.body ? el('div', { class: 'chat-body', style: 'white-space:pre-wrap' }, msg.body) : null,
      fileIds.length > 0 ? attachEl : null,
      recordActions,
      foot,
    ]);
    chatList.appendChild(row);

    const entry = { row, foot, pinBtn, msg, meta: { read_count: msg.read_count, reactions: [], my_react: false } };
    rowState.set(msg.id, entry);
    updateFoot(entry);
    if (msg.pinned_at) setPinState(entry, true);
  }

  if (atBottom) chatList.scrollTop = chatList.scrollHeight;
}

async function loadInitial() {
  render(chatList, el('p', { class: 'loading' }, '読み込み中…'));
  const { messages, meta, pinned } = await api.get(`/api/chat?channel=${CHANNEL}&limit=50`);
  chatList.innerHTML = '';
  if (messages.length === 0) {
    chatList.appendChild(el('p', { class: 'empty', style: 'text-align:center;margin-top:40px' }, 'メッセージはありません。最初のメッセージを送ってみましょう！'));
    // メッセージ0件でもポーリングが動くよう起点を epoch にする
    // （null のままだと poll() が何もせず、他の人の初投稿が永遠に表示されない）
    lastTimestamp = new Date(0).toISOString();
  } else {
    await appendMessages(messages);
    chatList.scrollTop = chatList.scrollHeight;
  }
  applyMeta(meta);
  renderPinnedBar(pinned);
  // 既読位置を更新
  api.put(`/api/chat?channel=${CHANNEL}`).catch(() => {});
}

let pollInflight = false;

async function poll() {
  if (pollInflight) return; // 送信直後の即時取得と5秒タイマーの並走で二重取得しない
  pollInflight = true;
  try {
    if (!lastTimestamp) return;
    const { messages, meta, pinned } = await api.get(`/api/chat?channel=${CHANNEL}&since=${encodeURIComponent(lastTimestamp)}`);
    if (messages.length > 0) {
      await appendMessages(messages);
      api.put(`/api/chat?channel=${CHANNEL}`).catch(() => {});
    }
    // 新着が無くても既読数・👍・📌はライブ更新する
    applyMeta(meta);
    renderPinnedBar(pinned);
  } catch { /* オフライン時は無視 */ }
  finally { pollInflight = false; }
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
    el('p', { class: 'hint', style: 'margin:2px 0 0;font-size:11px' }, 'メッセージは送信から10日で自動削除されます（📌ピン留めした投稿は残ります）'),
  ]);
  textarea.focus();
}

(async () => {
  try {
    currentUser = await getCurrentUser();
    // ピン留めバーをメッセージ一覧の上（スクロール外）に置く
    pinnedBar = el('div', { id: 'chat-pinned', class: 'chat-pinned', style: 'display:none' }, []);
    chatList.before(pinnedBar);
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
