// オフライン送信キュー（IndexedDB）— 圏外・オフラインでも入力を失わず、復帰時に自動送信する
//
//   仕組み:
//     1. 点検・トラブルの新規保存がオフラインで失敗（または最初からオフライン）
//        → enqueue() で本文と写真（リサイズ済みBlob）を IndexedDB に保存
//     2. オンライン復帰（online イベント）・ページ起動時に flushOutbox() が自動送信
//        （写真アップロード → file_ids → 本体POST。点検は連動する計画の完了化も行う）
//     3. 送信待ちがある間は画面下に「📤 送信待ち N件」バーを表示（タップで即時送信）
//
//   注意:
//     - 対象は「新規作成」のみ（編集はサーバーに元データがあるため対象外）
//     - 送信は端末ごと（この端末で入力したものはこの端末がオンラインになったとき送信）
//     - オフライン以外のエラー（権限・検証など）で失敗した記録は 'failed' として残し、
//       バーから再試行できる（自動では再送し続けない）

import { api } from '/js/api.js';
import { uploadFile } from '/js/files.js';
import { completePlanAfterInspection } from '/js/plan-inspection-link.js';

const DB_NAME = 'mainte-offline';
const STORE = 'outbox';

const KIND_LABELS = { trouble: 'トラブル記録', inspection: '点検記録', repair: '業務依頼', report: '日報', parts_tx: '部品の入出庫' };

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function getAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 送信待ちに追加する。
 * @param {'trouble'|'inspection'|'repair'|'report'|'parts_tx'} kind
 * @param {object} payload 本体POSTのボディ（file_ids は含めない）
 * @param {File[]} files リサイズ済みの添付（Canvasリサイズはオフラインでも動く）
 * @param {object} [extra] 例: { planId, planDay } 点検保存後に完了化する計画ID（planDay があればその日だけ）
 */
/** 送信待ちのうち指定した種別の項目（画面で「送信待ち ◯件」を出す用。取得できなければ空） */
export async function listQueued(kind) {
  try { return (await getAll()).filter((i) => i.kind === kind); } catch { return []; }
}

export async function enqueue(kind, payload, files = [], extra = {}) {
  const db = await openDb();
  const record = {
    kind,
    payload,
    files: files.map((f) => ({ name: f.name || 'file', type: f.type || 'application/octet-stream', blob: f })),
    extra,
    status: 'pending',
    error: null,
    created_at: new Date().toISOString(),
  };
  await tx(db, 'readwrite', (store) => store.add(record));
  updateBar();
}

async function removeItem(id) {
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.delete(id));
}

async function updateItem(item) {
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.put(item));
}

// ---------------- 送信 ----------------

let flushing = false;

async function sendOne(item) {
  // 写真を先にアップロードして file_ids を集める
  // （キュー投入前にアップロード済みの分が payload.file_ids に入っていることがあるためマージする）
  // 1枚アップロードするごとに進捗を IndexedDB へ保存する。途中で本体POSTが失敗しても、
  // 再試行時はアップロード済みの写真を再送しない（二重アップロード・R2孤児ファイルを防ぐ）
  const fileIds = [...(item.payload?.file_ids || [])];
  while ((item.files || []).length > 0) {
    const f = item.files[0];
    const file = new File([f.blob], f.name, { type: f.type });
    const meta = await uploadFile(file, {});
    fileIds.push(meta.id);
    item.payload = { ...item.payload, file_ids: fileIds };
    item.files = item.files.slice(1);
    await updateItem(item);
  }
  const body = { ...item.payload, file_ids: fileIds };
  if (item.kind === 'trouble') {
    await api.post('/api/troubles', body);
  } else if (item.kind === 'inspection') {
    await api.post('/api/inspections', body);
    // 保全計画から開始した点検なら、その計画を完了にする（失敗しても記録は保存済みなので続行）
    if (item.extra && item.extra.planId) {
      try { await completePlanAfterInspection(item.extra.planId, item.extra.planDay); } catch { /* ベストエフォート */ }
    }
  } else if (item.kind === 'repair') {
    await api.post('/api/repairs', item.payload); // 依頼はファイル添付なし（file_ids 不要）
  } else if (item.kind === 'report') {
    await api.post('/api/reports', item.payload);
  } else if (item.kind === 'parts_tx') {
    // 部品の入出庫（入庫・出庫のみ。棚卸調整は絶対値のため後から送ると間の出庫を消すので対象外）。
    // client_tx_id 付きなので、送信が途中で切れて再送してもサーバーは2回反映しない
    const { part_id: partId, ...tx } = item.payload;
    await api.post(`/api/parts/${Number(partId)}/transaction`, tx);
  } else {
    throw new Error(`不明な送信種別: ${item.kind}`);
  }
}

