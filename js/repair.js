// 03 業務依頼（修理・その他の依頼） — 一覧（ステータス別）・登録・編集・詳細・進捗変更
//   ※ 内部名は repair（テーブル repair_request / URL /pages/repair）のまま
//   URL: /pages/repair            … 一覧
//        /pages/repair?new=1      … 新規登録
//        /pages/repair?edit=N     … 編集
//        /pages/repair?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { uploadFile, resizeImageFile } from '/js/files.js';
import { el, render, formatDateTime, formatBytes, maskEmail, ACTION_LABELS, isoToLocalInputValue } from '/js/util.js';
import { buildEquipSelect } from '/js/equip-picker.js';
import { openQrScanner } from '/js/qr-scan.js';
import { installUnsavedGuard, saveErrorMessage } from '/js/draft.js';
import { enqueue as enqueueOffline } from '/js/offline-queue.js';

const STATUS = {
  open:          { label: '受付',    color: '#1e40af', bg: '#dbeafe' },
  in_progress:   { label: '対応中',  color: '#b45309', bg: '#fef3c7' },
  waiting_parts: { label: '部品待ち', color: '#6b21a8', bg: '#f3e8ff' },
  done:          { label: '完了',    color: '#15803d', bg: '#dcfce7' },
};

// 起票元（トラブル/点検）の表示ラベルと遷移先
const SOURCE_LABELS = { trouble_record: 'トラブル記録', inspection_result: '点検記録' };
const SOURCE_URLS   = { trouble_record: '/pages/trouble?id=', inspection_result: '/pages/inspection?id=' };

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/repair${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 一覧 ----------------

async function renderList(equipmentId) {
  const [{ equipment }, { users }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/users'),
  ]);

  // 設備台帳の「すべて見る」から来た場合はその設備で絞り込む
  const filterEquipment = equipmentId ? String(equipmentId) : '';
  const filterEquipName = filterEquipment
    ? (() => { const e = equipment.find((x) => String(x.id) === filterEquipment); return e ? `${e.code} ${e.name}` : null; })()
    : null;

  let filterStatus = '';
  const listBox = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const sp = new URLSearchParams();
    if (filterStatus) sp.set('status', filterStatus);
    if (filterEquipment) sp.set('equipment_id', filterEquipment);
    const { repairs } = await api.get(`/api/repairs${sp.toString() ? '?' + sp : ''}`);
    if (repairs.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '業務依頼はありません。'));
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

  const statusSel = el('select', { onchange: (e) => { filterStatus = e.target.value; } }, [
    el('option', { value: '' }, '全ステータス'),
    ...Object.entries(STATUS).map(([v, { label }]) => el('option', { value: v }, label)),
  ]);
  const searchBtn = el('button', { class: 'btn btn-primary', onclick: () => load().catch(showError) }, '🔍 検索');

  render(app, [
    filterEquipName
      ? el('div', { class: 'notice' }, [
          `設備「${filterEquipName}」で絞り込み中　`,
          el('a', { href: '/pages/repair' }, 'すべて表示'),
        ])
      : null,
    el('div', { class: 'toolbar' }, [
      statusSel,
      searchBtn,
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 依頼を登録')
        : null,
    ]),
    listBox,
  ]);
  // 開いた時点で全ステータスの一覧を自動表示（ステータスを変えたら「検索」で再絞り込み）
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
  const { repair, files, history, used_parts = [] } = await api.get(`/api/repairs/${id}`);
  const canEdit = hasRole(currentUser, 'editor');
  const s = STATUS[repair.status] || STATUS.open;

  // 使用部品の登録に使う在庫一覧（入力可のときだけ取得）
  let parts = [];
  if (canEdit) {
    try { ({ parts } = await api.get('/api/parts')); } catch { parts = []; }
  }
  const partLabel = (p) =>
    `${p.model_no ? `${p.model_no} ` : ''}${p.name}（在庫${p.quantity}）`;

  // 使用部品カード（出庫＝在庫自動減算 ＋ この依頼に紐づけ）
  const usedPartsBox = el('div', { class: 'row-list' }, []);
  const renderUsedParts = (list) => {
    if (!list || list.length === 0) {
      render(usedPartsBox, el('p', { class: 'empty' }, '使用部品の記録はありません。'));
      return;
    }
    render(usedPartsBox, list.map((u) => {
      // 現在庫を表示（部品待ちの判断に使う）。必要数を下回っていれば要発注を強調。
      const hasStock = u.part_stock != null;
      const isLow = hasStock && u.part_safety_stock != null && u.part_stock < u.part_safety_stock;
      return el('div', { class: 'list-item' }, [
        el('div', { class: 'list-item-main' }, [
          el('div', { class: 'list-item-title' },
            u.part_model_no ? `${u.part_model_no}（${u.part_name}）` : u.part_name),
          el('div', { class: 'list-item-sub' }, [
            `${formatDateTime(u.created_at)} ／ ${maskEmail(u.created_by)}`,
            hasStock ? `　現在庫: ${u.part_stock}` : null,
            isLow ? el('span', { class: 'abn-badge is-abn', style: 'margin-left:6px;font-size:10px;padding:1px 6px' }, '要発注') : null,
          ].filter((x) => x !== null)),
        ]),
        el('span', { class: 'status-badge' }, `${Math.abs(u.quantity)} 個使用`),
      ]);
    }));
  };
  renderUsedParts(used_parts);

  const partSelect = el('select', { style: 'flex:1' },
    [el('option', { value: '' }, '— 部品を選択'),
     ...parts.map((p) => el('option', { value: p.id }, partLabel(p)))]
  );
  const partQty = el('input', { type: 'number', min: '1', value: '1', style: 'width:72px' });
  const addPartBtn = el('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
    const partId = Number(partSelect.value);
    const qty = Number(partQty.value);
    if (!partId) { alert('部品を選択してください。'); return; }
    if (!Number.isInteger(qty) || qty <= 0) { alert('数量は1以上で入力してください。'); return; }
    addPartBtn.disabled = true;
    try {
      await api.post(`/api/parts/${partId}/transaction`, {
        type: 'out',
        quantity: qty,
        related_table: 'repair_request',
        related_id: Number(id),
        note: `業務依頼「${repair.title}」で使用`,
      });
      const fresh = await api.get(`/api/repairs/${id}`);
      renderUsedParts(fresh.used_parts);
      // 在庫が減ったので選択肢の残数表示も更新
      try {
        const { parts: freshParts } = await api.get('/api/parts');
        partSelect.replaceChildren(
          el('option', { value: '' }, '— 部品を選択'),
          ...freshParts.map((p) => el('option', { value: p.id }, partLabel(p)))
        );
      } catch { /* 残数表示の更新失敗は致命的でないため無視 */ }
      partQty.value = '1';
    } catch (err) {
      alert(err.message);
    } finally {
      addPartBtn.disabled = false;
    }
  } }, '記録');

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
    type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true,
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
      // 起票元（トラブル/点検から作成された依頼なら、その記録へ戻れる）
      repair.source_table && repair.source_id
        ? infoRow('起票元', el('a', { href: `${SOURCE_URLS[repair.source_table] || '#'}${repair.source_id}` },
            `${SOURCE_LABELS[repair.source_table] || repair.source_table} #${repair.source_id}`))
        : null,
      repair.description ? el('div', { class: 'note-box' }, repair.description) : null,
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          ...statusBtns,
          // この業務依頼を日報に記録（タイトル・設備・状況・内容を本文へプリフィル＋起票元リンク）
          (() => {
            const date = repair.created_at
              ? new Date(repair.created_at).toLocaleDateString('sv-SE')
              : new Date().toLocaleDateString('sv-SE');
            const q = new URLSearchParams({ new: '1', link_type: 'repair', link_id: String(repair.id), date });
            q.set('body', [
              `【業務依頼】${repair.title}`,
              repair.equipment_name ? `設備: ${`${repair.equipment_code || ''} ${repair.equipment_name}`.trim()}` : null,
              `状況: ${STATUS[repair.status]?.label || repair.status}`,
              repair.description ? `内容: ${repair.description}` : null,
            ].filter(Boolean).join('\n'));
            return el('a', { class: 'btn', href: `/pages/report?${q}` }, '📝 日報に記録');
          })(),
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}`) }, '編集'),
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm('この業務依頼を削除しますか？')) return;
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
      el('h3', { class: 'card-title' }, '使用部品'),
      canEdit
        ? el('div', { class: 'inline-form' }, [partSelect, partQty, addPartBtn])
        : null,
      usedPartsBox,
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
                el('span', {}, maskEmail(h.changed_by)),
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

async function renderForm(existing, prefill = null) {
  const [{ equipment }, { users }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/users'),
  ]);

  // existing = 本物の編集（PUT）。prefill = 点検異常などからの新規プリフィル（POST のまま）。
  const init = existing || prefill || {};
  const f = {
    title: el('input', { type: 'text', value: init.title || '', placeholder: '例: 3号機 ポンプ異音' }),
    equipment_id: buildEquipSelect(equipment, {
      value: init.equipment_id || '',
      allLabel: '設備を選択（任意）',
    }),
    assignee_name: el('input', {
      type: 'text',
      value: init.assignee_name || '',
      placeholder: '担当者名（自由入力・任意）',
      list: 'repair-assignee-options',
    }),
    description: el('textarea', { placeholder: '状況・症状の詳細' }, init.description || ''),
  };
  // 登録済みユーザー名を候補として表示（自由入力は可）
  const assigneeOptions = el('datalist', { id: 'repair-assignee-options' },
    users.map((u) => el('option', { value: u.name || u.email }))
  );

  // 未保存ガード: 入力後にうっかり戻る/再読込しても、離脱前に警告を出す
  const guard = installUnsavedGuard();

  const save = async () => {
    const body = {
      title: f.title.value.trim(),
      equipment_id: f.equipment_id.value ? Number(f.equipment_id.value) : null,
      assignee_name: f.assignee_name.value.trim() || null,
      description: f.description.value.trim() || null,
      // 同時編集ガード: 編集開始時点の updated_at を送り、他の人が先に更新していたら409で知らせる
      ...(existing ? { expected_updated_at: existing.updated_at } : {}),
    };
    // 新規かつ起票元（トラブル/点検）が指定されていれば相互リンクとして保存
    if (!existing && prefill?.source_table && prefill?.source_id) {
      body.source_table = prefill.source_table;
      body.source_id = prefill.source_id;
    }
    if (!body.title) { alert('タイトルは必須です。'); return; }
    try {
      if (existing) {
        await api.put(`/api/repairs/${existing.id}`, body);
        guard.clear();
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/repairs', body);
        guard.clear();
        go(`?id=${id}`);
      }
    } catch (err) {
      // オフライン起因の失敗（新規のみ）は送信待ちキューに保存し、復帰時に自動送信する
      const offline = err?.offline === true || navigator.onLine === false;
      if (offline && !existing) {
        try {
          await enqueueOffline('repair', body);
          guard.clear();
          alert('オフラインのため「送信待ち」に保存しました。\n通信が回復すると自動で送信されます。');
          go('');
          return;
        } catch { /* キュー保存に失敗した場合は通常のエラー表示にフォールバック */ }
      }
      alert(saveErrorMessage(err));
    }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '業務依頼を編集' : '業務依頼を登録'),
      field('タイトル（必須）', f.title),
      el('div', { class: 'field' }, [
        el('label', {}, '設備'),
        el('div', { class: 'inline-form' }, [
          f.equipment_id,
          el('button', {
            type: 'button', class: 'btn btn-sm',
            onclick: () => openQrScanner((eqId) => { f.equipment_id.value = String(eqId); }),
          }, '📷 QR'),
        ]),
      ]),
      el('div', { class: 'field' }, [el('label', {}, '担当者'), f.assignee_name, assigneeOptions]),
      field('詳細・症状', f.description),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', { class: 'btn', onclick: () => { guard.clear(); existing ? go(`?id=${existing.id}`) : go(''); } }, 'キャンセル'),
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
      // 点検異常・トラブルなどからのプリフィル（設備・タイトル・詳細・起票元）を受け取る
      const prefill = {
        equipment_id: Number(params.get('equipment_id')) || null,
        title: params.get('title') || '',
        description: params.get('description') || '',
        source_table: params.get('source_table') || null,
        source_id: Number(params.get('source_id')) || null,
      };
      await renderForm(null, prefill);
    } else {
      await renderList(Number(params.get('equipment_id')) || undefined);
    }
  } catch (err) {
    showError(err);
  }
})();
