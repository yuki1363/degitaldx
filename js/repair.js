// 03 修理依頼 — 一覧（ステータス別）・登録・編集・詳細・進捗変更
//   URL: /pages/repair            … 一覧
//        /pages/repair?new=1      … 新規登録
//        /pages/repair?edit=N     … 編集
//        /pages/repair?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { uploadFile, resizeImageFile } from '/js/files.js';
import { el, render, formatDateTime, formatBytes, ACTION_LABELS, isoToLocalInputValue } from '/js/util.js';

const STATUS = {
  open:          { label: '受付',    color: '#1e40af', bg: '#dbeafe' },
  in_progress:   { label: '対応中',  color: '#b45309', bg: '#fef3c7' },
  waiting_parts: { label: '部品待ち', color: '#6b21a8', bg: '#f3e8ff' },
  done:          { label: '完了',    color: '#15803d', bg: '#dcfce7' },
};

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/repair${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 一覧 ----------------

async function renderList() {
  const [{ equipment }, { users }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/users'),
  ]);

  let filterStatus = '';
  const listBox = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const params = filterStatus ? `?status=${filterStatus}` : '';
    const { repairs } = await api.get(`/api/repairs${params}`);
    if (repairs.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '修理依頼はありません。'));
      return;
    }
    render(
      listBox,
      repairs.map((r) => {
        const s = STATUS[r.status] || STATUS.open;
        return el('a', { class: 'list-item', href: `/pages/repair?id=${r.id}` }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-sub' }, [
              el('span', { class: 'status-badge', style: `background:${s.bg};color:${s.color}` }, s.label),
              formatDateTime(r.created_at),
            ]),
            el('div', { class: 'list-item-title' }, r.title),
            el('div', { class: 'list-item-sub' }, [
              r.equipment_name || '設備未指定',
              r.assignee_name ? `担当: ${r.assignee_name}` : null,
            ].filter(Boolean).join(' / ')),
          ]),
          el('span', { class: 'chevron' }, '›'),
        ]);
      })
    );
  };

  const statusSel = el('select', { onchange: (e) => { filterStatus = e.target.value; load().catch(showError); } }, [
    el('option', { value: '' }, '全ステータス'),
    ...Object.entries(STATUS).map(([v, { label }]) => el('option', { value: v }, label)),
  ]);

  render(app, [
    el('div', { class: 'toolbar' }, [
      statusSel,
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 依頼を登録')
        : null,
    ]),
    listBox,
  ]);
  await load();
}

// ---------------- 詳細 ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

