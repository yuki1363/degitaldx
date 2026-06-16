// 04 トラブル記録 — 一覧（ジャンル・設備・期間絞り込み）・登録・編集・詳細
//   URL: /pages/trouble            … 一覧
//        /pages/trouble?new=1      … 新規登録
//        /pages/trouble?edit=N     … 編集
//        /pages/trouble?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { uploadFile, resizeImageFile } from '/js/files.js';
import { el, render, formatDate, formatDateTime, formatBytes, ACTION_LABELS, nowLocalInputValue, isoToLocalInputValue, localInputToIso } from '/js/util.js';
import { buildCommentsCard } from '/js/comments.js';

const app = document.getElementById('app');
let currentUser = null;
let categories = [];

function go(query) {
  window.location.href = `/pages/trouble${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 一覧 ----------------

async function renderList(equipmentId) {
  const [{ categories: cats }, { equipment }] = await Promise.all([
    api.get('/api/troubles/categories'),
    api.get('/api/equipment'),
  ]);
  categories = cats;

  // フィルタ状態（設備台帳の「すべて見る」から来た場合は設備で初期絞り込み）
  let filterCategory = '';
  let filterEquipment = equipmentId ? String(equipmentId) : '';
  let filterFrom = '';
  let filterTo = '';

  const listBox = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const params = new URLSearchParams();
    if (filterCategory) params.set('category_id', filterCategory);
    if (filterEquipment) params.set('equipment_id', filterEquipment);
    if (filterFrom) params.set('from', filterFrom);
    if (filterTo) params.set('to', filterTo);
    const { troubles } = await api.get(`/api/troubles${params.toString() ? '?' + params : ''}`);
    if (troubles.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '該当するトラブル記録がありません。'));
      return;
    }
    render(
      listBox,
      troubles.map((t) =>
        el('a', { class: 'list-item', href: `/pages/trouble?id=${t.id}` }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-sub' }, [
              formatDateTime(t.occurred_at),
              t.category_name ? el('span', { class: 'cat-badge' }, t.category_name) : null,
            ]),
            el('div', { class: 'list-item-title' }, t.phenomenon),
            el('div', { class: 'list-item-sub' }, t.equipment_name || '設備未指定'),
          ]),
          el('span', { class: 'chevron' }, '›'),
        ])
      )
    );
  };

  const catSel = el('select', { onchange: (e) => { filterCategory = e.target.value; load().catch(showError); } }, [
    el('option', { value: '' }, '全ジャンル'),
    ...cats.map((c) => el('option', { value: c.id }, c.name)),
  ]);
  const eqSel = el('select', { onchange: (e) => { filterEquipment = e.target.value; load().catch(showError); } }, [
    el('option', { value: '' }, '全設備'),
    ...equipment.map((e) => el('option', { value: e.id, selected: String(e.id) === filterEquipment }, `${e.code} ${e.name}`)),
  ]);
  const fromInput = el('input', {
    type: 'date',
    onchange: (e) => { filterFrom = e.target.value; load().catch(showError); },
  });
  const toInput = el('input', {
    type: 'date',
    onchange: (e) => { filterTo = e.target.value; load().catch(showError); },
  });

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'field-pair' }, [
        el('div', { class: 'field' }, [el('label', {}, 'ジャンル'), catSel]),
        el('div', { class: 'field' }, [el('label', {}, '設備'), eqSel]),
      ]),
      el('div', { class: 'field-pair' }, [
        el('div', { class: 'field' }, [el('label', {}, '期間（から）'), fromInput]),
        el('div', { class: 'field' }, [el('label', {}, '〜（まで）'), toInput]),
      ]),
    ]),
    hasRole(currentUser, 'editor')
      ? el('div', { style: 'margin-bottom:12px' }, [
          el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ トラブルを記録'),
        ])
      : null,
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
  const { trouble, files, history } = await api.get(`/api/troubles/${id}`);
  const canEdit = hasRole(currentUser, 'editor');

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
    type: 'file',
    accept: 'image/*,video/*,application/pdf',
    multiple: true,
    hidden: true,
    onchange: async (e) => {
      const fileList = Array.from(e.target.files);
      if (!fileList.length) return;
      try {
        for (const file of fileList) {
          const prepared = await resizeImageFile(file);
          await uploadFile(prepared, { relatedTable: 'trouble_record', relatedId: id });
        }
        const fresh = await api.get(`/api/troubles/${id}`);
        renderFiles(fresh.files);
      } catch (err) {
        alert(err.message);
      } finally {
        e.target.value = '';
      }
    },
  });

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, trouble.phenomenon),
        trouble.category_name ? el('span', { class: 'cat-badge' }, trouble.category_name) : null,
      ]),
      infoRow('発生日時', formatDateTime(trouble.occurred_at)),
      infoRow('設備', trouble.equipment_name ? `${trouble.equipment_code} ${trouble.equipment_name}` : null),
      infoRow('原因', trouble.cause),
      infoRow('対策', trouble.countermeasure),
      ...parseCustomValues(trouble.custom_fields_json).map((v) => infoRow(v.name, v.value)),
      infoRow('記録者', trouble.reporter_name || trouble.created_by),
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}`) }, '編集'),
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm('このトラブル記録を削除しますか？')) return;
              await api.del(`/api/troubles/${id}`);
              go('');
            },
          }, '削除'),
        ])
      : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '添付写真・ファイル'),
        canEdit ? el('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, '＋ 添付') : null,
      ]),
      fileInput,
      filesBox,
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '変更履歴'),
      history.length === 0
        ? el('p', { class: 'empty' }, '履歴はありません。')
        : el('div', { class: 'row-list' },
            history.map((h) =>
              el('div', { class: 'history-row' }, [
                el('span', { class: `action-badge is-${h.action}` }, ACTION_LABELS[h.action] || h.action),
                el('span', {}, h.changed_by),
                el('span', { class: 'list-item-sub' }, formatDateTime(h.changed_at)),
              ])
            )
          ),
    ]),
    buildCommentsCard('trouble_record', id, currentUser),
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', {}, label), input]);
}

