// 02 点検まとめ入力 — 複数設備をまとめて点検入力・一括保存・PDF（レポート）へ誘導
//   URL: /pages/inspection-batch
//   流れ: 対象設備を複数選択 → 点検項目を読み込み → 各設備のチェックリスト入力 → 一括保存

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, nowLocalInputValue, localInputToIso } from '/js/util.js';
import { buildEquipMultiPicker } from '/js/equip-picker.js';
import { buildItemInput } from '/js/inspection-items.js';

const app = document.getElementById('app');
let currentUser = null;

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

async function renderPage() {
  if (!hasRole(currentUser, 'editor')) throw new Error('点検を記録する権限がありません。');

  const [{ equipment }, { users }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/users'),
  ]);
  if (equipment.length === 0) {
    render(app, el('p', { class: 'notice' }, '設備が未登録です。先に設備台帳から設備を登録してください。'));
    return;
  }

  // 共通項目（全設備で同じ実施日時・担当者）
  const datetimeInput = el('input', { type: 'datetime-local', value: nowLocalInputValue() });
  const assigneeInput = el('input', { type: 'text', placeholder: '担当者名（自由入力）', list: 'batch-assignee-options' });
  const assigneeOptions = el('datalist', { id: 'batch-assignee-options' }, users.map((u) => el('option', { value: u.name })));

  // 対象設備の複数選択（場所でグループ化・絞り込み可）
  const picker = buildEquipMultiPicker(equipment, {});

  const checklistArea = el('div', {});
  const saveBox = el('div', {});
  let entryCards = []; // [{ equipmentId, equipment, itemInputs|null }]

  const loadChecklists = async () => {
    const ids = picker.getSelected();
    if (ids.length === 0) { alert('点検する設備を1つ以上選択してください。'); return; }
    render(checklistArea, el('p', { class: 'loading' }, '点検項目を読み込み中…'));
    render(saveBox, []);
    entryCards = [];

    const cards = [];
    for (const id of ids) {
      const eq = equipment.find((e) => e.id === id);
      const { masters } = await api.get(`/api/inspections/masters?equipment_id=${id}`);
      if (!masters || masters.length === 0) {
        entryCards.push({ equipmentId: id, equipment: eq, itemInputs: null });
        cards.push(el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, `${eq.code} ${eq.name}`),
          el('p', { class: 'notice is-warning' }, 'この設備には点検項目が登録されていません（保存時はスキップされます）。'),
        ]));
        continue;
      }
      const itemInputs = masters.map((m) => buildItemInput(m));
      entryCards.push({ equipmentId: id, equipment: eq, itemInputs });
      cards.push(el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, `${eq.code} ${eq.name}`),
        ...itemInputs.map((i) => i.box),
      ]));
    }
    render(checklistArea, cards);

    const saveBtn = el('button', { class: 'btn btn-primary' }, '💾 まとめて保存');
    saveBtn.addEventListener('click', () => save(saveBtn));
    render(saveBox, el('div', { class: 'action-row' }, [saveBtn]));
  };

  const save = async (saveBtn) => {
    const valid = entryCards.filter((c) => c.itemInputs);
    if (valid.length === 0) { alert('保存できる設備（点検項目あり）がありません。'); return; }
    const inspectedAt = localInputToIso(datetimeInput.value);
    if (!inspectedAt) { alert('実施日時を入力してください。'); return; }

    const entries = [];
    for (const c of valid) {
      const items = [];
      for (const i of c.itemInputs) {
        const value = i.getValue();
        if (value === undefined && i.master.input_type !== 'text') {
          alert(`「${c.equipment.code} ${c.equipment.name}」の「${i.master.name}」が未入力です。`);
          return;
        }
        items.push({ master_id: i.master.id, value: value === undefined ? '' : value });
      }
      entries.push({ equipment_id: c.equipmentId, items });
    }

    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const res = await api.post('/api/inspections/batch', {
        inspected_at: inspectedAt,
        assignee_name: assigneeInput.value.trim() || null,
        entries,
      });
      const dateStr = datetimeInput.value.slice(0, 10);
      const anyAbn = (res.saved || []).some((s) => s.has_abnormal);
      render(app, [
        el('div', { class: 'card' }, [
          el('h2', { class: 'card-title' }, '✅ まとめて保存しました'),
          el('p', {}, `${res.count}件の設備の点検記録を登録しました。`),
          anyAbn ? el('p', { class: 'notice is-warning' }, '⚠ 異常値（基準範囲外 / NG）を含む記録があります。内容を確認してください。') : null,
          el('div', { class: 'action-row' }, [
            el('a', { class: 'btn btn-primary', href: `/pages/inspection-report?from=${dateStr}&to=${dateStr}` }, '🖨 PDF / レポート出力'),
            el('a', { class: 'btn', href: '/pages/inspection' }, '点検一覧へ'),
            el('a', { class: 'btn', href: '/pages/inspection-batch' }, '続けてまとめ入力'),
          ]),
        ]),
      ]);
    } catch (err) {
      alert(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 まとめて保存';
    }
  };

  const loadBtn = el('button', { class: 'btn btn-primary' }, '点検項目を読み込む');
  loadBtn.addEventListener('click', () => loadChecklists().catch(showError));

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, '点検まとめ入力'),
      el('p', { class: 'hint' }, '複数の設備をまとめて点検入力できます。設備を選んで「点検項目を読み込む」を押してください。実施日時・担当者は全設備で共通です。'),
      el('div', { class: 'field' }, [el('label', {}, '実施日時'), datetimeInput]),
      el('div', { class: 'field' }, [el('label', {}, '担当者（全設備共通）'), assigneeInput, assigneeOptions]),
      el('div', { class: 'field' }, [el('label', {}, '対象の設備（複数選択）'), picker.element]),
      el('div', { class: 'action-row' }, [loadBtn]),
    ]),
    checklistArea,
    saveBox,
  ]);
}

(async () => {
  try {
    currentUser = await getCurrentUser();
    await renderPage();
  } catch (err) {
    showError(err);
  }
})();
