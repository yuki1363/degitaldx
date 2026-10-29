// 05 部品在庫 — 一覧・在庫数更新・登録・編集・CSVインポート
//   URL: /pages/parts            … 一覧
//        /pages/parts?new=1      … 新規登録
//        /pages/parts?edit=N     … 編集
//        /pages/parts?id=N       … 詳細（入出庫履歴）
//        /pages/parts?import=1   … CSVインポート
//   部品QRラベル（/pages/labels?type=parts）は /pages/parts?id=N を開く。詳細の「その場で記録」で
//   棚の前で出庫・入庫をワンタップで記録できる（電波が無ければ送信待ちに保存して後で自動送信）。

import { api } from '/js/api.js';
import { getCurrentUser, hasRole, getCachedRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';
import { enqueue as enqueueOffline, listQueued } from '/js/offline-queue.js';
import { openQrScanner } from '/js/qr-scan.js';
import qrcode from '/js/vendor/qrcode.mjs';

// 画面を開いている間の自動更新の間隔（他の人の入出庫を反映する。裏に回ったら止める）
//   （E2E では window.__PARTS_REFRESH_MS__ で短くして確認する）
const AUTO_REFRESH_MS = Number(window.__PARTS_REFRESH_MS__) || 20_000;

// 1回の入出庫の識別番号。押し直し・送信待ちの再送でも同じ番号を送り、サーバーは2回反映しない
const newTxId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// 識別番号の置き場。同じ内容（種別・数量）の押し直しには同じ番号を使い回し（通信が切れて結果が分からない
// ときに2回反映しない）、内容を変えたら新しい番号にする（変えたのに前の内容の記録として扱われない）。
// 記録できたら（送信待ちに保存した場合も）その内容の番号は捨て、次に同じ内容を記録するときは新しい番号にする
function makeTxIdPool() {
  const ids = new Map();
  return {
    get(type, qty) {
      const key = `${type}:${qty}`;
      if (!ids.has(key)) ids.set(key, newTxId());
      return ids.get(key);
    },
    done(type, qty) { ids.delete(`${type}:${qty}`); },
  };
}

// 入出庫を記録する。電波が無いとき（入庫・出庫のみ）は送信待ちに保存して { queued:true } を返す。
//   棚卸調整は絶対値なので、後から送ると間の出庫を消してしまうため送信待ちにしない
async function recordTransaction(partId, { type, quantity, note }, txId) {
  const body = { type, quantity, note, client_tx_id: txId };
  try {
    return await api.post(`/api/parts/${partId}/transaction`, body);
  } catch (err) {
    const offline = err?.offline === true || navigator.onLine === false;
    if (!offline || type === 'adjust') throw err;
    await enqueueOffline('parts_tx', { part_id: partId, ...body });
    return { queued: true };
  }
}

// 最後に見た部品の内容（端末ごと）。電波の無い倉庫で QR を読んだときに名前・在庫の目安を出す
const snapKey = (id) => `parts:snap:${id}`;
function saveSnapshot(part) {
  try {
    localStorage.setItem(snapKey(part.id), JSON.stringify({
      id: part.id, name: part.name, model_no: part.model_no, location: part.location,
      quantity: part.quantity, at: new Date().toISOString(),
    }));
  } catch { /* 保存できなくても表示は続ける */ }
}
function loadSnapshot(id) {
  try { return JSON.parse(localStorage.getItem(snapKey(id)) || 'null'); } catch { return null; }
}

// この部品の送信待ち（まだサーバーに届いていない入出庫）
async function queuedFor(partId) {
  return (await listQueued('parts_tx')).filter((i) => Number(i.payload?.part_id) === Number(partId));
}
const queuedText = (items) => items.map((i) => `${i.payload.type === 'in' ? '入庫 +' : '出庫 −'}${i.payload.quantity}`).join('、');

// 棚の前でのワンタップ記録（数量のステッパー＋出庫・入庫の大きいボタン）
//   onDone(result) … 記録できた／送信待ちに保存したあとの処理
function buildQuickRecord(partId, onDone) {
  let qty = 1;
  const txIds = makeTxIdPool();
  let busy = false;
  const qtyEl = el('span', { class: 'quick-qty-value' }, '1');
  const setQty = (n) => { qty = Math.max(1, Math.min(9999, n)); qtyEl.textContent = String(qty); };
  const msg = el('p', { class: 'hint quick-msg' }, '');
  const run = async (type, btn) => {
    if (busy) return; // 2回タップで2回反映しない
    busy = true;
    btn.disabled = true;
    const q = qty;
    try {
      const res = await recordTransaction(partId, { type, quantity: q, note: 'その場で記録' }, txIds.get(type, q));
      txIds.done(type, q);
      msg.textContent = '';
      onDone(res, { type, quantity: q });
      if (res?.queued) {
        // 画面を作り直さない（電波が無い）ときは、続けて別の記録ができるようにボタンを戻す。
        // 戻さないと、1回記録した後はボタンが押せないままで、画面を開き直すまで記録できなかった
        btn.disabled = false;
        setQty(1);
      }
    } catch (err) {
      msg.textContent = `記録できませんでした: ${err.message}`;
      msg.style.color = '#dc2626';
      btn.disabled = false; // 失敗したときだけ押し直せる（同じ番号で再送するので2回反映しない）
    } finally {
      busy = false;
    }
  };
  const outBtn = el('button', { class: 'btn btn-primary quick-btn', type: 'button', onclick: (e) => run('out', e.currentTarget) }, '📤 出庫（使う）');
  const inBtn = el('button', { class: 'btn quick-btn', type: 'button', onclick: (e) => run('in', e.currentTarget) }, '📥 入庫');
  return el('div', { class: 'card quick-record' }, [
    el('h3', { class: 'card-title' }, 'その場で記録'),
    el('div', { class: 'quick-qty' }, [
      el('button', { class: 'btn quick-step', type: 'button', 'aria-label': '数量を減らす', onclick: () => setQty(qty - 1) }, '−'),
      qtyEl,
      el('button', { class: 'btn quick-step', type: 'button', 'aria-label': '数量を増やす', onclick: () => setQty(qty + 1) }, '＋'),
    ]),
    el('div', { class: 'quick-actions' }, [outBtn, inBtn]),
    msg,
  ]);
}

// 電波が無くて部品の内容を取れないとき（QR を倉庫で読んだ等）の画面。記録は送信待ちに保存する
async function renderOfflineDetail(id) {
  const snap = loadSnapshot(id);
  const queued = await queuedFor(id);
  const queuedBox = el('p', { class: 'notice is-warning offline-queued' },
    queued.length ? `📤 送信待ち: ${queuedText(queued)}（電波が戻ると自動で送信します）` : '');
  if (!queued.length) queuedBox.style.display = 'none';
  render(app, [
    el('p', { class: 'notice is-warning' }, '📵 オフラインのため最新の在庫を表示できません。入庫・出庫は送信待ちに保存し、電波が戻ると自動で送信します。'),
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, snap ? snap.name : `部品 #${id}`),
      snap ? infoRow('型番', snap.model_no) : null,
      snap ? infoRow('在庫場所', snap.location) : null,
      snap
        ? infoRow('在庫数（目安）', `${snap.quantity}（${formatDateTime(snap.at)} にこの端末で確認した数）`)
        : el('p', { class: 'hint' }, 'この端末ではまだこの部品を開いたことがないため、名前と在庫数は電波が戻ってから表示されます。'),
    ]),
    queuedBox,
    // 閲覧のみと分かっている端末には記録欄を出さない（送信してもサーバーが拒否して失敗が溜まるだけのため）。
    // 権限を確認できていない端末は今までどおり出す（権限はサーバーが送信時に確認する）
    getCachedRole() === 'viewer'
      ? el('p', { class: 'notice is-warning' }, 'この端末では「閲覧のみ」の権限のため、入庫・出庫は記録できません。')
      : buildQuickRecord(id, async (res, op) => {
      const items = await queuedFor(id);
      queuedBox.textContent = `📤 送信待ち: ${queuedText(items)}（電波が戻ると自動で送信します）`;
      queuedBox.style.display = '';
      if (!res?.queued) {
        // 電波が戻っていて、そのまま記録できた。権限情報が無いままだと記録欄や編集ボタンが出ないので、取り直す
        currentUser = await getCurrentUser().catch(() => currentUser);
        await renderDetail(id).catch(() => {});
      } else {
        alert(`${op.type === 'in' ? '入庫' : '出庫'} ${op.quantity} を送信待ちに保存しました。`);
      }
    }),
  ]);
}

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

