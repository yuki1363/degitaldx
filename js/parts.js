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

// 重要度（高/中/低）→ バッジのCSSクラス
const IMP_CLASS = { '高': 'imp-high', '中': 'imp-mid', '低': 'imp-low' };
function importanceBadge(v) {
  if (!v) return null;
  return el('span', { class: `imp-badge ${IMP_CLASS[v] || ''}` }, v);
}

function go(query) {
  window.location.href = `/pages/parts${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 発注（Outlook メール作成） ----------------

// 発注メールの件名・本文を自動生成する。
//   件名「【発注依頼】部品名」／本文は部品名・現在庫・必要数・希望発注数量。
//   （型番・仕入先・依頼者は本文に含めない方針）
function buildOrderEmail(part, orderQty) {
  const subject = `【発注依頼】${part.name}`;
  const body = [
    '下記の部品の発注をお願いいたします。',
    '',
    `部品名: ${part.name}`,
    `現在庫: ${part.quantity}`,
    `必要数: ${part.safety_stock}`,
    `希望発注数量: ${orderQty}`,
    '',
    'よろしくお願いいたします。',
  ].join('\n');
  return { subject, body };
}

function isMobileDevice() {
  return /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent);
}

// PC は Outlook Web（Microsoft 365）の作成画面、スマホは Outlook アプリを開く
function openInOutlook(to, subject, body) {
  const t = encodeURIComponent(to || '');
  const s = encodeURIComponent(subject);
  const b = encodeURIComponent(body);
  if (isMobileDevice()) {
    window.location.href = `ms-outlook://compose?to=${t}&subject=${s}&body=${b}`;
  } else {
    window.open(`https://outlook.office.com/mail/deeplink/compose?to=${t}&subject=${s}&body=${b}`,
      '_blank', 'noopener');
  }
}

