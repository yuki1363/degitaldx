// ファイルアップロード共通モジュール（容量上限ガード・管理者への報告画面つき）
//
// 各機能（点検・トラブル記録・設備台帳など）の写真・動画・PDF添付は
// 必ずこの uploadFile() を使うこと。サーバー側の容量上限ガードと連動して:
//   - 上限到達でアップロードが拒否された場合（HTTP 507）
//     → 管理者への報告画面（ダイアログ）を自動表示してから ApiError を投げる
//   - 警告ライン（残りわずか）を超えた場合
//     → アップロード自体は成功し、報告画面を任意表示する
//
// 使い方:
//   import { uploadFile } from '/js/files.js';
//   const meta = await uploadFile(file, { relatedTable: 'trouble_record', relatedId: 1 });
//   // meta = { id, file_name, content_type, size_bytes, url }

import { ApiError, api } from '/js/api.js';

const GB = 1_000_000_000;

function formatGb(bytes) {
  return `${(bytes / GB).toFixed(2)} GB`;
}

/** 現在のストレージ使用量を取得する */
export async function getStorageUsage() {
  const data = await api.get('/api/files/usage');
  return data.usage;
}

/** ファイルを R2 へアップロードし、メタデータ（id・URL等）を返す */
export async function uploadFile(file, { fileName, relatedTable, relatedId } = {}) {
  const params = new URLSearchParams({ filename: fileName || file.name || 'file' });
  if (relatedTable) params.set('related_table', relatedTable);
  if (relatedId !== undefined && relatedId !== null) params.set('related_id', String(relatedId));

  let response;
  try {
    response = await fetch(`/api/files?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'ネットワークに接続できません。通信環境を確認してください。', undefined, true);
  }

  const contentType = response.headers.get('Content-Type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  // 容量上限で拒否された → 管理者への報告画面を表示してからエラーにする
  if (response.status === 507) {
    const usage = data && data.error && data.error.detail ? data.error.detail.usage : null;
    await showStorageReportDialog({ context: 'blocked', usage });
    throw new ApiError(507, (data && data.error && data.error.message) || '保存容量の上限に達しています。');
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (data && data.error && data.error.message) || `アップロードに失敗しました（HTTP ${response.status}）`
    );
  }

  // 警告ライン超え（まもなく上限）→ 報告画面を任意表示（アップロードは成功している）
  if (data.warning) {
    showStorageReportDialog({ context: 'warning', usage: data.usage });
  }

  return data.file;
}

/**
 * 管理者への報告画面（モーダルダイアログ）。
 * 送信すると POST /api/files/report に記録され、管理者がホーム画面で確認できる。
 * ダイアログが閉じられたら resolve する。
 */
export function showStorageReportDialog({ context, usage }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent =
      context === 'blocked' ? '保存容量の上限に達しました' : '保存容量がまもなく上限に達します';

    const body = document.createElement('p');
    body.className = 'modal-body';
    const usageText = usage
      ? `現在 ${formatGb(usage.used_bytes)} / 上限 ${formatGb(usage.hard_limit_bytes)}（${usage.used_percent}%）。`
      : '';
    body.textContent =
      (context === 'blocked'
        ? `アップロードできませんでした。${usageText}`
        : `アップロードは完了しましたが、容量が残りわずかです。${usageText}`) +
      '不要な動画・ファイルの整理が必要です。管理者に報告できます。';

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'コメント（任意）例: 点検写真が登録できませんでした';
    textarea.maxLength = 500;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn-primary';
    sendBtn.textContent = '管理者に報告する';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn';
    closeBtn.textContent = '閉じる';

    const close = () => {
      backdrop.remove();
      resolve();
    };

    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      sendBtn.textContent = '送信中…';
      try {
        await api.post('/api/files/report', { context, message: textarea.value.trim() || null });
        body.textContent = '管理者に報告しました。';
        textarea.remove();
        sendBtn.remove();
        closeBtn.textContent = '閉じる';
      } catch (err) {
        body.textContent = `報告の送信に失敗しました: ${err.message}`;
        sendBtn.disabled = false;
        sendBtn.textContent = '管理者に報告する';
      }
    });
    closeBtn.addEventListener('click', close);

    actions.append(sendBtn, closeBtn);
    modal.append(title, body, textarea, actions);
    backdrop.append(modal);
    document.body.append(backdrop);
  });
}
