// 使用部品（部品在庫から選んで、使った数ぶん在庫を自動で減らし、その記録に紐づける）
//   業務依頼（03）の「使用部品」と同じ仕組み＝入出庫API（POST /api/parts/:id/transaction・type=out・related_table）。
//   トラブル記録（04）の入力画面・詳細画面で使う。
import { api } from '/js/api.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';

const MAX_QTY = 1000000; // functions/api/_lib/parts-limits.js の MAX_PART_QTY と同じ

export const newTxId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

export const partLabel = (p) => `${p.model_no ? `${p.model_no} ` : ''}${p.name}（在庫${p.quantity}）`;

/** 部品の検索つきピッカー。.part（選択中の部品 or null）。入力で候補が絞り込まれる */
export function buildPartPicker(parts) {
  let seq = 0;
  const listId = `part-picker-${Date.now()}-${++seq}`;
  const byLabel = new Map();
  const labels = parts.map((p) => {
    let l = partLabel(p);
    if (byLabel.has(l)) l = `${l} #${p.id}`; // 同じ型番・名前・在庫の部品があっても一意にする
    byLabel.set(l, p);
    return l;
  });
  const datalist = el('datalist', { id: listId }, labels.map((l) => el('option', { value: l })));
  const input = el('input', {
    type: 'text', list: listId, autocomplete: 'off', inputmode: 'search', class: 'equip-picker',
    placeholder: '部品名・型番で検索して選択', style: 'flex:1;min-width:0',
  });
  input.addEventListener('focus', () => input.select());
  const wrap = el('span', { class: 'equip-picker-wrap', style: 'flex:1;min-width:0' }, [input, datalist]);
  Object.defineProperty(wrap, 'part', { get() { return byLabel.get(input.value.trim()) || null; } });
  wrap.clear = () => { input.value = ''; };
  wrap.hasText = () => input.value.trim() !== '';
  return wrap;
}

/** 数量の検証。OKなら整数、だめなら null（メッセージは alert で出す） */
export function checkQty(part, qty) {
  if (!Number.isInteger(qty) || qty <= 0) { alert('数量は1以上の整数で入力してください。'); return null; }
  if (qty > MAX_QTY) { alert(`数量は${MAX_QTY.toLocaleString()}以下で入力してください。`); return null; }
  if (qty > part.quantity) { alert(`在庫が足りません（在庫${part.quantity}個）。部品在庫で入庫を記録してから選んでください。`); return null; }
  return qty;
}

/** 使用部品の一覧（記録済み）を box に描く。list は GET /api/troubles/:id の used_parts */
export function renderUsedList(box, list, emptyText = '使用部品の記録はありません。') {
  if (!list || list.length === 0) { render(box, el('p', { class: 'empty' }, emptyText)); return; }
  render(box, list.map((u) => {
    const isLow = u.part_stock != null && u.part_safety_stock != null && u.part_stock < u.part_safety_stock;
    return el('div', { class: 'list-item' }, [
      el('div', { class: 'list-item-main' }, [
        el('div', { class: 'list-item-title' }, u.part_model_no ? `${u.part_model_no}（${u.part_name}）` : u.part_name),
        el('div', { class: 'list-item-sub' }, [
          `${formatDateTime(u.created_at)} ／ ${maskEmail(u.created_by)}`,
          u.part_stock != null ? `　現在庫: ${u.part_stock}` : null,
          isLow ? el('span', { class: 'abn-badge is-abn', style: 'margin-left:6px;font-size:10px;padding:1px 6px' }, '要発注') : null,
        ].filter((x) => x !== null)),
      ]),
      el('span', { class: 'status-badge' }, `${Math.abs(u.quantity)} 個使用`),
    ]);
  }));
}

/**
 * 使用部品を出庫して、記録（related_table / related_id）に紐づける。
 * items: [{ part, qty, txId }]。1件ずつ送り、成功した分は items から除く（押し直しても二重に減らない）。
 * 返り値: 失敗した分 [{ item, message }]（空なら全部成功）
 */
export async function recordUsedParts(items, { relatedTable, relatedId, noteLabel }) {
  const failed = [];
  for (const item of [...items]) {
    try {
      await api.post(`/api/parts/${item.part.id}/transaction`, {
        type: 'out',
        quantity: item.qty,
        client_tx_id: item.txId,
        related_table: relatedTable,
        related_id: Number(relatedId),
        note: `${noteLabel}で使用`,
      });
      items.splice(items.indexOf(item), 1);
    } catch (err) {
      failed.push({ item, message: err.message || String(err) });
    }
  }
  return failed;
}

/**
 * 入力画面用: 使用部品カードの中身。選んだ部品は「追加」で一覧に並べ、保存時にまとめて出庫する。
 *   getPending() … いま選んでいる（未出庫の）部品 [{ part, qty, txId }]
 */
export function buildUsedPartsInput({ parts, recorded = [] }) {
  const picker = buildPartPicker(parts);
  const qtyInput = el('input', { type: 'number', min: '1', max: String(MAX_QTY), value: '1', style: 'width:72px', 'aria-label': '数量' });
  const pending = [];
  const pendingBox = el('div', { class: 'row-list' }, []);
  const recordedBox = el('div', { class: 'row-list' }, []);
  renderUsedList(recordedBox, recorded, '');
  if (recorded.length > 0) recordedBox.prepend(el('p', { class: 'hint' }, '記録済みの使用部品（取り消しは部品在庫の入出庫で行います）'));

  const drawPending = () => {
    if (pending.length === 0) { render(pendingBox, []); return; }
    render(pendingBox, [
      el('p', { class: 'hint' }, '保存すると、次の部品が在庫から減ります。'),
      ...pending.map((it) => el('div', { class: 'list-item' }, [
        el('div', { class: 'list-item-main' }, [
          el('div', { class: 'list-item-title' }, it.part.model_no ? `${it.part.model_no}（${it.part.name}）` : it.part.name),
          el('div', { class: 'list-item-sub' }, `在庫${it.part.quantity} → ${it.part.quantity - it.qty}`),
        ]),
        el('span', { class: 'status-badge' }, `${it.qty} 個使用`),
        el('button', { class: 'btn btn-sm', type: 'button', 'aria-label': '取り消す', onclick: () => { pending.splice(pending.indexOf(it), 1); drawPending(); } }, '×'),
      ])),
    ]);
  };
  const addBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => {
    const part = picker.part;
    if (!part) { alert(picker.hasText() ? '入力した部品は在庫にありません。候補から選ぶか、部品在庫に登録してください。' : '部品を選択してください。'); return; }
    const qty = Number(qtyInput.value);
    // 同じ部品を2回追加したら合計で在庫を超えないか確認する
    const already = pending.filter((x) => x.part.id === part.id).reduce((a, x) => a + x.qty, 0);
    if (checkQty({ ...part, quantity: part.quantity - already }, qty) === null) return;
    pending.push({ part, qty, txId: newTxId() });
    picker.clear(); qtyInput.value = '1';
    drawPending();
  } }, '＋ 追加');

  const node = el('div', {}, [
    el('div', { class: 'inline-form' }, [picker, qtyInput, addBtn]),
    pendingBox,
    recordedBox,
  ]);
  return { node, getPending: () => pending, hasUnaddedText: () => picker.hasText() };
}
