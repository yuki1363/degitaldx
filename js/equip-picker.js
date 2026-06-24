// 設備の検索可能ピッカー（設備リストが長くて選びにくい問題の解決）
//   ・buildEquipSelect: 単一選択。datalist で「入力すると候補が絞り込まれる」。
//       返り値は <span> 要素だが .value で設備id（未選択は ''）を読み書きでき、
//       既存の <select> 呼び出し側をほぼそのまま流用できる（.value / change が同じ感覚）。
//   ・buildEquipMultiPicker: 複数選択（点検まとめ入力で使用）。場所(location)でグループ化。
//   code は一意なので「code name」表示文字列から設備idへ一意に逆引きできる。

import { el, render } from '/js/util.js';

const labelOf = (e) => `${e.code} ${e.name}`;
let pickerSeq = 0;

export function buildEquipSelect(equipment, opts = {}) {
  const { value = '', allLabel = 'すべての設備', placeholder, onchange, disabled = false } = opts;
  const byLabel = new Map(equipment.map((e) => [labelOf(e), String(e.id)]));
  const idToLabel = new Map(equipment.map((e) => [String(e.id), labelOf(e)]));

  const listId = `eqp-list-${++pickerSeq}`;
  const datalist = el('datalist', { id: listId }, equipment.map((e) => el('option', { value: labelOf(e) })));
  const input = el('input', {
    type: 'text', list: listId, class: 'equip-picker', autocomplete: 'off', inputmode: 'search',
    placeholder: placeholder || `${allLabel}（入力で絞り込み）`,
    disabled,
  });
  const wrap = el('span', { class: 'equip-picker-wrap' }, [input, datalist]);

  const resolve = () => {
    const t = input.value.trim();
    const id = t === '' ? '' : (byLabel.get(t) || '');
    input.classList.toggle('is-unmatched', t !== '' && id === '');
    return id;
  };

  Object.defineProperty(wrap, 'value', {
    configurable: true,
    get() { return resolve(); },
    set(v) {
      const id = (v == null || v === '') ? '' : String(v);
      input.value = id === '' ? '' : (idToLabel.get(id) || '');
      resolve();
    },
  });

  // フォーカスで全選択 → すぐ別の設備を探せる
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', () => {
    resolve();
    if (onchange) onchange({ target: wrap });
  });

  if (value) wrap.value = value;
  return wrap;
}

export function buildEquipMultiPicker(equipment, opts = {}) {
  const { selectedIds = [], onChange } = opts;
  const selected = new Set(selectedIds.map(String));

  const filterInput = el('input', {
    type: 'text', class: 'equip-multi-filter', inputmode: 'search', autocomplete: 'off',
    placeholder: '設備を絞り込み…',
  });
  const countEl = el('span', { class: 'equip-multi-count hint' }, '選択中: 0件');
  const listBox = el('div', { class: 'equip-multi-list' }, []);

  // 場所(location)でグループ化（無ければ「その他」）
  const groups = new Map();
  for (const e of equipment) {
    const key = (e.location && e.location.trim()) || 'その他';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const getSelected = () => equipment.filter((e) => selected.has(String(e.id))).map((e) => e.id);
  const updateCount = () => { countEl.textContent = `選択中: ${selected.size}件`; };

  const renderList = () => {
    const q = filterInput.value.trim().toLowerCase();
    const rows = [];
    for (const [loc, items] of groups) {
      const matched = items.filter((e) => !q || labelOf(e).toLowerCase().includes(q));
      if (matched.length === 0) continue;
      const allOn = matched.every((e) => selected.has(String(e.id)));
      const toggleAll = el('button', {
        type: 'button', class: 'btn btn-sm equip-multi-grouptoggle',
        onclick: () => {
          matched.forEach((e) => { if (allOn) selected.delete(String(e.id)); else selected.add(String(e.id)); });
          renderList(); updateCount(); if (onChange) onChange(getSelected());
        },
      }, allOn ? '解除' : '全選択');
      rows.push(el('div', { class: 'equip-multi-group' }, [el('span', {}, `📍 ${loc}`), toggleAll]));
      for (const e of matched) {
        const cb = el('input', {
          type: 'checkbox', checked: selected.has(String(e.id)),
          onchange: () => {
            if (cb.checked) selected.add(String(e.id)); else selected.delete(String(e.id));
            updateCount(); if (onChange) onChange(getSelected());
          },
        });
        rows.push(el('label', { class: 'equip-multi-item' }, [cb, ` ${labelOf(e)}`]));
      }
    }
    if (rows.length === 0) rows.push(el('p', { class: 'hint', style: 'padding:8px' }, '該当する設備がありません。'));
    render(listBox, rows);
  };

  filterInput.addEventListener('input', renderList);
  renderList(); updateCount();

  const element = el('div', { class: 'equip-multi' }, [
    el('div', { class: 'equip-multi-head' }, [filterInput, countEl]),
    listBox,
  ]);

  return {
    element,
    getSelected,
    setSelected: (ids) => { selected.clear(); ids.forEach((i) => selected.add(String(i))); renderList(); updateCount(); },
  };
}
