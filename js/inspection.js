// 02 点検実施 — チェックリスト入力（異常値アラート）・写真添付・一覧・詳細・点検項目マスタ管理
//   URL: /pages/inspection                 … 一覧（設備・期間で絞り込み）
//        /pages/inspection?id=N            … 詳細
//        /pages/inspection?new=1[&equipment_id=N] … 新規入力
//        /pages/inspection?edit=N          … 編集
//        /pages/inspection?masters=EQID    … 点検項目マスタ管理（admin）
//        /pages/inspection?equipment_id=N  … 一覧（設備で絞り込み済み）

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { uploadFile, resizeImageFile } from '/js/files.js';
import {
  el, render, formatDateTime, nowLocalInputValue, isoToLocalInputValue, localInputToIso,
  ACTION_LABELS,
} from '/js/util.js';
import { buildCommentsCard } from '/js/comments.js';

const INPUT_TYPE_LABELS = { ok_ng: 'OK / NG', number: '数値', select: '選択式', text: '自由記述' };

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/inspection${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

function abnBadge(isAbnormal) {
  return el('span', { class: isAbnormal ? 'abn-badge is-abn' : 'abn-badge' }, isAbnormal ? '異常あり' : '正常');
}

// ---------------- 一覧 ----------------

async function renderList(presetEquipmentId) {
  const { equipment } = await api.get('/api/equipment');
  const equipmentSelect = el('select', {}, [
    el('option', { value: '' }, 'すべての設備'),
    equipment.map((eq) =>
      el('option', { value: eq.id, selected: presetEquipmentId === eq.id }, `${eq.code} ${eq.name}`)
    ),
  ]);
  const fromInput = el('input', { type: 'date' });
  const toInput = el('input', { type: 'date' });
  const listBox = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const params = new URLSearchParams();
    if (equipmentSelect.value) params.set('equipment_id', equipmentSelect.value);
    if (fromInput.value) params.set('from', fromInput.value);
    if (toInput.value) params.set('to', toInput.value);
    const qs = params.toString();
    const { inspections } = await api.get(`/api/inspections${qs ? `?${qs}` : ''}`);
    if (inspections.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '点検記録がありません。'));
      return;
    }
    render(
      listBox,
      inspections.map((r) =>
        el('a', { class: 'list-item', href: `/pages/inspection?id=${r.id}` }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-title' }, formatDateTime(r.inspected_at)),
            el('div', { class: 'list-item-sub' }, `${r.equipment_code} ${r.equipment_name}`),
            el('div', { class: 'list-item-sub' }, `担当: ${r.assignee_name || '未設定'}`),
          ]),
          abnBadge(r.has_abnormal === 1),
        ])
      )
    );
  };

  equipmentSelect.addEventListener('change', () => load().catch(showError));
  fromInput.addEventListener('change', () => load().catch(showError));
  toInput.addEventListener('change', () => load().catch(showError));

  render(app, [
    el('div', { class: 'toolbar' }, [
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 点検を記録')
        : null,
    ]),
    el('div', { class: 'card filter-bar' }, [
      el('div', { class: 'field' }, [el('label', {}, '設備'), equipmentSelect]),
      el('div', { class: 'field-pair' }, [
        el('div', { class: 'field' }, [el('label', {}, '開始日'), fromInput]),
        el('div', { class: 'field' }, [el('label', {}, '終了日'), toInput]),
      ]),
    ]),
    listBox,
  ]);
  await load();
}

// ---------------- 入力フォーム（新規・編集） ----------------