function buildOrderEmail(part, orderQty, dueDate) {
  const subject = `【発注依頼】${part.name}`;
  const lines = [
    '〇〇会社　〇〇様',
    '',
    'いつもお世話になっています。',
    '',
    '下記の部品の発注をお願いいたします。',
    '',
    `部品名: ${part.name}`,
  ];
  if (part.model_no) lines.push(`型式: ${part.model_no}`);
  if (part.supplier) lines.push(`メーカー名: ${part.supplier}`);
  lines.push(`希望発注数量: ${orderQty}`);
  if (dueDate) lines.push(`希望納期: ${dueDate.replace(/-/g, '/')}`);
  lines.push(
    '',
    'よろしくお願いいたします。',
  );
  return { subject, body: lines.join('\n') };
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

// 発注ダイアログ（希望数量・自動生成された本文プレビュー）宛先はメール起動後に入力
//   メール作成ボタンを押すと「発注中」バッジを付ける（チェックで無効化可）。
//   バッジは入庫（＋の入庫記録）で自動的に外れる。onOrdered は画面の再読込用コールバック。
function openOrderDialog(part, onOrdered) {
  const shortfall = Math.max((part.safety_stock || 0) - (part.quantity || 0), 1);
  const qtyInput = el('input', { type: 'number', min: '1', value: String(shortfall), style: 'width:120px' });
  const dueDateInput = el('input', { type: 'date' });
  const preview = el('textarea', { rows: '12', readonly: true });
  const orderedCheck = el('input', { type: 'checkbox', checked: !part.ordered_at });

  const refresh = () => {
    const qty = Math.max(parseInt(qtyInput.value, 10) || 1, 1);
    const mail = buildOrderEmail(part, qty, dueDateInput.value);
    preview.value = `件名: ${mail.subject}\n\n${mail.body}`;
    return mail;
  };
  qtyInput.addEventListener('input', refresh);
  dueDateInput.addEventListener('input', refresh);

  // メール起動と同時に「発注中」を記録（失敗してもメール作成は妨げない）
  const markOrdered = () => {
    if (!orderedCheck.checked) return;
    api.post(`/api/parts/${part.id}/order`, { ordered: true })
      .then(() => { if (onOrdered) onOrdered(); })
      .catch(() => { /* バッジ付与の失敗は致命的でないため無視 */ });
  };

  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  // 宛先は部品マスタに登録済みの仕入先メール（あれば）を自動セットする（毎回の手入力を省く）
  const supplierEmail = part.supplier_email || '';

  const modal = el('div', { class: 'modal' }, [
    el('h3', { class: 'modal-title' }, `発注メールの作成: ${part.name}`),
    part.ordered_at
      ? el('p', { class: 'notice is-warning', style: 'margin:0 0 8px' },
          `📨 この部品は発注中です（${formatDateTime(part.ordered_at)}）。二重発注にご注意ください。`)
      : null,
    el('div', { class: 'field' }, [el('label', {}, '希望発注数量'), qtyInput]),
    el('div', { class: 'field' }, [el('label', {}, '希望納期（任意）'), dueDateInput]),
    el('div', { class: 'field' }, [el('label', {}, '本文プレビュー（自動生成）'), preview]),
    el('label', { class: 'pf-input-check' }, [orderedCheck, ' メール作成と同時に「発注中」バッジを付ける（入庫で自動解除）']),
    el('p', { class: 'hint' },
      supplierEmail
        ? `宛先は仕入先メール（${supplierEmail}）が自動入力されます。違う場合はメール起動後に修正してください。`
        : '宛先は未登録のため空欄で開きます（部品編集画面で仕入先メールを登録すると次回から自動入力されます）。'
    ),
    el('p', { class: 'hint' }, 'PCはOutlook Web、スマホはOutlookアプリの作成画面を開きます。開かない場合は「メールアプリで開く」をお使いください。'),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-primary', onclick: () => { const m = refresh(); openInOutlook(supplierEmail, m.subject, m.body); markOrdered(); } }, '📧 Outlookで作成'),
      el('button', { class: 'btn', onclick: () => { const m = refresh(); openInMailto(supplierEmail, m.subject, m.body); markOrdered(); } }, 'メールアプリで開く'),
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
  let similarParts = []; // 在庫検索の「類似の在庫」（キーワードの一部に一致）
  let timer = null;

  // 棚卸モード: 一覧の行を「帳簿数 → 実数入力」に切り替え、差異だけを一括で
  // 棚卸調整（type=adjust）として確定する。入力値はフィルタ変更をまたいで保持する
  let stocktakeMode = false;
  const stocktakeInputs = new Map(); // part_id → input要素（値の保持と差異集計に使う）

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
        openOrderDialog(p, () => load().catch(showError)); // 発注中にしたら一覧を更新
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
        // 発注中バッジ（入庫で自動解除）。二重発注の防止用
        p.ordered_at ? el('span', {
          class: 'status-badge',
          style: 'font-size:10px;padding:1px 6px;background:#dbeafe;color:#1e40af',
          title: `発注中（${formatDateTime(p.ordered_at)}）`,
        }, '📨 発注中') : null,
      ]),
      orderBtn,
      editBtn,
      delBtn,
      el('span', { class: 'chevron' }, '›'),
    ]);
  };

  // ---- 棚卸モードの行（帳簿数 → 実数入力。差異行は赤背景＋差分バッジ） ----
  const makeStocktakeRow = (p) => {
    let input = stocktakeInputs.get(p.id);
    if (!input) {
      input = el('input', {
        type: 'number', inputmode: 'numeric', min: '0', max: '1000000', step: '1',
        value: String(p.quantity),
        class: 'stocktake-input',
      });
      stocktakeInputs.set(p.id, input);
    }
    const diffBadge = el('span', { class: 'abn-badge is-abn', style: 'font-size:10px;padding:1px 6px', hidden: true }, '');
    const row = el('div', { class: 'list-item stocktake-row' }, [
      el('div', { class: 'list-item-main' }, [
        el('div', { class: 'list-item-title' }, p.name),
        p.model_no ? el('div', { class: 'list-item-sub' }, `型番: ${p.model_no}`) : null,
      ]),
      el('span', { class: 'book-qty' }, `帳簿 ${p.quantity} →`),
      input,
      diffBadge,
    ]);
    const refresh = () => {
      const v = Number(input.value);
      const diff = input.value !== '' && Number.isInteger(v) && v >= 0 && v !== p.quantity;
      row.classList.toggle('is-diff', diff);
      diffBadge.hidden = !diff;
      if (diff) diffBadge.textContent = `${v - p.quantity > 0 ? '+' : ''}${v - p.quantity}`;
      updateStocktakeBar();
    };
    input.oninput = refresh;
    refresh();
    return row;
  };

  // 差異の集計（入力済み・0以上の整数・帳簿数と異なるもの）
  const collectStocktakeDiffs = () => {
    const diffs = [];
    for (const p of allParts) {
      const inp = stocktakeInputs.get(p.id);
      if (!inp || inp.value === '') continue;
      const v = Number(inp.value);
      if (Number.isInteger(v) && v >= 0 && v !== p.quantity) diffs.push({ part: p, actual: v });
    }
    return diffs;
  };

  const stocktakeBar = el('div', { class: 'stocktake-bar', style: 'display:none' }, []);

  const updateStocktakeBar = () => {
    if (!stocktakeMode) return;
    const diffs = collectStocktakeDiffs();
    const confirmBtn = el('button', {
      class: 'btn btn-primary',
      disabled: diffs.length === 0,
      onclick: async (e) => {
        if (!confirm(`差異のある ${diffs.length}件を棚卸調整として確定します。よろしいですか？\n（入出庫履歴に「棚卸」として記録されます）`)) return;
        e.currentTarget.disabled = true;
        let ok = 0, ng = 0;
        for (const d of diffs) {
          try {
            await api.post(`/api/parts/${d.part.id}/transaction`, { type: 'adjust', quantity: d.actual, note: '棚卸' });
            stocktakeInputs.delete(d.part.id); // 確定できた行の入力は役目を終えた（再読込後は新しい帳簿数で作り直す）
            ok++;
          } catch { ng++; }
        }
        if (ng === 0) {
          alert(`棚卸を確定しました: ${ok}件更新`);
          setStocktake(false);
        } else {
          // 失敗した行は実数の入力を残したまま棚卸モードを続ける（数え直さずに再実行できるように）
          alert(`棚卸を確定しました: ${ok}件更新 ／ ${ng}件失敗\n失敗した行は入力した実数を残しています。通信環境を確認して、もう一度「一括確定」を押してください。`);
        }
        await load();
      },
    }, `差異 ${diffs.length}件を一括確定`);
    render(stocktakeBar, [
      el('span', { class: 'hint' }, '実数を入力（差異のある行だけ更新されます）'),
      confirmBtn,
    ]);
  };

  const setStocktake = (on) => {
    stocktakeMode = on;
    stocktakeInputs.clear();
    stocktakeToggle.classList.toggle('btn-primary', on);
    stocktakeToggle.textContent = on ? '📋 棚卸を終了' : '📋 棚卸';
    stocktakeBar.style.display = on ? '' : 'none';
    listBox.style.paddingBottom = on ? '70px' : ''; // 固定バーで最終行が隠れないように
    if (on) updateStocktakeBar();
    renderParts();
  };

  // 部品配列を 設備名→機器名 でグループ化したノード配列を作る（APIはソート済み）。
  //   rowBuilder を差し替えられるようにして、通常行・棚卸行・閲覧専用行を使い分ける。
  const buildGroupNodes = (parts, rowBuilder) => {
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
        nodes.push(el('div', { class: 'row-list' }, equipParts.map(rowBuilder)));
      }
    }
    return nodes;
  };

  // 部品配列を listBox に描画する
  const renderGroups = (parts) => {
    if (parts.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '部品が見つかりません。'));
      return;
    }
    render(listBox, buildGroupNodes(parts, stocktakeMode ? makeStocktakeRow : makePartRow));
  };

  // 検索結果を「一致した在庫」＋「類似の在庫」の2段で描画する（在庫検索）。
  //   類似はキーワードの一部だけ一致する在庫。棚卸対象にはしない（閲覧専用の行で表示）。
  const renderSearchResults = () => {
    if (allParts.length === 0 && similarParts.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '部品が見つかりません。'));
      return;
    }
    const nodes = [];
    if (allParts.length > 0) {
      nodes.push(...buildGroupNodes(allParts, stocktakeMode ? makeStocktakeRow : makePartRow));
    }
    if (similarParts.length > 0) {
      nodes.push(el('div', {
        class: 'similar-divider',
        style: 'margin:16px 0 4px;padding-top:10px;border-top:1px dashed var(--color-border,#d1d5db);font-weight:600;color:var(--color-text-sub,#6b7280);font-size:13px',
      }, `類似の在庫（キーワードの一部に一致・${similarParts.length}件）`));
      // 類似は閲覧専用の行（makePartRow）で表示する（棚卸の入力・集計対象にしない）
      nodes.push(...buildGroupNodes(similarParts, makePartRow));
    }
    render(listBox, nodes);
  };

  // 表示する部品を「設備 → 機器」の2段階選択で決める。
  //   ・検索キーワードがあるときは、選択に関係なく該当部品を全件表示（名前で探す用途）
  //   ・設備未選択: 要発注フィルタ中のみ全件、それ以外は設備選択を促す
  //   ・設備を選んでも、機器を選ぶまでは部品を表示しない（「すべての機器」で設備全件）
  const renderParts = () => {
    if (searchQuery) { renderSearchResults(); return; }

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

  // quiet: 自動更新のとき「読み込み中…」を出さない（画面がちらつかないように）
  const load = async ({ quiet = false } = {}) => {
    if (!quiet) render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const params = new URLSearchParams();
    if (searchQuery) { params.set('q', searchQuery); params.set('include_similar', '1'); }
    if (filterLow) params.set('low_stock', '1');
    const resp = await api.get(`/api/parts${params.toString() ? '?' + params : ''}`);
    allParts = resp.parts;
    similarParts = resp.similar || [];
    refreshLineOptions();
    refreshEquipOptions();
    renderParts();
    refreshedEl.textContent = `${formatDateTime(new Date().toISOString())} 時点（${AUTO_REFRESH_MS / 1000}秒ごとに自動更新）`;
  };
  const refreshedEl = el('span', { class: 'hint parts-refreshed' }, '');

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

  // 設備台帳にあって部品が未登録の設備をプレースホルダーとして一括追加する
  const importFromEquipment = async (btn) => {
    if (!confirm('設備台帳にある設備のうち、まだ部品が1件も登録されていないものを\nプレースホルダーとして追加します。よろしいですか？\n（追加後に部品名・型番などを個別に編集してください）')) return;
    btn.disabled = true;
    btn.textContent = '登録中…';
    try {
      const res = await api.post('/api/parts/import-from-equipment', {});
      // 追加した分がすぐ見えるよう「すべての設備を表示」に切り替える
      if (res.created > 0) { selectedLine = ALL_LINES; selectedEquip = ''; }
      alert(res.created > 0
        ? `${res.created}件の設備のプレースホルダーを追加しました。\n部品名・型番などを各編集画面から登録してください。`
        : (res.message || '新規に追加する設備はありませんでした。'));
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📥 台帳から一括登録';
    }
  };

  // 棚卸モードの切替（editor以上）。実数を入力して差異だけ一括確定する
  const stocktakeToggle = el('button', { class: 'btn', onclick: () => setStocktake(!stocktakeMode) }, '📋 棚卸');

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
      el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openQrScanner() }, '📷 部品QR'),
    ]),
    refreshedEl,
    hasRole(currentUser, 'editor')
      ? el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
          el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 部品を追加'),
          el('button', { class: 'btn', onclick: () => go('?import=1') }, '📥 CSVインポート'),
          el('button', { class: 'btn', onclick: (e) => importFromEquipment(e.currentTarget) }, '📥 台帳から一括登録'),
          stocktakeToggle,
          el('a', { class: 'btn', href: '/pages/labels?type=parts' }, '🏷 部品ラベル印刷'),
        ])
      : null,
    listBox,
    stocktakeBar,
  ]);
  await load();

  // 自動更新: 画面を開いている間は一定間隔で在庫を取り直す（他の人の入出庫を反映）。
  // 棚卸中・入力中は入力を消さないよう更新しない。裏に回っている間・オフラインの間も止める
  setInterval(() => {
    if (document.visibilityState !== 'visible' || navigator.onLine === false || stocktakeMode) return;
    const active = document.activeElement;
    if (active && app.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
    if (document.querySelector('.modal-backdrop, .sheet-backdrop, .order-dialog')) return;
    load({ quiet: true }).catch(() => { /* 次の回に再試行 */ });
  }, AUTO_REFRESH_MS);
}

