// アプリ内QRスキャナ（共通モジュール）
//   設備台帳のQR（/pages/ledger?id=N）をカメラで読み取る。
//   openQrScanner(onEquipment):
//     onEquipment(equipmentId) を渡すと、読み取った設備IDをコールバックで返す
//     （点検・トラブル・業務依頼の入力フォームで設備を選ぶ用途）。
//     省略時は従来どおりその設備の詳細ページへ遷移する。
//   ※ jsQR（window.jsQR）を読み込んだページでのみ動作する。

import { el } from '/js/util.js';

export function openQrScanner(onEquipment) {
  let stream = null;
  let running = false;

  const video = el('video', { autoplay: true, playsinline: true, muted: true });
  const canvas = el('canvas', { style: 'display:none' });
  const resultEl = el('p', { class: 'qr-scan-result' }, '');
  const hintEl = el('p', { class: 'qr-scan-hint' }, 'QRコードをカメラに向けてください');
  const closeBtn = el('button', { class: 'btn', style: 'background:#fff;color:#1e293b', onclick: stop }, '✕ 閉じる');

  const overlay = el('div', { class: 'qr-scan-overlay' }, [
    video,
    canvas,
    el('div', { class: 'qr-scan-frame' }),
    el('div', { class: 'qr-scan-controls' }, [hintEl, resultEl, closeBtn]),
  ]);
  document.body.appendChild(overlay);

  function stop() {
    running = false;
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  }

  // 読み取った文字列が設備台帳QRなら設備IDを取り出して処理する。処理できたら true。
  function handleDecoded(text) {
    try {
      const url = new URL(text);
      if (url.origin === window.location.origin && url.pathname === '/pages/ledger') {
        const eqId = Number(url.searchParams.get('id'));
        if (eqId) {
          stop();
          if (onEquipment) onEquipment(eqId);
          else window.location.href = text;
          return true;
        }
      }
    } catch { /* URL以外は無視 */ }
    return false;
  }

  function scan() {
    if (!running) return;
    if (video.readyState < 2) { requestAnimationFrame(scan); return; }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const decoded = window.jsQR?.(imgData.data, imgData.width, imgData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (decoded) {
      if (handleDecoded(decoded.data)) return;
      resultEl.textContent = `検出: ${decoded.data}（設備QRではありません）`;
    }
    setTimeout(() => requestAnimationFrame(scan), 150);
  }

  async function start() {
    if (!window.jsQR) {
      resultEl.textContent = 'QRライブラリを読み込めません（オンライン環境でお試しください）';
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      resultEl.textContent = 'このブラウザはカメラAPIに対応していません';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      running = true;
      requestAnimationFrame(scan);
    } catch (err) {
      resultEl.textContent = `カメラを起動できませんでした: ${err.message}`;
    }
  }

  start();
}