/** 送信待ちを順に送信する。オフライン起因の失敗は pending のまま残し、次の復帰時に再送する */
export async function flushOutbox() {
  if (flushing) return;
  if (navigator.onLine === false) { updateBar(); return; }
  flushing = true;
  try {
    // flushing はタブごとの変数のため、PWA の窓とブラウザのタブなど複数開いた状態で復帰すると
    // 両方が同じ項目を POST して二重登録になる。Web Locks で端末内の送信を1つに絞り、
    // 送信中の別タブは何もしない（その項目は送信側のタブが片付ける）。
    // Web Locks 非対応の古いブラウザは従来どおりタブ内の排他のみ。
    if (navigator.locks?.request) {
      let gotLock = false;
      await navigator.locks.request('mainte-outbox-flush', { ifAvailable: true }, async (lock) => {
        if (lock) { gotLock = true; await sendQueued(); }
      });
      // 送信は別のタブが担当中。終わる（ロックが空く）まで待ってからバーを更新する
      // （待たずに更新すると、送信済みの件数がこのタブのバーに残り続けていた）
      if (!gotLock) await navigator.locks.request('mainte-outbox-flush', async () => {});
    } else {
      await sendQueued();
    }
  } finally {
    flushing = false;
  }
  updateBar();
}

async function sendQueued() {
  const sent = [];
  let stillFailed = 0;
  const items = await getAll();
  for (const item of items) {
    // failed（検証エラー等）は自動再送しない。「今すぐ送信」ボタンが pending に
    // 戻したときだけ再試行する（毎回の復帰・起動で失敗し続けるのを防ぐ）
    if (item.status === 'failed') continue;
    try {
      await sendOne(item);
      await removeItem(item.id);
      sent.push(item);
    } catch (err) {
      if (err?.offline === true || navigator.onLine === false) {
        break; // まだオフライン。残りは次の復帰時に
      }
      // オフライン以外の失敗（検証エラー等）は failed として残す（自動では再送し続けない）
      item.status = 'failed';
      item.error = err?.message || String(err);
      await updateItem(item);
      stillFailed++;
    }
  }
  if (sent.length > 0) {
    const counts = {};
    for (const s of sent) counts[s.kind] = (counts[s.kind] || 0) + 1;
    const summary = Object.entries(counts).map(([k, n]) => `${KIND_LABELS[k] || k} ${n}件`).join('・');
    showToast(`📤 オフライン保存していた ${summary} を送信しました`, 6000);
  }
  if (stillFailed > 0) {
    showToast('⚠ 送信できなかった記録があります（バーの「失敗を確認」で理由を見て、再送か破棄を選べます）', 8000);
  }
}

// ---------------- 画面表示（送信待ちバー・トースト） ----------------