// ---------------- 詳細（入出庫履歴） ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

let detailTimer = null;

async function renderDetail(id) {
  let data;
  try {
    data = await api.get(`/api/parts/${id}`);
  } catch (err) {
    if (err?.offline === true || navigator.onLine === false) { await renderOfflineDetail(id); return; }
    throw err;
  }
  const { part, transactions, equipment: linkedEquipment } = data;
  saveSnapshot(part);
  const canEdit = hasRole(currentUser, 'editor');
  const isLow = part.quantity < part.safety_stock; // 在庫数 < 必要数 で要発注
  const queued = await queuedFor(id);
  const txIds = makeTxIdPool(); // 下の「在庫数を更新」フォームの識別番号
  const updatedAt = new Date();

  // 在庫数更新フォーム
  const txTypeEl = el('select', {},
    [['in', '入庫（＋）'], ['out', '出庫（－）'], ['adjust', '棚卸調整（絶対値）']].map(([v, l]) =>
      el('option', { value: v }, l)
    )
  );
  const txQtyEl = el('input', { type: 'number', min: '1', max: '1000000', value: '1', style: 'width:100px' });
  const txNoteEl = el('input', { type: 'text', placeholder: 'メモ（任意）' });

  const doTransaction = async () => {
    const type = txTypeEl.value;
    const quantity = parseInt(txQtyEl.value, 10);
    const note = txNoteEl.value.trim() || null;
    if (!quantity || quantity < 1) { alert('数量は1以上を入力してください。'); return; }
    // 更新中はボタンを無効化（2回タップで出庫が2回反映され在庫数がずれるため）
    if (txBtn.disabled) return;
    txBtn.disabled = true;
    try {
      const res = await recordTransaction(id, { type, quantity, note }, txIds.get(type, quantity));
      if (res?.queued) alert('オフラインのため送信待ちに保存しました。電波が戻ると自動で送信します。');
      go(`?id=${id}`);
    } catch (err) {
      alert(err.message);
      txBtn.disabled = false; // 失敗したときだけ押し直せるようにする（同じ識別番号で再送するので2回反映しない）
    }
  };
  const txBtn = el('button', { class: 'btn btn-primary', onclick: doTransaction }, '更新');

  const TYPE_LABELS = { in: '入庫', out: '出庫', adjust: '調整' };

  // 部品QR（読むとこの画面が開き、「その場で記録」で出庫・入庫できる）
  const partUrl = `${window.location.origin}/pages/parts?id=${part.id}`;
  const qr = qrcode(0, 'Q');
  qr.addData(partUrl);
  qr.make();

  const refreshedEl = el('span', { class: 'hint parts-refreshed' }, `${formatDateTime(updatedAt.toISOString())} 時点の在庫（${AUTO_REFRESH_MS / 1000}秒ごとに自動更新）`);

  render(app, [
    queued.length
      ? el('p', { class: 'notice is-warning offline-queued' }, `📤 送信待ち: ${queuedText(queued)}（電波が戻ると自動で送信します。在庫数にはまだ入っていません）`)
      : null,
    canEdit
      ? buildQuickRecord(id, (res, op) => {
          if (res?.queued) alert(`オフラインのため ${op.type === 'in' ? '入庫' : '出庫'} ${op.quantity} を送信待ちに保存しました。`);
          renderDetail(id).catch(showError);
        })
      : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, [part.name, importanceBadge(part.importance)]),
        part.ordered_at
          ? el('span', { class: 'status-badge', style: 'background:#dbeafe;color:#1e40af' }, '📨 発注中')
          : null,
        isLow
          ? el('span', { class: 'abn-badge is-abn' }, '要発注')
          : el('span', { class: 'abn-badge' }, '在庫あり'),
      ]),
      part.ordered_at
        ? infoRow('発注状態', `発注中（${formatDateTime(part.ordered_at)}・${maskEmail(part.ordered_by) || '—'}）— 入庫で自動解除`)
        : null,
      infoRow('設備名', part.line_name),
      infoRow('機器名', part.equipment_name),
      infoRow('型番', part.model_no),
      infoRow('在庫数', String(part.quantity)),
      refreshedEl,
      infoRow('必要数', String(part.safety_stock)),
      infoRow('重要度', part.importance),
      infoRow('在庫場所', part.location),
      infoRow('仕入れ先', part.supplier),
      infoRow('仕入先メール', part.supplier_email),
      infoRow('備考', part.note),
    ]),
    linkedEquipment
      ? el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, '対象設備（設備台帳）'),
          el('a', { class: 'list-item', href: `/pages/ledger?id=${linkedEquipment.id}` }, [
            el('div', { class: 'list-item-main' }, [
              el('div', { class: 'list-item-title' }, linkedEquipment.name),
              el('div', { class: 'list-item-sub' }, linkedEquipment.code),
            ]),
            el('span', { class: 'chevron' }, '›'),
          ]),
        ])
      : null,
    canEdit
      ? el('div', { class: 'action-row' }, [
          el('button', { class: isLow ? 'btn btn-primary' : 'btn', onclick: () => openOrderDialog(part, () => renderDetail(id).catch(showError)) }, '📧 発注メールを作成'),
          part.ordered_at
            ? el('button', {
                class: 'btn',
                onclick: async () => {
                  if (!confirm('「発注中」を解除しますか？（入庫時は自動で解除されます）')) return;
                  try {
                    await api.post(`/api/parts/${id}/order`, { ordered: false });
                    await renderDetail(id);
                  } catch (err) { alert(err.message); }
                },
              }, '発注中を解除')
            : null,
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
          txBtn,
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
      el('h3', { class: 'card-title' }, '部品QRコード'),
      el('div', { class: 'qr-box' }, [el('img', { class: 'qr-img', alt: `部品QRコード: ${part.name}`, src: qr.createDataURL(6, 4) })]),
      el('p', { class: 'hint' }, '棚や部品箱に貼っておくと、読み取ってすぐ出庫・入庫を記録できます（電波が無くても送信待ちに保存）。'),
      el('a', { class: 'btn btn-sm', href: `/pages/labels?type=parts&ids=${part.id}` }, '🏷 ラベルを印刷'),
    ]),
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
                el('span', {}, maskEmail(t.created_by)),
                el('span', { class: 'list-item-sub' }, formatDateTime(t.created_at)),
                t.note ? el('span', { class: 'list-item-sub' }, t.note) : null,
              ])
            )
          ),
    ]),
  ]);

  // 自動更新: 画面を開いている間は一定間隔で取り直す（他の人の入出庫を反映）。入力中は邪魔しない
  clearInterval(detailTimer);
  detailTimer = setInterval(() => {
    if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
    const active = document.activeElement;
    const typing = active && app.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
    const touched = txQtyEl.value !== '1' || txNoteEl.value !== '' || txTypeEl.value !== 'in';
    if (typing || touched || txBtn.disabled || document.querySelector('.quick-qty-value')?.textContent !== '1') return;
    renderDetail(id).catch(() => { /* 次の回に再試行 */ });
  }, AUTO_REFRESH_MS);
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
    safety_stock: el('input', { type: 'number', min: '0', max: '1000000', value: String(existing?.safety_stock ?? 0) }),
    quantity: el('input', { type: 'number', min: '0', max: '1000000', value: String(existing?.quantity ?? 0) }),
    importance: impSelect,
    supplier: el('input', { type: 'text', value: existing?.supplier || '' }),
    supplier_email: el('input', { type: 'email', value: existing?.supplier_email || '', placeholder: '発注メールの宛先（任意）' }),
    note: el('textarea', { value: existing?.note || '' }),
  };

  // ---- 類似部品のヒント（あいまい検索で重複登録を防ぐ。保存は妨げない） ----
  //   型番は設計上重複可（ライン/機器ごとに別行）なので「重複」ではなく「類似」と表現する。
  const dupBox = el('div', {});
  let dupTimer = null;
  const checkDuplicates = () => {
    clearTimeout(dupTimer);
    dupTimer = setTimeout(async () => {
      const q = [f.name.value.trim(), f.model_no.value.trim()].filter(Boolean).join(' ');
      if (q.length < 2) { render(dupBox, []); return; }
      try {
        const params = new URLSearchParams({ q });
        if (existing) params.set('exclude_id', String(existing.id)); // 編集中は自分自身を除外
        const { parts } = await api.get(`/api/parts?${params}`);
        const hits = (parts || []).slice(0, 5);
        if (hits.length === 0) { render(dupBox, []); return; }
        render(dupBox, el('div', { class: 'notice is-warning' }, [
          el('div', { style: 'font-weight:600;margin-bottom:6px' }, '類似の部品が見つかりました（型番・部品名が近い登録があります）'),
          el('div', { class: 'row-list' }, hits.map((p) =>
            el('a', { class: 'list-item', href: `/pages/parts?id=${p.id}`, target: '_blank', rel: 'noopener' }, [
              el('div', { class: 'list-item-main' }, [
                el('div', { class: 'list-item-title' }, [p.name, importanceBadge(p.importance)].filter(Boolean)),
                el('div', { class: 'list-item-sub' },
                  [
                    p.model_no ? `型番: ${p.model_no}` : '',
                    [p.line_name, p.equipment_name].filter(Boolean).join(' '),
                    `在庫: ${p.quantity ?? 0}`,
                  ].filter(Boolean).join(' / ')),
              ]),
              el('span', { class: 'chevron' }, '›'),
            ])
          )),
        ]));
      } catch { render(dupBox, []); } // 取得失敗時は非表示で継続
    }, 300);
  };
  f.name.addEventListener('input', checkDuplicates);
  f.model_no.addEventListener('input', checkDuplicates);

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
      // 同時編集ガード: 編集開始時点の updated_at を送り、他の人が先に更新していたら409で知らせる
      ...(existing ? { expected_updated_at: existing.updated_at } : {}),
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
      dupBox,
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

  // 編集時は初期の部品名・型番で類似部品を出す（新規は空欄なので何も出ない）
  checkDuplicates();
}