/** 1項目分の入力UIを作る。getValue() は未入力なら undefined を返す */
function buildItemInput(master, existingValue) {
  const limits =
    master.input_type === 'number' && (master.min_value !== null || master.max_value !== null)
      ? `基準: ${master.min_value ?? ''} 〜 ${master.max_value ?? ''} ${master.unit || ''}`
      : '';
  const warn = el('p', { class: 'warn-text', hidden: true }, '⚠ 基準範囲外です。確認してください。');
  let getValue;
  let inputArea;

  switch (master.input_type) {
    case 'ok_ng': {
      let value = existingValue;
      const okBtn = el('button', { type: 'button', class: 'okng-btn' }, 'OK');
      const ngBtn = el('button', { type: 'button', class: 'okng-btn' }, 'NG');
      const update = () => {
        okBtn.classList.toggle('selected-ok', value === 'ok');
        ngBtn.classList.toggle('selected-ng', value === 'ng');
        warn.hidden = value !== 'ng';
        warn.textContent = '⚠ NG項目です。状況をメモ・写真で残してください。';
      };
      okBtn.addEventListener('click', () => { value = 'ok'; update(); });
      ngBtn.addEventListener('click', () => { value = 'ng'; update(); });
      update();
      inputArea = el('div', { class: 'okng-row' }, [okBtn, ngBtn]);
      getValue = () => value;
      break;
    }
    case 'number': {
      const input = el('input', {
        type: 'number', step: 'any', inputmode: 'decimal',
        value: existingValue !== undefined ? existingValue : '',
        oninput: () => {
          const v = Number(input.value);
          const out =
            input.value !== '' && Number.isFinite(v) &&
            ((master.min_value !== null && v < master.min_value) ||
             (master.max_value !== null && v > master.max_value));
          input.classList.toggle('is-abnormal', out);
          warn.hidden = !out;
          warn.textContent = '⚠ 基準範囲外です。確認してください。';
        },
      });
      if (existingValue !== undefined) input.dispatchEvent(new Event('input'));
      inputArea = el('div', { class: 'number-row' }, [
        input,
        master.unit ? el('span', { class: 'unit' }, master.unit) : null,
      ]);
      // 初期値の異常表示
      setTimeout(() => input.dispatchEvent(new Event('input')), 0);
      getValue = () => (input.value === '' ? undefined : Number(input.value));
      break;
    }
    case 'select': {
      const options = master.options_json ? JSON.parse(master.options_json) : [];
      const select = el('select', {}, [
        el('option', { value: '' }, '選択してください'),
        options.map((o) => el('option', { value: o, selected: existingValue === o }, o)),
      ]);
      inputArea = select;
      getValue = () => (select.value === '' ? undefined : select.value);
      break;
    }
    default: {
      const input = el('input', { type: 'text', value: existingValue !== undefined ? existingValue : '' });
      inputArea = input;
      getValue = () => input.value.trim();
    }
  }

  const box = el('div', { class: 'check-item' }, [
    el('div', { class: 'check-item-name' }, [
      master.name,
      limits ? el('span', { class: 'hint' }, ` （${limits.trim()}）`) : null,
    ]),
    inputArea,
    warn,
  ]);
  return { box, getValue, master };
}