// 標準のメールアプリ（mailto）で開く — Outlook が開かない場合のフォールバック
function openInMailto(to, subject, body) {
  window.location.href =
    `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// 発注ダイアログ（宛先・希望数量・自動生成された本文プレビュー）
function openOrderDialog(part) {
  const shortfall = Math.max((part.safety_stock || 0) - (part.quantity || 0), 1);
  const toInput = el('input', { type: 'email', value: part.supplier_email || '', placeholder: '発注先のメールアドレス' });
  const qtyInput = el('input', { type: 'number', min: '1', value: String(shortfall), style: 'width:120px' });
  const preview = el('textarea', { rows: '10', readonly: true });

  const refresh = () => {
    const qty = Math.max(parseInt(qtyInput.value, 10) || 1, 1);
    const mail = buildOrderEmail(part, qty);
    preview.value = `件名: ${mail.subject}\n\n${mail.body}`;
    return mail;
  };
  qtyInput.addEventListener('input', refresh);

  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const modal = el('div', { class: 'modal' }, [
    el('h3', { class: 'modal-title' }, `発注メールの作成: ${part.name}`),
    el('div', { class: 'field' }, [el('label', {}, '宛先メール'), toInput]),
    el('div', { class: 'field' }, [el('label', {}, '希望発注数量'), qtyInput]),
    el('div', { class: 'field' }, [el('label', {}, '本文プレビュー（自動生成）'), preview]),
    el('p', { class: 'hint' }, 'PCはOutlook Web、スマホはOutlookアプリの作成画面を開きます。開かない場合は「メールアプリで開く」をお使いください。'),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-primary', onclick: () => { const m = refresh(); openInOutlook(toInput.value.trim(), m.subject, m.body); } }, '📧 Outlookで作成'),
      el('button', { class: 'btn', onclick: () => { const m = refresh(); openInMailto(toInput.value.trim(), m.subject, m.body); } }, 'メールアプリで開く'),
      el('button', { class: 'btn', onclick: close }, '閉じる'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  refresh();
}

// ---------------- 一覧 ----------------

const ALL_LINES = '__ALL__';  // 設備セレクタの「すべての設備を表示」を表す内部値
const ALL_EQUIPS = '__ALL__'; // 機器セレクタの「すべての機器」を表す内部値
const NO_EQUIP = '__NONE__';  // 機器名が空の部品（機器未設定）を表す内部値

async function renderList() {
  let filterLow = false;
  let searchQuery = '';
  let selectedLine = '';  // 設備名フィルタ（空 = 未選択／プロンプト表示）
  let selectedEquip = ''; // 機器名フィルタ（設備選択後に有効。ALL_EQUIPS = その設備の全機器）
  let allParts = [];
  let timer = null;

  const listBox = el('div', { class: 'row-list' }, []);

  // 設備名 → 機器名の2段階で表示を絞り込むセレクタ
  // 設備を選ぶと機器セレクタが有効になり、選んだ機器の部品だけを表示する
  const lineSelect = el('select', {
    class: 'parts-line-select',
    onchange: (e) => {
      selectedLine = e.target.value;
      selectedEquip = ''; // 設備を変えたら機器は未選択に戻す（機器を選ぶまで表示しない）
      refreshEquipOptions();
      renderParts();
    },
  }, [el('option', { value: '' }, '設備を選択してください')]);

  const equipSelect = el('select', {
    class: 'parts-line-select',
    onchange: (e) => { selectedEquip = e.target.value; renderParts(); },
  }, [el('option', { value: '' }, '（設備を選択）')]);

  // 部品1件分の行を生成（発注ボタン・削除ボタンは editor 以上）
  const makePartRow = (p) => {
    const isLow = p.quantity < p.safety_stock;
    let orderBtn = null;
    if (isLow && hasRole(currentUser, 'editor')) {
      orderBtn = el('button', { class: 'btn btn-sm order-btn' }, '📧 発注');
      orderBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openOrderDialog(p);
      });
    }
    let editBtn = null;
    let delBtn = null;
    if (hasRole(currentUser, 'editor')) {
      editBtn = el('button', { class: 'btn btn-sm row-edit-btn', title: '編集' }, '✏️');
      editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        go(`?edit=${p.id}`);
      });
      delBtn = el('button', { class: 'btn btn-sm row-del-btn', title: '削除' }, '🗑');
      delBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm(`「${p.name}」を削除しますか？`)) return;
        try {
          await api.del(`/api/parts/${p.id}`);
          await load();
        } catch (err) { alert(err.message); }
      });
    }
    const sub = [
      p.model_no ? `型番: ${p.model_no}` : '',
      p.location ? `場所: ${p.location}` : '',
    ].filter(Boolean).join(' / ');
    return el('a', { class: 'list-item', href: `/pages/parts?id=${p.id}` }, [
      el('div', { class: 'list-item-main' }, [
        el('div', { class: 'list-item-title' }, [p.name, importanceBadge(p.importance)]),
        sub ? el('div', { class: 'list-item-sub' }, sub) : null,
      ]),
      el('div', { class: 'parts-qty', style: isLow ? 'color:#dc2626;font-weight:700' : '' }, [
        el('span', { class: 'parts-qty-num' }, String(p.quantity)),
        el('span', { class: 'parts-qty-unit' }, `/ 必要 ${p.safety_stock}`),
        isLow ? el('span', { class: 'abn-badge is-abn', style: 'font-size:10px;padding:1px 6px' }, '要発注') : null,
      ]),
      orderBtn,
      editBtn,
      delBtn,
      el('span', { class: 'chevron' }, '›'),
    ]);
  };

  // 部品配列を 設備名→機器名 でグループ化して listBox に描画する
  //   （APIは line_name, equipment_name, name 順でソート済み）
  const renderGroups = (parts) => {
    if (parts.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '部品が見つかりません。'));
      return;
    }
    const lineMap = new Map();
    for (const p of parts) {
      const line = p.line_name || '';
      const equip = p.equipment_name || '';
      if (!lineMap.has(line)) lineMap.set(line, new Map());
      const equipMap = lineMap.get(line);
      if (!equipMap.has(equip)) equipMap.set(equip, []);
      equipMap.get(equip).push(p);
    }
    const nodes = [];
    for (const [line, equipMap] of lineMap) {
      nodes.push(el('div', { class: 'group-header-line' }, line || '（設備未設定）'));
      for (const [equip, equipParts] of equipMap) {
        nodes.push(el('div', { class: 'group-header-equip' }, equip || '（機器未設定）'));
        nodes.push(el('div', { class: 'row-list' }, equipParts.map(makePartRow)));
      }
    }
    render(listBox, nodes);
  };

  // 表示する部品を「設備 → 機器」の2段階選択で決める。
  //   ・検索キーワードがあるときは、選択に関係なく該当部品を全件表示（名前で探す用途）
  //   ・設備未選択: 要発注フィルタ中のみ全件、それ以外は設備選択を促す
  //   ・設備を選んでも、機器を選ぶまでは部品を表示しない（「すべての機器」で設備全件）
  const renderParts = () => {
    if (searchQuery) { renderGroups(allParts); return; }

    if (!selectedLine) {
      if (filterLow) { renderGroups(allParts); return; }
      render(listBox, el('p', { class: 'empty' }, '「設備で絞り込み」から設備を選んでください（「すべての設備を表示」で全件表示）。'));
      return;
    }
    if (selectedLine === ALL_LINES) { renderGroups(allParts); return; }

    // 設備は選択済み。機器を選ぶまでデータは表示しない
    if (!selectedEquip) {
      render(listBox, el('p', { class: 'empty' }, '「機器で絞り込み」から機器を選んでください（「すべての機器」でこの設備の全件表示）。'));
      return;
    }
    let parts = allParts.filter((p) => (p.line_name || '') === selectedLine);
    if (selectedEquip === NO_EQUIP) {
      parts = parts.filter((p) => (p.equipment_name || '') === '');
    } else if (selectedEquip !== ALL_EQUIPS) {
      parts = parts.filter((p) => (p.equipment_name || '') === selectedEquip);
    }
    renderGroups(parts);
  };

  // 設備セレクタの選択肢を現在のデータから更新（選択は維持。消えていたら未選択へ戻す）
  const refreshLineOptions = () => {
    const lines = [...new Set(allParts.map((p) => p.line_name || '').filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ja'));
    render(lineSelect, [
      el('option', { value: '' }, '設備を選択してください'),
      el('option', { value: ALL_LINES }, `すべての設備を表示（${allParts.length}件）`),
      ...lines.map((l) => el('option', { value: l }, l)),
    ]);
    const valid = ['', ALL_LINES, ...lines];
    if (valid.includes(selectedLine)) lineSelect.value = selectedLine;
    else { selectedLine = ''; lineSelect.value = ''; }
  };

  // 機器セレクタの選択肢を「選択中の設備」に属する機器から更新する。
  //   設備が未選択／すべての設備のときは機器セレクタを無効化する。
  //   機器を選ぶまではデータを出さないため、初期値は未選択（プロンプト）にする。
  const refreshEquipOptions = () => {
    if (!selectedLine || selectedLine === ALL_LINES) {
      render(equipSelect, [el('option', { value: '' }, '（設備を選択）')]);
      equipSelect.value = '';
      equipSelect.disabled = true;
      return;
    }
    equipSelect.disabled = false;
    const equips = [...new Set(
      allParts
        .filter((p) => (p.line_name || '') === selectedLine)
        .map((p) => p.equipment_name || '')
    )].sort((a, b) => a.localeCompare(b, 'ja'));
    // 機器名が空の部品はセンチネル値 NO_EQUIP で扱う（未選択の '' と区別するため）
    const optValue = (eq) => (eq === '' ? NO_EQUIP : eq);
    render(equipSelect, [
      el('option', { value: '' }, '機器を選択してください'),
      el('option', { value: ALL_EQUIPS }, 'すべての機器'),
      ...equips.map((eq) => el('option', { value: optValue(eq) }, eq || '（機器未設定）')),
    ]);
    const valid = ['', ALL_EQUIPS, ...equips.map(optValue)];
    if (!valid.includes(selectedEquip)) selectedEquip = '';
    equipSelect.value = selectedEquip;
  };

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (filterLow) params.set('low_stock', '1');
    const { parts } = await api.get(`/api/parts${params.toString() ? '?' + params : ''}`);
    allParts = parts;
    refreshLineOptions();
    refreshEquipOptions();
    renderParts();
  };

  const searchInput = el('input', {
    type: 'search',
    placeholder: '型番・部品名・設備・機器で検索',
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
    el('div', { class: 'field-pair', style: 'margin-bottom:10px' }, [
      el('div', { class: 'field' }, [
        el('label', {}, '設備で絞り込み'),
        lineSelect,
      ]),
      el('div', { class: 'field' }, [
        el('label', {}, '機器で絞り込み'),
        equipSelect,
      ]),
    ]),
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
  const isLow = part.quantity < part.safety_stock; // 在庫数 < 必要数 で要発注

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
        el('h2', { class: 'card-title' }, [part.name, importanceBadge(part.importance)]),
        isLow
          ? el('span', { class: 'abn-badge is-abn' }, '要発注')
          : el('span', { class: 'abn-badge' }, '在庫あり'),
      ]),
      infoRow('設備名', part.line_name),
      infoRow('機器名', part.equipment_name),
      infoRow('型番', part.model_no),
      infoRow('在庫数', String(part.quantity)),
      infoRow('必要数', String(part.safety_stock)),
      infoRow('重要度', part.importance),
      infoRow('在庫場所', part.location),
      infoRow('仕入れ先', part.supplier),
      infoRow('仕入先メール', part.supplier_email),
      infoRow('備考', part.note),
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          el('button', { class: isLow ? 'btn btn-primary' : 'btn', onclick: () => openOrderDialog(part) }, '📧 発注メールを作成'),
        ])
      : null,
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
                  `${t.quantity > 0 ? '+' : ''}${t.quantity}`),
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
  const impSelect = el('select', {},
    [['', '（なし）'], ['高', '高'], ['中', '中'], ['低', '低']].map(([v, l]) =>
      el('option', { value: v, selected: (existing?.importance || '') === v }, l)
    )
  );
  const f = {
    line_name: el('input', { type: 'text', value: existing?.line_name || '', placeholder: '例: 第1設備' }),
    equipment_name: el('input', { type: 'text', value: existing?.equipment_name || '', placeholder: '例: 充填機' }),
    name: el('input', { type: 'text', value: existing?.name || '', placeholder: '例: ベアリング 6205' }),
    model_no: el('input', { type: 'text', value: existing?.model_no || '', placeholder: '例: 6205ZZ' }),
    location: el('input', { type: 'text', value: existing?.location || '', placeholder: '例: A棚3段目' }),
    safety_stock: el('input', { type: 'number', min: '0', value: String(existing?.safety_stock ?? 0) }),
    quantity: el('input', { type: 'number', min: '0', value: String(existing?.quantity ?? 0) }),
    importance: impSelect,
    supplier: el('input', { type: 'text', value: existing?.supplier || '' }),
    supplier_email: el('input', { type: 'email', value: existing?.supplier_email || '', placeholder: '発注メールの宛先（任意）' }),
    note: el('textarea', { value: existing?.note || '' }),
  };

  const save = async () => {
    const body = {
      line_name: f.line_name.value.trim() || null,
      equipment_name: f.equipment_name.value.trim() || null,
      name: f.name.value.trim(),
      model_no: f.model_no.value.trim() || null,
      location: f.location.value.trim() || null,
      safety_stock: parseInt(f.safety_stock.value, 10) || 0,
      importance: f.importance.value || null,
      supplier: f.supplier.value.trim() || null,
      supplier_email: f.supplier_email.value.trim() || null,
      note: f.note.value.trim() || null,
    };
    // 在庫数は新規登録時のみ初期値として送る（編集時は「在庫数を更新」から変更）
    if (!existing) body.quantity = parseInt(f.quantity.value, 10) || 0;
    if (!body.name) { alert('部品名は必須です。'); return; }
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
      field('設備名', f.line_name),
      field('機器名', f.equipment_name),
      field('部品名（必須）', f.name),
      field('型番', f.model_no),
      field('在庫場所', f.location),
      existing
        ? field('必要数（発注アラート基準）', f.safety_stock)
        : el('div', { class: 'field-pair' }, [
            el('div', { class: 'field' }, [el('label', {}, '必要数（発注アラート基準）'), f.safety_stock]),
            el('div', { class: 'field' }, [el('label', {}, '在庫数（初期）'), f.quantity]),
          ]),
      field('重要度', f.importance),
      field('仕入れ先', f.supplier),
      field('仕入先メール（発注先）', f.supplier_email),
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

  // 列マッピング設定（ユーザー指定の項目順）
  const COLS = ['line_name', 'equipment_name', 'name', 'model_no', 'location', 'safety_stock', 'quantity', 'importance', 'supplier', 'note'];
  const COL_LABELS = {
    line_name: '設備名', equipment_name: '機器名', name: '部品名', model_no: '型番',
    location: '在庫場所', safety_stock: '必要数', quantity: '在庫数', importance: '重要度',
    supplier: '仕入れ先', note: '備考',
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
    }).filter((r) => r.name);

    if (rows.length === 0) { alert('取り込める行がありません（部品名が必須です）。'); return; }
    // 全置き換え（破壊的）なので取込前に確認する
    if (!confirm(`既存の部品データをすべて削除し、CSV ${rows.length}件で置き換えます。\nこの操作は元に戻せます（削除済みデータから復元可能）が、現在の在庫数は上書きされます。\n実行しますか？`)) return;

    importBtn.disabled = true;
    importBtn.textContent = '取込中…';
    try {
      const result = await api.post('/api/parts/import', { rows });
      render(resultBox, [
        el('div', { class: 'notice' }, [
          el('p', {}, `✅ 全置き換え完了: 既存${result.deleted ?? 0}件を削除 → 新規${result.inserted}件を登録（スキップ${result.skipped}件）`),
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
      el('h2', { class: 'card-title' }, 'CSVインポート（全置き換え）'),
      el('p', { class: 'notice is-error', style: 'margin-bottom:8px' }, '⚠ 既存の部品データはすべて置き換えられます。CSVの内容が新しい正データになります（現在の在庫数も上書き）。'),
      el('p', { class: 'hint' }, '1行目をヘッダー行とするCSVファイルを選択してください（UTF-8 / Shift_JIS 両対応）。CSVにない項目は空欄で取り込みます（部品名のみ必須）。'),
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
