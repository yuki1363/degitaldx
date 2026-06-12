// 05 部品在庫 — 一覧・在庫数更新・登録・編集・CSVインポート
//   URL: /pages/parts            … 一覧
//        /pages/parts?new=1      … 新規登録
//        /pages/parts?edit=N     … 編集
//        /pages/parts?id=N       … 詳細（入出庫履歴）
//        /pages/parts?import=1   … CSVインポート

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime } from '/js/util.js';

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/parts${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 一覧 ----------------

async function renderList() {
  let filterLow = false;
  let searchQuery = '';
  let timer = null;

  const listBox = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (filterLow) params.set('low_stock', '1');
    const { parts } = await api.get(`/api/parts${params.toString() ? '?' + params : ''}`);
    if (parts.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '部品が見つかりません。'));
      return;
    }
    render(
      listBox,
      parts.map((p) => {
        const isLow = p.quantity <= p.safety_stock;
        return el('a', { class: 'list-item', href: `/pages/parts?id=${p.id}` }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-sub' }, p.part_no),
            el('div', { class: 'list-item-title' }, p.name),
            el('div', { class: 'list-item-sub' }, [
              p.spec || '',
              p.location ? `保管場所: ${p.location}` : '',
            ].filter(Boolean).join(' / ')),
          ]),
          el('div', { class: 'parts-qty', style: isLow ? 'color:#dc2626;font-weight:700' : '' }, [
            el('span', { class: 'parts-qty-num' }, String(p.quantity)),
            el('span', { class: 'parts-qty-unit' }, p.unit),
            isLow ? el('span', { class: 'abn-badge is-abn', style: 'font-size:10px;padding:1px 6px' }, '要発注') : null,
          ]),
          el('span', { class: 'chevron' }, '›'),
        ]);
      })
    );
  };

  const searchInput = el('input', {
    type: 'search',
    placeholder: '部品番号・名称で検索',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { searchQuery = e.target.value.trim(); load().catch(showError); }, 300);
    },
  });

  const lowToggle = el('button', {
    class: 'btn btn-sm',
    onclick: () => {
      filterLow = !filterLow;
      lowToggle.textContent = filterLow ? '⚠ 要発注のみ' : '全部品';
      lowToggle.style.borderColor = filterLow ? '#dc2626' : '';
      load().catch(showError);
    },
  }, '全部品');

  render(app, [
    el('div', { class: 'toolbar' }, [
      searchInput,
      lowToggle,
    ]),
    hasRole(currentUser, 'editor')
      ? el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
          el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 部品を追加'),
          el('button', { class: 'btn', onclick: () => go('?import=1') }, '📥 CSVインポート'),
        ])
      : null,
    listBox,
  ]);
  await load();
}

// ---------------- 詳細（入出庫履歴） ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