async function renderEntry({ equipmentId, existing, planId }) {
  if (!hasRole(currentUser, 'editor')) throw new Error('点検を記録する権限がありません。');

  const [{ equipment }, { users }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/users'),
  ]);
  if (equipment.length === 0) {
    render(app, el('p', { class: 'notice' }, '設備が未登録です。先に設備台帳から設備を登録してください。'));
    return;
  }

  const checklistBox = el('div', {}, []);
  let itemInputs = [];

  const equipmentSelect = el('select', { disabled: Boolean(existing) },
    equipment.map((eq) =>
      el('option', {
        value: eq.id,
        selected: existing ? eq.id === existing.equipment_id : eq.id === equipmentId,
      }, `${eq.code} ${eq.name}`)
    )
  );

  const loadChecklist = async () => {
    const eqId = Number(equipmentSelect.value);
    render(checklistBox, el('p', { class: 'loading' }, '点検項目を読み込み中…'));
    const { masters } = await api.get(`/api/inspections/masters?equipment_id=${eqId}`);
    if (masters.length === 0) {
      itemInputs = [];
      render(checklistBox, [
        el('p', { class: 'notice is-warning' }, 'この設備には点検項目が登録されていません。'),
        hasRole(currentUser, 'admin')
          ? el('a', { class: 'btn', href: `/pages/inspection?masters=${eqId}` }, '点検項目を登録する')
          : el('p', { class: 'hint' }, '管理者に点検項目の登録を依頼してください。'),
      ]);
      return;
    }
    const existingValues = new Map(
      existing ? existing.items.map((i) => [i.master_id, i.value]) : []
    );
    itemInputs = masters.map((m) => buildItemInput(m, existingValues.get(m.id)));
    render(checklistBox, itemInputs.map((i) => i.box));
  };
  equipmentSelect.addEventListener('change', () => loadChecklist().catch(showError));

  // 担当者は自由入力（既定はログインユーザー名）。登録済みユーザー名は候補として表示。
  const assigneeInput = el('input', {
    type: 'text',
    value: existing ? (existing.assignee_name || '') : (currentUser.name || ''),
    placeholder: '担当者名（自由入力）',
    list: 'inspection-assignee-options',
  });
  const assigneeOptions = el('datalist', { id: 'inspection-assignee-options' },
    users.map((u) => el('option', { value: u.name }))
  );
  const datetimeInput = el('input', {
    type: 'datetime-local',
    value: existing ? isoToLocalInputValue(existing.inspected_at) : nowLocalInputValue(),
  });
  const noteInput = el('textarea', { value: existing?.note || '', placeholder: '気づいた点があれば記入' });

  // 写真・動画
  const pendingFiles = [];
  const fileListBox = el('div', { class: 'row-list' }, []);
  const renderPending = () => {
    render(
      fileListBox,
      pendingFiles.map((f, idx) =>
        el('div', { class: 'file-row' }, [
          el('span', { class: 'file-name' }, f.name),
          el('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: () => { pendingFiles.splice(idx, 1); renderPending(); },
          }, '外す'),
        ])
      )
    );
  };
  const fileInput = el('input', {
    type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true,
    onchange: (e) => {
      for (const f of e.target.files) pendingFiles.push(f);
      renderPending();
      e.target.value = '';
    },
  });

  const saveBtn = el('button', { class: 'btn btn-primary' }, existing ? '更新する' : '保存する');
  saveBtn.addEventListener('click', async () => {
    if (itemInputs.length === 0) {
      alert('点検項目がありません。');
      return;
    }
    const items = [];
    for (const i of itemInputs) {
      const value = i.getValue();
      if (value === undefined && i.master.input_type !== 'text') {
        alert(`「${i.master.name}」が未入力です。`);
        return;
      }
      items.push({ master_id: i.master.id, value: value === undefined ? '' : value });
    }
    const inspectedAt = localInputToIso(datetimeInput.value);
    if (!inspectedAt) {
      alert('実施日時を入力してください。');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      // 写真・動画を先にアップロード（画像はリサイズ=EXIF除去）
      const fileIds = [];
      for (const f of pendingFiles) {
        saveBtn.textContent = `写真を送信中… (${fileIds.length + 1}/${pendingFiles.length})`;
        const prepared = await resizeImageFile(f);
        const meta = await uploadFile(prepared, {});
        fileIds.push(meta.id);
      }
      saveBtn.textContent = '保存中…';
      const body = {
        equipment_id: Number(equipmentSelect.value),
        assignee_name: assigneeInput.value.trim() || null,
        inspected_at: inspectedAt,
        note: noteInput.value.trim(),
        items,
        file_ids: fileIds,
      };
      const result = existing
        ? await api.put(`/api/inspections/${existing.id}`, body)
        : await api.post('/api/inspections', body);
      // 保全計画から開始した点検なら、保存成功時にその計画を自動で完了にする
      if (!existing && planId) {
        try { await api.put(`/api/plans/${planId}`, { status: 'done' }); }
        catch { /* 計画の完了化に失敗しても点検記録は保存済みなので継続 */ }
      }
      if (result.has_abnormal) {
        alert('⚠ 異常値を含む記録として保存しました。必要に応じて修理依頼・トラブル記録を起票してください。');
      }
      go(`?id=${existing ? existing.id : result.id}`);
    } catch (err) {
      alert(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = existing ? '更新する' : '保存する';
    }
  });

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '点検記録を編集' : '点検を記録'),
      el('div', { class: 'field' }, [el('label', {}, '設備'), equipmentSelect]),
      el('div', { class: 'field' }, [el('label', {}, '担当者'), assigneeInput, assigneeOptions]),
      el('div', { class: 'field' }, [el('label', {}, '実施日時'), datetimeInput]),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '点検項目'),
      checklistBox,
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, 'メモ・写真'),
      el('div', { class: 'field' }, [el('label', {}, 'メモ'), noteInput]),
      el('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, '📷 写真・動画を追加'),
      fileInput,
      fileListBox,
    ]),
    el('div', { class: 'action-row' }, [
      saveBtn,
      el('button', { class: 'btn', onclick: () => (existing ? go(`?id=${existing.id}`) : go('')) }, 'キャンセル'),
    ]),
  ]);
  await loadChecklist();
}