// custom_fields_json（文字列）→ [{ field_id, name, value }] を安全にパース
function parseCustomValues(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function renderForm(existing, prefill = null) {
  // existing = 本物の編集（PUT）。prefill = 点検異常などからの新規プリフィル（POST のまま）。
  const init = existing || prefill || {};
  const [{ categories: cats }, { equipment }, { fields: customFields }] = await Promise.all([
    api.get('/api/troubles/categories'),
    api.get('/api/equipment'),
    // カスタム項目テーブル未作成の環境でもフォーム自体は使えるようにする
    api.get('/api/troubles/fields').catch(() => ({ fields: [] })),
  ]);

  const f = {
    occurred_at: el('input', {
      type: 'datetime-local',
      value: existing ? isoToLocalInputValue(existing.occurred_at) : nowLocalInputValue(),
    }),
    category_id: el('select', {},
      [el('option', { value: '' }, '— ジャンルを選択'),
      ...cats.map((c) =>
        el('option', { value: c.id, selected: existing?.category_id === c.id }, c.name)
      )]
    ),
    equipment_id: el('select', {},
      [el('option', { value: '' }, '— 設備を選択（任意）'),
      ...equipment.map((e) =>
        el('option', { value: e.id, selected: init.equipment_id === e.id }, `${e.code} ${e.name}`)
      )]
    ),
    phenomenon: el('textarea', { placeholder: '例: 異音が発生した' }, init.phenomenon || ''),
    cause: el('textarea', { placeholder: '例: ベルトの摩耗' }, existing?.cause || ''),
    countermeasure: el('textarea', { placeholder: '例: ベルト交換' }, existing?.countermeasure || ''),
  };

  // カスタム項目（管理画面で定義した追加入力欄）
  const existingCustom = parseCustomValues(existing?.custom_fields_json);
  const customInputs = customFields.map((fld) => {
    const prev = existingCustom.find((v) => v.field_id === fld.id);
    let input;
    if (fld.input_type === 'select') {
      let opts = [];
      try { opts = JSON.parse(fld.options_json) || []; } catch { /* 定義不正時は選択肢なし */ }
      input = el('select', {}, [
        el('option', { value: '' }, '— 選択'),
        ...opts.map((o) => el('option', { value: o, selected: prev?.value === o }, o)),
      ]);
    } else if (fld.input_type === 'number') {
      input = el('input', { type: 'number', value: prev?.value ?? '' });
    } else {
      input = el('input', { type: 'text', value: prev?.value ?? '' });
    }
    return { fld, input };
  });

  const save = async () => {
    const customValues = customInputs
      .map(({ fld, input }) => ({ field_id: fld.id, name: fld.name, value: String(input.value).trim() }))
      .filter((v) => v.value !== '');
    const body = {
      occurred_at: localInputToIso(f.occurred_at.value),
      category_id: f.category_id.value ? Number(f.category_id.value) : null,
      equipment_id: f.equipment_id.value ? Number(f.equipment_id.value) : null,
      phenomenon: f.phenomenon.value.trim(),
      cause: f.cause.value.trim() || null,
      countermeasure: f.countermeasure.value.trim() || null,
      custom_fields_json: customValues.length > 0 ? customValues : null,
    };
    if (!body.phenomenon) { alert('現象は必須です。'); return; }
    if (!body.occurred_at) { alert('発生日時は必須です。'); return; }
    try {
      if (existing) {
        await api.put(`/api/troubles/${existing.id}`, body);
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/troubles', body);
        go(`?id=${id}`);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? 'トラブル記録を編集' : 'トラブルを記録'),
      field('発生日時（必須）', f.occurred_at),
      field('ジャンル', f.category_id),
      field('設備', f.equipment_id),
      field('現象（必須）', f.phenomenon),
      field('原因', f.cause),
      field('対策', f.countermeasure),
      ...customInputs.map(({ fld, input }) => field(fld.name, input)),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', {
          class: 'btn',
          onclick: () => (existing ? go(`?id=${existing.id}`) : go('')),
        }, 'キャンセル'),
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
      const { trouble } = await api.get(`/api/troubles/${Number(params.get('edit'))}`);
      await renderForm(trouble);
    } else if (params.get('new')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('登録する権限がありません。');
      // 点検異常などからのプリフィル（設備・現象）を受け取る
      const prefill = {
        equipment_id: Number(params.get('equipment_id')) || null,
        phenomenon: params.get('phenomenon') || '',
      };
      await renderForm(null, prefill);
    } else {
      await renderList(Number(params.get('equipment_id')) || undefined);
    }
  } catch (err) {
    showError(err);
  }
})();