async function renderDetail(id) {
  const { part, transactions } = await api.get(`/api/parts/${id}`);
  const canEdit = hasRole(currentUser, 'editor');
  const isLow = part.quantity <= part.safety_stock;

  // 在庫数更新フォーム
  const txTypeEl = el('select', {},
    [['in', '入庫（＋）'], ['out', '出庫（－）'], ['adjust', '棚卸調整（絶対値）']].map(([v, l]) =>
      el('option', { value: v }, l)
    )
  );
  const txQtyEl = el('input', { type: 'number', min: '1', value: '1', style: 'width:100px' });
  const txNoteEl = el('input', { type: 'text', placeholder: 'メモ（任意）' });

  const doTransaction = async () => {
    const type = txTypeEl.value;
    const quantity = parseInt(txQtyEl.value, 10);
    const note = txNoteEl.value.trim() || null;
    if (!quantity || quantity < 1) { alert('数量は1以上を入力してください。'); return; }
    try {
      await api.post(`/api/parts/${id}/transaction`, { type, quantity, note });
      go(`?id=${id}`);
    } catch (err) { alert(err.message); }
  };

  const TYPE_LABELS = { in: '入庫', out: '出庫', adjust: '調整' };

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, part.name),
        isLow
          ? el('span', { class: 'abn-badge is-abn' }, '要発注')
          : el('span', { class: 'abn-badge' }, '在庫あり'),
      ]),
      infoRow('部品番号', part.part_no),
      infoRow('仕様', part.spec),
      infoRow('現在庫', `${part.quantity} ${part.unit}`),
      infoRow('安全在庫', `${part.safety_stock} ${part.unit}`),
      infoRow('保管場所', part.location),
      infoRow('仕入先', part.supplier),
      infoRow('備考', part.note),
    ]),
    canEdit
      ? el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, '在庫数を更新'),
          el('div', { class: 'field-pair' }, [
            el('div', { class: 'field' }, [el('label', {}, '種別'), txTypeEl]),
            el('div', { class: 'field' }, [el('label', {}, '数量'), txQtyEl]),
          ]),
          el('div', { class: 'field' }, [el('label', {}, 'メモ'), txNoteEl]),
          el('button', { class: 'btn btn-primary', onclick: doTransaction }, '更新'),
        ])
      : null,
    canEdit
      ? el('div', { class: 'action-row' }, [
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}`) }, '編集'),
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm(`「${part.name}」を削除しますか？`)) return;
              await api.del(`/api/parts/${id}`);
              go('');
            },
          }, '削除'),
        ])
      : null,
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '入出庫履歴（直近50件）'),
      transactions.length === 0
        ? el('p', { class: 'empty' }, '履歴はありません。')
        : el('div', { class: 'row-list' },
            transactions.map((t) =>
              el('div', { class: 'history-row' }, [
                el('span', {
                  class: `action-badge ${t.type === 'in' ? 'is-create' : t.type === 'out' ? 'is-delete' : 'is-update'}`,
                }, TYPE_LABELS[t.type] || t.type),
                el('span', { style: t.quantity < 0 ? 'color:#dc2626' : '' },
                  `${t.quantity > 0 ? '+' : ''}${t.quantity} ${part.unit}`),
                el('span', {}, t.created_by),
                el('span', { class: 'list-item-sub' }, formatDateTime(t.created_at)),
                t.note ? el('span', { class: 'list-item-sub' }, t.note) : null,
              ])
            )
          ),
    ]),
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', {}, label), input]);
}

async function renderForm(existing) {
  const f = {
    part_no: el('input', { type: 'text', value: existing?.part_no || '', placeholder: '例: BRG-6205' }),
    name: el('input', { type: 'text', value: existing?.name || '', placeholder: '例: ベアリング 6205' }),
    spec: el('input', { type: 'text', value: existing?.spec || '', placeholder: '例: 内径25mm' }),
    unit: el('input', { type: 'text', value: existing?.unit || '個' }),
    quantity: el('input', { type: 'number', min: '0', value: String(existing?.quantity ?? 0) }),
    safety_stock: el('input', { type: 'number', min: '0', value: String(existing?.safety_stock ?? 0) }),
    location: el('input', { type: 'text', value: existing?.location || '', placeholder: '例: A棚3段目' }),
    supplier: el('input', { type: 'text', value: existing?.supplier || '' }),
    note: el('textarea', { value: existing?.note || '' }),
  };

  const save = async () => {
    const body = {
      part_no: f.part_no.value.trim(),
      name: f.name.value.trim(),
      spec: f.spec.value.trim() || null,
      unit: f.unit.value.trim() || '個',
      quantity: parseInt(f.quantity.value, 10) || 0,
      safety_stock: parseInt(f.safety_stock.value, 10) || 0,
      location: f.location.value.trim() || null,
      supplier: f.supplier.value.trim() || null,
      note: f.note.value.trim() || null,
    };
    if (!body.part_no || !body.name) { alert('部品番号と部品名は必須です。'); return; }
    try {
      if (existing) {
        await api.put(`/api/parts/${existing.id}`, body);
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/parts', body);
        go(`?id=${id}`);
      }
    } catch (err) { alert(err.message); }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '部品を編集' : '部品を追加'),
      field('部品番号（必須・一意）', f.part_no),
      field('部品名（必須）', f.name),
      field('仕様', f.spec),
      el('div', { class: 'field-pair' }, [
        el('div', { class: 'field' }, [el('label', {}, '単位'), f.unit]),
        el('div', { class: 'field' }, [el('label', {}, '現在庫数'), f.quantity]),
      ]),
      el('div', { class: 'field' }, [el('label', {}, '安全在庫（発注アラート基準）'), f.safety_stock]),
      field('保管場所', f.location),
      field('仕入先', f.supplier),
      field('備考', f.note),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', { class: 'btn', onclick: () => (existing ? go(`?id=${existing.id}`) : go('')) }, 'キャンセル'),
      ]),
    ]),
  ]);
}

// ---------------- CSVインポート ----------------

async function renderImport() {
  if (!hasRole(currentUser, 'editor')) throw new Error('権限がありません。');

  // 列マッピング設定
  const COLS = ['part_no', 'name', 'spec', 'unit', 'quantity', 'safety_stock', 'location', 'supplier', 'note'];
  const COL_LABELS = {
    part_no: '部品番号', name: '部品名', spec: '仕様', unit: '単位',
    quantity: '現在庫', safety_stock: '安全在庫', location: '保管場所',
    supplier: '仕入先', note: '備考',
  };

  let csvHeaders = [];
  let csvRows = [];
  let mapping = {}; // appField → csvColIndex

  const mappingBox = el('div', {}, []);
  const previewBox = el('div', {}, []);
  const resultBox = el('div', {}, []);
  const importBtn = el('button', { class: 'btn btn-primary', disabled: true }, '取込実行');

  const parseCSV = (text) => {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
    return lines.map((line) => {
      const row = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = !inQ;
        } else if (ch === ',' && !inQ) { row.push(cur); cur = ''; }
        else cur += ch;
      }
      row.push(cur);
      return row;
    });
  };

  const buildPreview = () => {
    if (csvRows.length === 0) return;
    const sample = csvRows.slice(0, 5).map((row) => {
      const obj = {};
      for (const [field, idx] of Object.entries(mapping)) {
        obj[field] = idx !== '' ? row[Number(idx)] || '' : '';
      }
      return obj;
    });
    render(previewBox, [
      el('p', { style: 'font-size:13px;color:#64748b;margin:8px 0' }, `${csvRows.length}行を検出（先頭5件プレビュー）`),
      el('div', { style: 'overflow-x:auto' }, [
        el('table', { class: 'import-table' }, [
          el('thead', {}, [
            el('tr', {}, COLS.map((c) => el('th', {}, COL_LABELS[c]))),
          ]),
          el('tbody', {}, sample.map((row) =>
            el('tr', {}, COLS.map((c) => el('td', {}, row[c] || '')))
          )),
        ]),
      ]),
    ]);
    importBtn.disabled = false;
  };

  const buildMapping = () => {
    render(mappingBox, [
      el('p', { style: 'font-size:13px;color:#64748b;margin:0 0 8px' }, 'CSV の列とアプリ項目を対応付けてください:'),
      ...COLS.map((field) => {
        const sel = el('select', {
          onchange: (e) => {
            mapping[field] = e.target.value;
            buildPreview();
          },
        }, [
          el('option', { value: '' }, '— 対応なし'),
          ...csvHeaders.map((h, i) => el('option', { value: i }, `[${i + 1}] ${h}`)),
        ]);
        // 自動マッピング（同名の場合）
        const autoIdx = csvHeaders.findIndex(
          (h) => h.toLowerCase().replace(/[\s_-]/g, '') === field.toLowerCase()
            || h === COL_LABELS[field]
        );
        if (autoIdx >= 0) {
          sel.value = autoIdx;
          mapping[field] = autoIdx;
        } else {
          mapping[field] = '';
        }
        return el('div', { class: 'field-pair' }, [
          el('div', { class: 'field', style: 'flex:0 0 100px' }, [
            el('label', {}, COL_LABELS[field]),
          ]),
          el('div', { class: 'field', style: 'flex:1' }, [sel]),
        ]);
      }),
    ]);
    buildPreview();
  };

  importBtn.onclick = async () => {
    const rows = csvRows.map((row) => {
      const obj = {};
      for (const [field, idx] of Object.entries(mapping)) {
        if (idx !== '') obj[field] = row[Number(idx)]?.trim() || '';
      }
      return obj;
    }).filter((r) => r.part_no || r.name);

    importBtn.disabled = true;
    importBtn.textContent = '取込中…';
    try {
      const result = await api.post('/api/parts/import', { rows });
      render(resultBox, [
        el('div', { class: 'notice' }, [
          el('p', {}, `✅ 取込完了: 新規${result.inserted}件 / 更新${result.updated}件 / スキップ${result.skipped}件`),
          result.errors?.length > 0
            ? el('ul', {}, result.errors.slice(0, 10).map((e) =>
                el('li', { style: 'font-size:12px;color:#dc2626' }, `行${e.row}: ${e.reason}`)
              ))
            : null,
        ]),
      ]);
    } catch (err) {
      render(resultBox, el('p', { class: 'notice is-error' }, err.message));
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '取込実行';
    }
  };

  const fileInput = el('input', {
    type: 'file',
    accept: '.csv,text/csv',
    onchange: (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const parsed = parseCSV(ev.target.result);
        if (parsed.length < 2) { alert('CSVの行数が不足しています。'); return; }
        csvHeaders = parsed[0];
        csvRows = parsed.slice(1);
        mapping = {};
        buildMapping();
      };
      // Shift_JIS 対応
      reader.readAsText(file, 'UTF-8');
    },
  });

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, 'CSVインポート'),
      el('p', { class: 'hint' }, '1行目をヘッダー行とするCSVファイルを選択してください（UTF-8 / Shift_JIS 両対応）。既存部品番号は上書き更新されます。'),
      el('div', { class: 'field' }, [
        el('label', {}, 'CSVファイル'),
        fileInput,
      ]),
      mappingBox,
      previewBox,
      el('div', { class: 'action-row' }, [
        importBtn,
        el('button', { class: 'btn', onclick: () => go('') }, 'キャンセル'),
      ]),
      resultBox,
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
      const { part } = await api.get(`/api/parts/${Number(params.get('edit'))}`);
      await renderForm(part);
    } else if (params.get('new')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('登録する権限がありません。');
      await renderForm(null);
    } else if (params.get('import')) {
      await renderImport();
    } else {
      await renderList();
    }
  } catch (err) {
    showError(err);
  }
})();