// ---------------- 詳細 ----------------

function formatItemValue(item) {
  if (item.input_type === 'ok_ng') return item.value === 'ok' ? 'OK' : 'NG';
  if (item.input_type === 'number') return `${item.value}${item.unit ? ` ${item.unit}` : ''}`;
  return String(item.value || '—');
}

const REPAIR_STATUS_LABELS = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };

async function renderDetail(id) {
  const { inspection, files, history } = await api.get(`/api/inspections/${id}`);
  // この点検から作成された業務依頼（相互リンクの逆引き）。列未追加環境でも落ちないよう握りつぶす。
  const { repairs: linkedRepairs = [] } =
    await api.get(`/api/repairs?source_table=inspection_result&source_id=${id}`).catch(() => ({ repairs: [] }));
  const canEdit = hasRole(currentUser, 'editor');

  const images = files.filter((f) => f.content_type.startsWith('image/'));
  const others = files.filter((f) => !f.content_type.startsWith('image/'));

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, formatDateTime(inspection.inspected_at)),
        abnBadge(inspection.has_abnormal === 1),
      ]),
      el('div', { class: 'list-item-sub' }, [
        el('a', { href: `/pages/ledger?id=${inspection.equipment_id}` },
          `${inspection.equipment_code} ${inspection.equipment_name}`),
      ]),
      el('div', { class: 'list-item-sub' }, `担当: ${inspection.assignee_name || '未設定'} ／ 記録者: ${inspection.created_by}`),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '点検結果'),
      el('div', { class: 'row-list' },
        inspection.items.map((item) =>
          el('div', { class: item.abnormal ? 'result-row is-abn' : 'result-row' }, [
            el('span', { class: 'result-name' }, item.name),
            el('span', { class: 'result-value' }, [
              formatItemValue(item),
              item.abnormal ? el('span', { class: 'abn-mark' }, ' ⚠') : null,
            ]),
          ])
        )
      ),
      inspection.note ? el('p', { class: 'note-box' }, inspection.note) : null,
    ]),
    // 異常あり → その場で業務依頼・トラブル記録を作成（設備・異常内容をプリフィル）
    inspection.has_abnormal === 1 && canEdit
      ? (() => {
          const summary = inspection.items
            .filter((it) => it.abnormal)
            .map((it) => `${it.name}: ${formatItemValue(it)}`)
            .join('、');
          const when = formatDateTime(inspection.inspected_at);
          const repairQuery = new URLSearchParams({
            new: '1',
            source_table: 'inspection_result',
            source_id: String(inspection.id),
            equipment_id: String(inspection.equipment_id),
            title: `【点検異常】${inspection.equipment_name}`,
            description: `${when} の点検で異常を検知しました。\n異常項目: ${summary}`,
          });
          const troubleQuery = new URLSearchParams({
            new: '1',
            equipment_id: String(inspection.equipment_id),
            phenomenon: `点検異常（${when}）: ${summary}`,
          });
          return el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, '⚠ 異常への対応'),
            el('p', { class: 'list-item-sub' }, `異常項目: ${summary}`),
            el('div', { class: 'action-row' }, [
              el('a', { class: 'btn btn-primary', href: `/pages/repair?${repairQuery}` }, '🔧 業務依頼を作成'),
              el('a', { class: 'btn', href: `/pages/trouble?${troubleQuery}` }, '⚠ トラブルを記録'),
            ]),
          ]);
        })()
      : null,
    images.length > 0 || others.length > 0
      ? el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, '写真・動画'),
          images.length > 0
            ? el('div', { class: 'thumb-grid' },
                images.map((f) =>
                  el('a', { href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, [
                    el('img', { class: 'thumb', src: `/api/files/${f.id}`, alt: f.file_name, loading: 'lazy' }),
                  ])
                )
              )
            : null,
          others.length > 0
            ? el('div', { class: 'row-list' },
                others.map((f) =>
                  el('div', { class: 'file-row' }, [
                    el('a', { class: 'file-name', href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, `🎬 ${f.file_name}`),
                  ])
                )
              )
            : null,
        ])
      : null,
    // この点検から作成された業務依頼（あれば対応状況まで辿れる）
    linkedRepairs.length > 0
      ? el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, 'この点検から作成された業務依頼'),
          el('div', { class: 'row-list' },
            linkedRepairs.map((r) =>
              el('a', { class: 'list-item', href: `/pages/repair?id=${r.id}` }, [
                el('div', { class: 'list-item-main' }, [
                  el('div', { class: 'list-item-title' }, r.title),
                  el('div', { class: 'list-item-sub' }, formatDateTime(r.created_at)),
                ]),
                el('span', { class: `status-badge is-${r.status}` }, REPAIR_STATUS_LABELS[r.status] || r.status),
              ])
            )
          ),
        ])
      : null,
    el('div', { class: 'action-row' }, [
      canEdit
        ? (() => {
            const date = inspection.inspected_at
              ? new Date(inspection.inspected_at).toLocaleDateString('sv-SE')
              : new Date().toLocaleDateString('sv-SE');
            const q = new URLSearchParams({ new: '1', link_type: 'inspection', link_id: String(inspection.id), date });
            return el('a', { class: 'btn', href: `/pages/report?${q}` }, '📝 日報に記録');
          })()
        : null,
      canEdit ? el('button', { class: 'btn', onclick: () => go(`?edit=${inspection.id}`) }, '編集') : null,
      canEdit
        ? el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm('この点検記録を削除しますか？\n（削除済みデータは管理画面から復元できます）')) return;
              await api.del(`/api/inspections/${inspection.id}`);
              go('');
            },
          }, '削除')
        : null,
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '変更履歴'),
      el('div', { class: 'row-list' },
        history.map((h) =>
          el('div', { class: 'history-row' }, [
            el('span', { class: `action-badge is-${h.action}` }, ACTION_LABELS[h.action] || h.action),
            el('span', {}, h.changed_by),
            el('span', { class: 'list-item-sub' }, formatDateTime(h.changed_at)),
          ])
        )
      ),
    ]),
    buildCommentsCard('inspection_result', inspection.id, currentUser),
  ]);
}