function showToast(text, ms = 5000) {
  const old = document.getElementById('offline-queue-toast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.id = 'offline-queue-toast';
  toast.className = 'sw-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), ms);
}

// 送信待ち1件の中身を、人が読める1行にする（失敗した記録を確認する画面用）
function describeItem(item) {
  const p = item.payload || {};
  const cut = (v, n = 30) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  switch (item.kind) {
    case 'parts_tx': {
      let name = `部品 #${p.part_id}`;
      try { const snap = JSON.parse(localStorage.getItem(`parts:snap:${p.part_id}`) || 'null'); if (snap?.name) name = snap.name; } catch { /* 名前が分からなくても番号で表示 */ }
      return `${name}：${p.type === 'in' ? '入庫 +' : p.type === 'out' ? '出庫 −' : '棚卸 '}${p.quantity}`;
    }
    case 'trouble': return cut(p.phenomenon);
    case 'inspection': return `設備 #${p.equipment_id ?? '?'} の点検`;
    case 'repair': return cut(p.title);
    case 'report': return cut(p.body);
    default: return '';
  }
}

// 送信できなかった（failed）記録の一覧。理由を見て、再送か破棄を選べる。
//   理由が見えず捨てることもできないと、在庫不足・部品の削除・権限なしで失敗した記録が、
//   全ページ下部のバーに出続けた
function openFailedDialog() {
  if (document.getElementById('offline-failed-dialog')) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'offline-failed-dialog';
  const modal = document.createElement('div');
  modal.className = 'modal';
  backdrop.appendChild(modal);
  const close = () => { backdrop.remove(); updateBar(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);

  const mk = (tag, text, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const draw = async () => {
    const failed = (await getAll()).filter((i) => i.status === 'failed');
    modal.textContent = '';
    modal.append(mk('h3', '送信できなかった記録', 'modal-title'));
    if (failed.length === 0) {
      modal.append(mk('p', '送信できなかった記録はありません。', 'hint'));
    } else {
      modal.append(mk('p', '電波が戻っても送れなかった記録です。理由を確認し、直せる場合は「再送」、不要なら「破棄」してください（破棄した記録は元に戻せません）。', 'hint'));
    }
    for (const item of failed) {
      const row = mk('div', null, 'queue-failed-row');
      row.style.cssText = 'border-top:1px solid #e5e7eb;padding:8px 0';
      row.append(mk('strong', `${KIND_LABELS[item.kind] || item.kind}　${describeItem(item)}`));
      const when = mk('div', `保存: ${new Date(item.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false })}`, 'hint');
      row.append(when);
      const reason = mk('div', `理由: ${item.error || '不明'}`);
      reason.style.cssText = 'color:#dc2626;margin:2px 0 6px';
      row.append(reason);
      const actions = mk('div', null, 'modal-actions');
      const retry = mk('button', '再送', 'btn btn-sm');
      retry.addEventListener('click', async () => {
        item.status = 'pending'; item.error = null;
        await updateItem(item);
        await flushOutbox();
        await draw();
      });
      const drop = mk('button', '破棄', 'btn btn-sm btn-danger');
      drop.addEventListener('click', async () => {
        if (!confirm(`この記録を破棄します。サーバーには送られず、元に戻せません。\n\n${KIND_LABELS[item.kind] || item.kind}　${describeItem(item)}\n理由: ${item.error || '不明'}`)) return;
        await removeItem(item.id);
        await draw();
        updateBar();
      });
      actions.append(retry, drop);
      row.append(actions);
      modal.append(row);
    }
    const actions = mk('div', null, 'modal-actions');
    const closeBtn = mk('button', '閉じる', 'btn');
    closeBtn.addEventListener('click', close);
    actions.append(closeBtn);
    modal.append(actions);
  };
  draw();
}

async function updateBar() {
  let items = [];
  try { items = await getAll(); } catch { return; }
  const bar = document.getElementById('offline-queue-bar');
  if (items.length === 0) {
    if (bar) bar.remove();
    return;
  }
  const failed = items.filter((i) => i.status === 'failed').length;
  const label = `📤 送信待ち ${items.length}件${failed ? `（うち失敗 ${failed}件）` : ''}` +
    (navigator.onLine === false ? ' — オンラインになると自動送信' : '');
  if (bar) {
    bar.querySelector('span').textContent = label;
    const detail = bar.querySelector('.queue-failed-btn');
    if (detail) detail.style.display = failed ? '' : 'none';
    return;
  }
  const wrap = document.createElement('div');
  wrap.id = 'offline-queue-bar';
  wrap.className = 'sw-toast';
  const msg = document.createElement('span');
  msg.textContent = label;
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-primary';
  btn.textContent = '今すぐ送信';
  btn.addEventListener('click', async () => {
    // failed も含めて再試行する（failed を pending に戻してから flush）
    const all = await getAll();
    for (const it of all) {
      if (it.status === 'failed') { it.status = 'pending'; it.error = null; await updateItem(it); }
    }
    flushOutbox();
  });
  // 失敗した記録の理由を見て、再送か破棄を選ぶ（失敗があるときだけ表示）
  const detailBtn = document.createElement('button');
  detailBtn.className = 'btn btn-sm queue-failed-btn';
  detailBtn.textContent = '失敗を確認';
  detailBtn.style.display = failed ? '' : 'none';
  detailBtn.addEventListener('click', openFailedDialog);
  wrap.append(msg, btn, detailBtn);
  document.body.appendChild(wrap);
}

/** 全ページ共通の自動同期セットアップ（nav.js から呼ぶ） */
export function setupAutoSync() {
  if (!('indexedDB' in window)) return;
  window.addEventListener('online', () => { flushOutbox(); });
  // 起動時: 送信待ちがあれば送信を試み、バーを表示する
  flushOutbox();
}