async function renderDetail(id) {
  const { repair, files, history } = await api.get(`/api/repairs/${id}`);
  const canEdit = hasRole(currentUser, 'editor');
  const s = STATUS[repair.status] || STATUS.open;

  // ファイル一覧
  const filesBox = el('div', { class: 'row-list' }, []);
  const renderFiles = (list) => {
    if (list.length === 0) {
      render(filesBox, el('p', { class: 'empty' }, '添付ファイルはありません。'));
      return;
    }
    const imgs = list.filter((f) => f.content_type.startsWith('image/'));
    const others = list.filter((f) => !f.content_type.startsWith('image/'));
    render(filesBox, [
      imgs.length > 0
        ? el('div', { class: 'thumb-grid' },
            imgs.map((f) =>
              el('a', { href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' },
                el('img', { class: 'thumb', src: `/api/files/${f.id}`, alt: f.file_name, loading: 'lazy' })
              )
            )
          )
        : null,
      ...others.map((f) =>
        el('div', { class: 'file-row' }, [
          el('a', { class: 'file-name', href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, f.file_name),
          el('span', { class: 'file-meta' }, formatBytes(f.size_bytes)),
        ])
      ),
    ]);
  };
  renderFiles(files);

  const fileInput = el('input', {
    type: 'file', accept: 'image/*,video/*,application/pdf', multiple: true, hidden: true,
    onchange: async (e) => {
      for (const file of Array.from(e.target.files)) {
        try {
          const prepared = await resizeImageFile(file);
          await uploadFile(prepared, { relatedTable: 'repair_request', relatedId: id });
        } catch (err) { alert(err.message); }
      }
      const fresh = await api.get(`/api/repairs/${id}`);
      renderFiles(fresh.files);
      e.target.value = '';
    },
  });

  // ステータス変更ボタン
  const nextStatuses = {
    open:          [['in_progress', '対応開始'], ['waiting_parts', '部品待ちに変更']],
    in_progress:   [['waiting_parts', '部品待ちに変更'], ['done', '完了にする']],
    waiting_parts: [['in_progress', '対応再開'], ['done', '完了にする']],
    done:          [['open', '再受付']],
  };
  const statusBtns = canEdit
    ? (nextStatuses[repair.status] || []).map(([newStatus, label]) =>
        el('button', {
          class: newStatus === 'done' ? 'btn btn-primary' : 'btn',
          onclick: async () => {
            const comment = prompt('コメント（任意）');
            await api.put(`/api/repairs/${id}`, { status: newStatus, comment: comment || '' });
            go(`?id=${id}`);
          },
        }, label)
      )
    : [];

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, repair.title),
        el('span', { class: 'status-badge', style: `background:${s.bg};color:${s.color}` }, s.label),
      ]),
      infoRow('設備', repair.equipment_name ? `${repair.equipment_code} ${repair.equipment_name}` : null),
      infoRow('担当者', repair.assignee_name),
      infoRow('登録日時', formatDateTime(repair.created_at)),
      repair.description ? el('div', { class: 'note-box' }, repair.description) : null,
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          ...statusBtns,
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}`) }, '編集'),
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm('この修理依頼を削除しますか？')) return;
              await api.del(`/api/repairs/${id}`);
              go('');
            },
          }, '削除'),
        ])
      : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '添付ファイル'),
        canEdit ? el('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, '＋ 添付') : null,
      ]),
      fileInput,
      filesBox,
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '対応履歴'),
      history.length === 0
        ? el('p', { class: 'empty' }, '履歴はありません。')
        : el('div', { class: 'row-list' },
            history.map((h) => {
              const from = STATUS[h.old_status]?.label || '—';
              const to = STATUS[h.new_status]?.label || h.new_status;
              return el('div', { class: 'history-row' }, [
                el('span', { class: 'action-badge is-update' }, `${from} → ${to}`),
                el('span', {}, h.changed_by),
                el('span', { class: 'list-item-sub' }, formatDateTime(h.changed_at)),
                h.comment ? el('span', { class: 'list-item-sub' }, h.comment) : null,
              ]);
            })
          ),
    ]),
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', {}, label), input]);
}

async function renderForm(existing) {
  const [{ equipment }, { users }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/users'),
  ]);

  const f = {
    title: el('input', { type: 'text', value: existing?.title || '', placeholder: '例: 3号機 ポンプ異音' }),
    equipment_id: el('select', {},
      [el('option', { value: '' }, '— 設備を選択（任意）'),
      ...equipment.map((e) =>
        el('option', { value: e.id, selected: existing?.equipment_id === e.id }, `${e.code} ${e.name}`)
      )]
    ),
    assignee_id: el('select', {},
      [el('option', { value: '' }, '— 担当者を選択（任意）'),
      ...users.map((u) =>
        el('option', { value: u.id, selected: existing?.assignee_id === u.id }, u.name || u.email)
      )]
    ),
    description: el('textarea', { placeholder: '状況・症状の詳細' }, existing?.description || ''),
  };

  const save = async () => {
    const body = {
      title: f.title.value.trim(),
      equipment_id: f.equipment_id.value ? Number(f.equipment_id.value) : null,
      assignee_id: f.assignee_id.value ? Number(f.assignee_id.value) : null,
      description: f.description.value.trim() || null,
    };
    if (!body.title) { alert('タイトルは必須です。'); return; }
    try {
      if (existing) {
        await api.put(`/api/repairs/${existing.id}`, body);
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/repairs', body);
        go(`?id=${id}`);
      }
    } catch (err) { alert(err.message); }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '修理依頼を編集' : '修理依頼を登録'),
      field('タイトル（必須）', f.title),
      field('設備', f.equipment_id),
      field('担当者', f.assignee_id),
      field('詳細・症状', f.description),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', { class: 'btn', onclick: () => (existing ? go(`?id=${existing.id}`) : go('')) }, 'キャンセル'),
      ]),
    ]),
  ]);
}

// ---------------- 起動 ----------------

(async () => {
  try {
    currentUser = await getCurrentUser();
    const params = new URLSearchParams(window.location.search);
    if (params.get('id')) {
      await renderDetail(Number(params.get('id')));
    } else if (params.get('edit')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('編集する権限がありません。');
      const { repair } = await api.get(`/api/repairs/${Number(params.get('edit'))}`);
      await renderForm(repair);
    } else if (params.get('new')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('登録する権限がありません。');
      await renderForm(null);
    } else {
      await renderList();
    }
  } catch (err) {
    showError(err);
  }
})();