// ---------------- 点検項目マスタ管理（admin） ----------------

async function renderMasters(equipmentId) {
  if (!hasRole(currentUser, 'admin')) throw new Error('点検項目の管理は管理者のみ行えます。');
  const { equipment: eq } = await api.get(`/api/equipment/${equipmentId}`);
  const listBox = el('div', { class: 'row-list' }, []);
  const formBox = el('div', {}, []);

  const buildForm = (existing) => {
    const f = {
      name: el('input', { type: 'text', value: existing?.name || '', placeholder: '例: 吐出圧力' }),
      input_type: el('select', {},
        Object.entries(INPUT_TYPE_LABELS).map(([value, label]) =>
          el('option', { value, selected: existing ? existing.input_type === value : value === 'ok_ng' }, label)
        )
      ),
      unit: el('input', { type: 'text', value: existing?.unit || '', placeholder: '例: MPa' }),
      min_value: el('input', { type: 'number', step: 'any', value: existing?.min_value ?? '' }),
      max_value: el('input', { type: 'number', step: 'any', value: existing?.max_value ?? '' }),
      options: el('input', {
        type: 'text',
        value: existing?.options_json ? JSON.parse(existing.options_json).join('、') : '',
        placeholder: '例: 良好、やや劣化、要交換',
      }),
      sort_order: el('input', { type: 'number', value: existing?.sort_order ?? 0 }),
    };
    const numberFields = el('div', { class: 'field-pair' }, [
      el('div', { class: 'field' }, [el('label', {}, '下限値'), f.min_value]),
      el('div', { class: 'field' }, [el('label', {}, '上限値'), f.max_value]),
    ]);
    const unitField = el('div', { class: 'field' }, [el('label', {}, '単位'), f.unit]);
    const optionsField = el('div', { class: 'field' }, [el('label', {}, '選択肢（読点・カンマ区切り）'), f.options]);
    const toggle = () => {
      const t = f.input_type.value;
      numberFields.hidden = t !== 'number';
      unitField.hidden = t !== 'number';
      optionsField.hidden = t !== 'select';
    };
    f.input_type.addEventListener('change', toggle);
    toggle();

    const save = async () => {
      const body = {
        equipment_id: Number(equipmentId),
        name: f.name.value.trim(),
        input_type: f.input_type.value,
        unit: f.unit.value.trim() || null,
        min_value: f.min_value.value === '' ? null : Number(f.min_value.value),
        max_value: f.max_value.value === '' ? null : Number(f.max_value.value),
        options: f.options.value.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
        sort_order: Number(f.sort_order.value) || 0,
      };
      if (!body.name) {
        alert('項目名は必須です。');
        return;
      }
      try {
        if (existing) {
          await api.put(`/api/inspections/masters/${existing.id}`, body);
        } else {
          await api.post('/api/inspections/masters', body);
        }
        render(formBox, []);
        await loadList();
      } catch (err) {
        alert(err.message);
      }
    };

    return el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, existing ? `項目を編集: ${existing.name}` : '項目を追加'),
      el('div', { class: 'field' }, [el('label', {}, '項目名（必須）'), f.name]),
      el('div', { class: 'field' }, [el('label', {}, '入力方式'), f.input_type]),
      unitField,
      numberFields,
      optionsField,
      el('div', { class: 'field' }, [el('label', {}, '表示順'), f.sort_order]),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', { class: 'btn', onclick: () => render(formBox, []) }, 'キャンセル'),
      ]),
    ]);
  };

  const loadList = async () => {
    const { masters } = await api.get(`/api/inspections/masters?equipment_id=${equipmentId}`);
    render(
      listBox,
      masters.length === 0
        ? el('p', { class: 'empty' }, '点検項目はまだありません。「項目を追加」から登録してください。')
        : masters.map((m) =>
            el('div', { class: 'list-item' }, [
              el('div', { class: 'list-item-main' }, [
                el('div', { class: 'list-item-title' }, m.name),
                el('div', { class: 'list-item-sub' }, [
                  INPUT_TYPE_LABELS[m.input_type] || m.input_type,
                  m.input_type === 'number' && (m.min_value !== null || m.max_value !== null)
                    ? ` ／ 基準: ${m.min_value ?? ''} 〜 ${m.max_value ?? ''} ${m.unit || ''}`
                    : '',
                  m.options_json ? ` ／ ${JSON.parse(m.options_json).join(' / ')}` : '',
                ]),
              ]),
              el('div', { class: 'btn-group' }, [
                el('button', { class: 'btn btn-sm', onclick: () => render(formBox, buildForm(m)) }, '編集'),
                el('button', {
                  class: 'btn btn-sm btn-danger',
                  onclick: async () => {
                    if (!confirm(`点検項目「${m.name}」を削除しますか？\n（変更前の内容は master_history に保存され、復元できます）`)) return;
                    await api.del(`/api/inspections/masters/${m.id}`);
                    await loadList();
                  },
                }, '削除'),
              ]),
            ])
          )
    );
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, `点検項目の管理`),
      el('div', { class: 'list-item-sub' }, [
        el('a', { href: `/pages/ledger?id=${eq.id}` }, `${eq.code} ${eq.name}`),
      ]),
      el('p', { class: 'hint' }, '項目の追加・変更・削除はすべて履歴（master_history）に保存され、後から復元できます。'),
    ]),
    el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-primary', onclick: () => render(formBox, buildForm(null)) }, '＋ 項目を追加'),
    ]),
    formBox,
    listBox,
  ]);
  await loadList();
}

// ---------------- 起動 ----------------

(async () => {
  try {
    currentUser = await getCurrentUser();
    const params = new URLSearchParams(window.location.search);
    if (params.get('id')) {
      await renderDetail(Number(params.get('id')));
    } else if (params.get('edit')) {
      const { inspection } = await api.get(`/api/inspections/${Number(params.get('edit'))}`);
      await renderEntry({ existing: inspection });
    } else if (params.get('new')) {
      await renderEntry({
        equipmentId: Number(params.get('equipment_id')) || undefined,
        planId: Number(params.get('plan_id')) || undefined,
      });
    } else if (params.get('masters')) {
      await renderMasters(Number(params.get('masters')));
    } else {
      await renderList(Number(params.get('equipment_id')) || undefined);
    }
  } catch (err) {
    showError(err);
  }
})();
