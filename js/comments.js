// 10 コメント共通モジュール — 各レコード詳細画面で使う
//   呼び出し側: buildCommentsCard(relatedTable, relatedId, currentUser) を await して
//              renderの配列に追加するだけでコメント欄が付く

import { api } from '/js/api.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';

const PI_PATTERNS = [
  /\d{2,4}-\d{2,4}-\d{4}/,                    // 電話: 03-1234-5678
  /0\d{9,10}/,                                  // 携帯: 09012345678
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/, // メール
  /〒?\d{3}-\d{4}/,                             // 郵便番号
];

function detectPersonalInfo(text) {
  return PI_PATTERNS.some((p) => p.test(text));
}

export function buildCommentsCard(relatedTable, relatedId, currentUser) {
  const canWrite = ['editor', 'admin'].includes(currentUser?.role);
  const listBox  = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const { comments } = await api.get(`/api/comments?related_table=${relatedTable}&related_id=${relatedId}`);
    if (comments.length === 0) {
      render(listBox, el('p', { class: 'empty' }, 'コメントはありません。'));
      return;
    }
    render(listBox, comments.map((c) => {
      const isMine = c.created_by === currentUser?.email;
      const isAdmin = currentUser?.role === 'admin';
      return el('div', { class: 'comment-row' }, [
        el('div', { class: 'comment-meta' }, [
          el('span', { class: 'comment-author' }, c.author_name || maskEmail(c.created_by)),
          el('span', { class: 'comment-time' }, formatDateTime(c.created_at)),
          (isMine || isAdmin) ? el('button', {
            class: 'btn-icon',
            title: '削除',
            onclick: async () => {
              if (!confirm('このコメントを削除しますか？')) return;
              await api.del(`/api/comments/${c.id}`);
              load().catch(() => {});
            },
          }, '✕') : null,
        ]),
        el('div', { class: 'comment-body', style: 'white-space:pre-wrap' }, c.body),
      ]);
    }));
  };

  load().catch(() => render(listBox, el('p', { class: 'notice is-error' }, 'コメントの読み込みに失敗しました')));

  const textarea = canWrite ? el('textarea', {
    placeholder: '氏名・電話番号・住所等の個人情報は入力しないでください',
    rows: 2,
    style: 'resize:vertical',
  }) : null;

  const sendBtn = canWrite ? el('button', {
    class: 'btn btn-sm btn-primary',
    onclick: async () => {
      const body = textarea.value.trim();
      if (!body) return;
      if (detectPersonalInfo(body)) {
        if (!confirm('電話番号・メールアドレス・郵便番号などの個人情報が含まれている可能性があります。このまま送信しますか？')) return;
      }
      sendBtn.disabled = true;
      try {
        await api.post('/api/comments', { related_table: relatedTable, related_id: relatedId, body });
        textarea.value = '';
        await load();
      } catch (err) {
        alert(err.message);
      } finally {
        sendBtn.disabled = false;
      }
    },
  }, '送信') : null;

  return el('div', { class: 'card' }, [
    el('h3', { class: 'card-title' }, 'コメント'),
    listBox,
    canWrite ? el('div', { class: 'comment-form' }, [textarea, sendBtn]) : null,
  ]);
}
