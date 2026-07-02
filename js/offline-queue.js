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

const DB_NAME = 'mainte-offline';
const STORE = 'outbox';

const KIND_LABELS = { trouble: 'トラブル記録', inspection: '点検記録' };

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
 * @param {'trouble'|'inspection'} kind
 * @param {object} payload 本体POSTのボディ（file_ids は含めない）
 * @param {File[]} files リサイズ済みの添付（Canvasリサイズはオフラインでも動く）
 * @param {object} [extra] 例: { planId } 点検保存後に完了化する計画ID
 */
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
  const fileIds = [...(item.payload?.file_ids || [])];
  for (const f of item.files || []) {
    const file = new File([f.blob], f.name, { type: f.type });
    const meta = await uploadFile(file, {});
    fileIds.push(meta.id);
  }
  const body = { ...item.payload, file_ids: fileIds };
  if (item.kind === 'trouble') {
    await api.post('/api/troubles', body);
  } else if (item.kind === 'inspection') {
    await api.post('/api/inspections', body);
    // 保全計画から開始した点検なら、その計画を完了にする（失敗しても記録は保存済みなので続行）
    if (item.extra && item.extra.planId) {
      try { await api.put(`/api/plans/${item.extra.planId}`, { status: 'done' }); } catch { /* ベストエフォート */ }
    }
  } else {
    throw new Error(`不明な送信種別: ${item.kind}`);
  }
}

/** 送信待ちを順に送信する。オフライン起因の失敗は pending のまま残し、次の復帰時に再送する */
export async function flushOutbox() {
  if (flushing) return;
  if (navigator.onLine === false) { updateBar(); return; }
  flushing = true;
  const sent = [];
  let stillFailed = 0;
  try {
    const items = await getAll();
    for (const item of items) {
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
  } finally {
    flushing = false;
  }
  if (sent.length > 0) {
    const counts = {};
    for (const s of sent) counts[s.kind] = (counts[s.kind] || 0) + 1;
    const summary = Object.entries(counts).map(([k, n]) => `${KIND_LABELS[k] || k} ${n}件`).join('・');
    showToast(`📤 オフライン保存していた ${summary} を送信しました`, 6000);
  }
  if (stillFailed > 0) {
    showToast('⚠ 送信できなかった記録があります（送信待ちバーから再試行できます）', 8000);
  }
  updateBar();
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
  wrap.append(msg, btn);
  document.body.appendChild(wrap);
}

/** 全ページ共通の自動同期セットアップ（nav.js から呼ぶ） */
export function setupAutoSync() {
  if (!('indexedDB' in window)) return;
  window.addEventListener('online', () => { flushOutbox(); });
  // 起動時: 送信待ちがあれば送信を試み、バーを表示する
  flushOutbox();
}