// ---------------- CSVインポート ----------------

async function renderImport() {
  if (!hasRole(currentUser, 'editor')) throw new Error('権限がありません。');

  const COLS = ['line_name', 'equipment_name', 'name', 'model_no', 'location', 'safety_stock', 'quantity', 'importance', 'supplier', 'note'];
  const COL_LABELS = {
    line_name: '設備名', equipment_name: '機器名', name: '部品名', model_no: '型番',
    location: '在庫場所', safety_stock: '必要数', quantity: '在庫数', importance: '重要度',
    supplier: '仕入れ先', note: '備考',
  };

  let csvHeaders = [];
  let csvRows = [];
  let mapping = {};
  // 全置き換え（全部品を作り直す）は管理者のみ。入力可（editor）は差分マージだけ使える（サーバー側でも403）
  const canReplace = hasRole(currentUser, 'admin');
  let importMode = canReplace ? 'replace' : 'merge'; // 'replace' | 'merge'

  const mappingBox = el('div', {}, []);
  const previewBox = el('div', {}, []);
  const resultBox  = el('div', {}, []);
  const importBtn  = el('button', { class: 'btn btn-primary', disabled: true }, '取込実行');

  // CSVのバイト列を文字コード自動判定で文字列化する（Excel/SharePoint由来の
  // Shift_JIS と UTF-8 の両方に対応）。encoding-japanese 未読込時は UTF-8 とみなす。
  const decodeCsvBuffer = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let text;
    if (typeof Encoding !== 'undefined') {
      const detected = Encoding.detect(bytes) || 'AUTO';
      const unicode = Encoding.convert(bytes, { to: 'UNICODE', from: detected });
      text = Encoding.codeToString(unicode);
    } else {
      text = new TextDecoder('utf-8').decode(bytes);
    }
    return text.replace(/^﻿/, ''); // 先頭のBOMを除去
  };

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

  // CSV内で重複する型番（model_no）を検出する
  const detectDuplicates = () => {
    const modelNoIdx = mapping['model_no'];
    if (modelNoIdx === '' || modelNoIdx === undefined) return [];
    const counts = new Map();
    for (const row of csvRows) {
      const v = row[Number(modelNoIdx)]?.trim();
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([v, n]) => `${v}（${n}件）`);
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

    const dups = detectDuplicates();
    const dupWarn = dups.length > 0
      ? el('p', { class: 'notice is-error', style: 'margin:8px 0;font-size:12px' },
          `⚠ CSV内で型番が重複しています: ${dups.join(' / ')}（先着の行を優先します）`)
      : null;

    render(previewBox, [
      el('p', { style: 'font-size:13px;color:#64748b;margin:8px 0' }, `${csvRows.length}行を検出（先頭5件プレビュー）`),
      dupWarn,
      el('div', { style: 'overflow-x:auto' }, [
        el('table', { class: 'import-table' }, [
          el('thead', {}, [el('tr', {}, COLS.map((c) => el('th', {}, COL_LABELS[c])))]),
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
          onchange: (e) => { mapping[field] = e.target.value; buildPreview(); },
        }, [
          el('option', { value: '' }, '— 対応なし'),
          ...csvHeaders.map((h, i) => el('option', { value: i }, `[${i + 1}] ${h}`)),
        ]);
        const autoIdx = csvHeaders.findIndex(
          (h) => h.toLowerCase().replace(/[\s_-]/g, '') === field.toLowerCase()
            || h === COL_LABELS[field]
        );
        if (autoIdx >= 0) { sel.value = autoIdx; mapping[field] = autoIdx; }
        else { mapping[field] = ''; }
        return el('div', { class: 'field-pair' }, [
          el('div', { class: 'field', style: 'flex:0 0 100px' }, [el('label', {}, COL_LABELS[field])]),
          el('div', { class: 'field', style: 'flex:1' }, [sel]),
        ]);
      }),
    ]);
    buildPreview();
  };

  importBtn.onclick = async () => {
    // 型番重複を除去（先着優先）
    const seen = new Set();
    const rows = csvRows.map((row) => {
      const obj = {};
      for (const [field, idx] of Object.entries(mapping)) {
        if (idx !== '') obj[field] = row[Number(idx)]?.trim() || '';
      }
      return obj;
    }).filter((r) => {
      if (!r.name) return false;
      const key = r.model_no || '';
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });

    if (rows.length === 0) { alert('取り込める行がありません（部品名が必須です）。'); return; }

    const modeLabel = importMode === 'merge' ? '差分マージ（追加・更新のみ）' : '全置き換え';
    const confirmMsg = importMode === 'merge'
      ? `差分マージを実行します。\n・型番が一致する既存部品は更新されます\n・CSV に新規型番は追加されます\n・CSV にない既存部品は変更されません\n（CSV ${rows.length}件）\n実行しますか？`
      : `既存の部品データをすべて削除し、CSV ${rows.length}件で置き換えます。\nこの操作は元に戻せます（削除済みデータから復元可能）が、現在の在庫数は上書きされます。\n実行しますか？`;
    if (!confirm(confirmMsg)) return;

    importBtn.disabled = true;
    importBtn.textContent = '取込中…';
    try {
      const result = await api.post('/api/parts/import', { rows, mode: importMode });
      const summary = importMode === 'merge'
        ? `✅ 差分マージ完了: 新規追加 ${result.inserted}件・更新 ${result.updated ?? 0}件（スキップ${result.skipped}件）`
        : `✅ 全置き換え完了: 既存${result.deleted ?? 0}件を削除 → 新規${result.inserted}件を登録（スキップ${result.skipped}件）`;
      render(resultBox, [
        el('div', { class: 'notice' }, [
          el('p', {}, summary),
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

  // 取込モードセレクタ
  const modeSelect = el('select', {
    onchange: (e) => {
      importMode = e.target.value;
      // モードごとに警告文を切り替え
      modeWarnEl.style.display = importMode === 'replace' ? '' : 'none';
      mergeTipEl.style.display  = importMode === 'merge'   ? '' : 'none';
    },
  }, [
    canReplace ? el('option', { value: 'replace' }, '全置き換え（既存データを削除して CSV で再作成）') : null,
    el('option', { value: 'merge' },   '差分マージ（型番一致で更新・新規のみ追加）'),
  ]);

  const modeWarnEl = el('p', { class: 'notice is-error', style: `margin-bottom:8px${importMode === 'replace' ? '' : ';display:none'}` },
    '⚠ 既存の部品データはすべて置き換えられます。CSVの内容が新しい正データになります（現在の在庫数も上書き）。');
  const mergeTipEl = el('p', { class: 'notice', style: `margin-bottom:8px${importMode === 'merge' ? '' : ';display:none'}` },
    'ℹ 型番（model_no）が一致する既存部品は更新されます。CSV にない既存部品はそのまま残ります。型番が空の行は常に新規追加されます。');

  const fileInput = el('input', {
    type: 'file',
    accept: '.csv,text/csv',
    onchange: (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const parsed = parseCSV(decodeCsvBuffer(ev.target.result));
        if (parsed.length < 2) { alert('CSVの行数が不足しています。'); return; }
        csvHeaders = parsed[0];
        csvRows = parsed.slice(1);
        mapping = {};
        buildMapping();
      };
      // バイト列で読み、文字コード（UTF-8 / Shift_JIS）を自動判定して文字列化する
      reader.readAsArrayBuffer(file);
    },
  });

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, 'CSVインポート'),
      el('div', { class: 'field' }, [el('label', {}, '取込モード'), modeSelect]),
      modeWarnEl,
      mergeTipEl,
      el('p', { class: 'hint' }, '1行目をヘッダー行とするCSVファイルを選択してください（UTF-8 / Shift_JIS 両対応）。CSVにない項目は空欄で取り込みます（部品名のみ必須）。'),
      el('div', { class: 'field' }, [el('label', {}, 'CSVファイル'), fileInput]),
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
  const params = new URLSearchParams(window.location.search);
  try {
    try {
      currentUser = await getCurrentUser();
    } catch (err) {
      // 電波の無い倉庫で部品QRを読んだ: 送信待ちに記録できる画面を出す（権限はサーバーが送信時に確認する）
      if (params.get('id') && (err?.offline === true || navigator.onLine === false)) {
        await renderOfflineDetail(Number(params.get('id')));
        return;
      }
      throw err;
    }
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
