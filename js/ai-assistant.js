// 全ページ共通のAIアシスタント（フローティングボタン＋下からのパネル）
//   ・読み込むだけで自己初期化。各ページHTMLに <script type="module" src="/js/ai-assistant.js"> を置く
//   ・質問時に「今いるページのURL（path+query）」を送り、サーバーが表示中レコードを文脈に注入する
//   ・回答は参考情報。会話履歴はメモリ保持（最大20件）

import { api } from '/js/api.js';
import { el, render } from '/js/util.js';

let history = [];

function buildPanelBody() {
  const log = el('div', { class: 'ai-bot-log' }, [
    el('p', { class: 'hint', style: 'margin:8px 12px' },
      'この画面の内容について質問できます（例「この内容を要約して」「考えられる原因は？」）。回答は参考情報です。重要な判断は現場担当者が行ってください。'),
  ]);
  const input = el('input', { type: 'text', placeholder: '例: この点検結果を要約して', style: 'flex:1' });
  const sendBtn = el('button', { class: 'btn btn-primary btn-sm' }, '送信');

  const ask = async () => {
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    sendBtn.disabled = true;
    log.appendChild(el('div', { class: 'ai-bot-q' }, ['🙋 ', msg]));
    const thinking = el('div', { class: 'ai-bot-a' }, ['🤖 考え中…']);
    log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      const page = location.pathname + location.search;
      const { reply } = await api.post('/api/ai/chat', { message: msg, history, page });
      thinking.textContent = '';
      thinking.appendChild(document.createTextNode('🤖 '));
      thinking.appendChild(el('span', { style: 'white-space:pre-wrap' }, reply));
      history.push({ role: 'user', content: msg }, { role: 'ai', content: reply });
      if (history.length > 20) history = history.slice(-20);
    } catch (err) {
      thinking.textContent = `❌ ${err.message}`;
    }
    sendBtn.disabled = false;
    log.scrollTop = log.scrollHeight;
    input.focus();
  };

  sendBtn.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });

  const body = el('div', { class: 'ai-bot-wrap' }, [
    log,
    el('div', { class: 'chat-input-row', style: 'padding:6px 8px' }, [input, sendBtn]),
  ]);
  return { body, input };
}

function init() {
  if (document.getElementById('ai-fab')) return; // 二重初期化を防ぐ

  const { body, input } = buildPanelBody();

  const closeBtn = el('button', { class: 'btn-icon', title: '閉じる', 'aria-label': '閉じる' }, '✕');
  const sheet = el('div', { class: 'ai-panel-sheet' }, [
    el('div', { class: 'ai-panel-head' }, [
      el('span', {}, '🤖 AIアシスタント'),
      closeBtn,
    ]),
    body,
  ]);
  const backdrop = el('div', { class: 'ai-panel-backdrop', style: 'display:none' }, [sheet]);

  const fab = el('button', { id: 'ai-fab', class: 'ai-fab no-print', title: 'AIアシスタントに質問', 'aria-label': 'AIアシスタント' }, '🤖');

  const open = () => { backdrop.style.display = 'flex'; fab.style.display = 'none'; setTimeout(() => input.focus(), 50); };
  const close = () => { backdrop.style.display = 'none'; fab.style.display = ''; };

  fab.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  document.body.appendChild(fab);
  document.body.appendChild(backdrop);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
