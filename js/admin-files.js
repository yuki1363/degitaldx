// 管理機能（09）— ファイル容量・物理削除（R2の実体を削除して容量を空ける）
//   admin のみ。論理削除（一覧から隠すだけ）とは別に、R2 オブジェクトを実際に削除して
//   無料枠の使用量を解放する。物理削除は復元できないため、確認ダイアログ必須。

import { api } from '/js/api.js';
import { el, render, formatBytes, formatDateTime, maskEmail } from '/js/util.js';

const RELATED_LABELS = {
  equipment_ledger: '設備台帳', inspection_result: '点検結果', repair_request: '業務依頼',
  trouble_record: 'トラブル記録', maintenance_plan: '保全計画', daily_report: '日報',
  comments: 'コメント', chat_messages: 'チャット', print_templates: '帳票テンプレート用紙',
};

const TYPE_LABELS = {
  'image/jpeg': '画像', 'image/png': '画像', 'image/webp': '画像',
  'video/mp4': '動画', 'video/quicktime': '動画', 'application/pdf': 'PDF',
};

function relatedLabel(f) {
  if (!f.related_table) return '（未添付）';
  const base = RELATED_LABELS[f.related_table] || f.related_table;
  return f.related_id ? `${base} #${f.related_id}` : base;
}

export async function renderFileManager(container) {
  let filterMode = 'all';   // 'all' | 'deleted'（論理削除済みのみ）| 'orphan'（未添付のみ）
  let files = [];
  let usage = null;

  const usageBox = el('div', {});
  const listBox = el('div', {});

  const fetchData = async () => {
    const res = await api.get('/api/files');
    files = res.files || [];
    usage = res.usage || null;
  };

  const renderUsage = () => {
    if (!usage) { render(usageBox, []); return; }
    const pct = usage.used_percent;
    const barColor = usage.used_bytes >= usage.warn_bytes ? '#dc2626' : (pct >= 50 ? '#d97706' : '#16a34a');
    render(usageBox, el('div', { class: 'card' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
        el('strong', {}, `使用量 ${formatBytes(usage.used_bytes)} / ${formatBytes(usage.hard_limit_bytes)}`),
        el('span', { class: 'hint' }, `${pct}%（警告ライン ${formatBytes(usage.warn_bytes)}）`),
      ]),
      el('div', { style: 'height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin-top:6px' }, [
        el('div', { style: `height:100%;width:${Math.min(100, pct)}%;background:${barColor}` }),
      ]),
      usage.used_bytes >= usage.warn_bytes
        ? el('p', { class: 'notice is-warning', style: 'margin:8px 0 0' }, '⚠ 警告ラインを超えています。不要なファイルを完全削除して容量を空けてください。')
        : null,
    ]));
  };

  const purge = async (f) => {
    const msg = `「${f.file_name}」（${formatBytes(f.size_bytes)}）をR2から完全に削除します。\n`
      + 'この操作は取り消せません（復元できません）。\n続けますか？';
    if (!confirm(msg)) return;
    try {
      await api.del(`/api/files/${f.id}?physical=1`);
      await fetchData();
      renderUsage();
      renderList();
    } catch (err) {
      alert(`削除に失敗しました: ${err.message}`);
    }
  };

  const renderList = () => {
    let list = files;
    if (filterMode === 'deleted') list = files.filter((f) => f.deleted_at);
    else if (filterMode === 'orphan') list = files.filter((f) => !f.related_table);

    if (list.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '該当するファイルはありません。'));
      return;
    }

    render(listBox, [
      el('p', { class: 'hint', style: 'margin:8px 0' }, `${list.length}件（サイズの大きい順）`),
      el('div', { style: 'overflow-x:auto' }, [
        el('table', { class: 'extract-table' }, [
          el('thead', {}, [el('tr', {}, ['ファイル名', '種別', 'サイズ', '紐づけ', '登録者', '状態', '操作'].map((h) => el('th', {}, h)))]),
          el('tbody', {}, list.map((f) => el('tr', { style: f.deleted_at ? 'opacity:0.65' : '' }, [
            el('td', {}, f.file_name || `file-${f.id}`),
            el('td', {}, TYPE_LABELS[f.content_type] || f.content_type || '—'),
            el('td', { style: 'white-space:nowrap;font-variant-numeric:tabular-nums' }, formatBytes(f.size_bytes)),
            el('td', {}, relatedLabel(f)),
            el('td', { style: 'white-space:nowrap' }, maskEmail(f.created_by) || '—'),
            el('td', {}, f.deleted_at
              ? el('span', { class: 'cat-badge', title: `${maskEmail(f.deleted_by) || ''} ${formatDateTime(f.deleted_at)}` }, '削除済み')
              : '使用中'),
            el('td', {}, el('button', { class: 'btn btn-sm btn-danger', onclick: () => purge(f) }, '完全削除')),
          ]))),
        ]),
      ]),
    ]);
  };

  const filterSel = el('select', {
    onchange: (e) => { filterMode = e.target.value; renderList(); },
  }, [
    el('option', { value: 'all' }, 'すべて'),
    el('option', { value: 'deleted' }, '論理削除済みのみ'),
    el('option', { value: 'orphan' }, '未添付のみ'),
  ]);

  render(container, [
    el('p', { class: 'hint' },
      'R2に保存されたファイルの一覧です。「完全削除」するとR2の実体を削除して容量を空けます（復元不可）。'
      + '「削除済み」は一覧から隠れているだけでR2には残り容量を消費しているため、ここで完全削除できます。'),
    usageBox,
    el('div', { class: 'filter-bar' }, [el('label', { class: 'filter-label' }, ['表示 ', filterSel])]),
    listBox,
  ]);

  render(usageBox, el('p', { class: 'loading' }, '読み込み中…'));
  await fetchData();
  renderUsage();
  renderList();
}
