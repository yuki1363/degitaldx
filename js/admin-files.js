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

// 使用量メーター（バイト単位）。pct に応じて色を変える。
function meterRow(label, usedBytes, limitBytes) {
  const pct = limitBytes > 0 ? Math.min(100, Math.round((usedBytes / limitBytes) * 1000) / 10) : 0;
  const barColor = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#16a34a';
  return el('div', { style: 'margin:10px 0' }, [
    el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
      el('strong', {}, label),
      el('span', { class: 'hint' }, `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}（${pct}%）`),
    ]),
    el('div', { style: 'height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin-top:4px' }, [
      el('div', { style: `height:100%;width:${pct}%;background:${barColor}` }),
    ]),
  ]);
}

export async function renderFileManager(container) {
  let filterMode = 'all';   // 'all' | 'deleted'（論理削除済みのみ）| 'orphan'（未添付のみ）
  let files = [];
  let usage = null;         // R2 のみ（/api/files の usage・後方互換）
  let freeTier = null;      // 無料枠の全体像（/api/admin/usage：R2＋D1＋Access）

  const usageBox = el('div', {});
  const listBox = el('div', {});

  const fetchData = async () => {
    const [filesRes, usageRes] = await Promise.all([
      api.get('/api/files'),
      api.get('/api/admin/usage').catch(() => null),
    ]);
    files = filesRes.files || [];
    usage = filesRes.usage || null;
    freeTier = usageRes || null;
  };

  const renderUsage = () => {
    // R2 は freeTier 優先・無ければ /api/files の usage にフォールバック
    const r2 = (freeTier && freeTier.r2) || usage;
    if (!r2) { render(usageBox, []); return; }

    const freeBytes = r2.free_tier_bytes || 10_000_000_000;
    const pctFree = freeBytes > 0 ? Math.min(100, Math.round((r2.used_bytes / freeBytes) * 1000) / 10) : 0;
    const overWarn = r2.used_bytes >= r2.warn_bytes;
    const barColor = overWarn ? '#dc2626' : (pctFree >= 50 ? '#d97706' : '#16a34a');
    const remainFree = Math.max(0, freeBytes - r2.used_bytes);
    const warnLeft = (r2.warn_bytes / freeBytes) * 100;
    const hardLeft = (r2.hard_limit_bytes / freeBytes) * 100;

    const rows = [];

    // R2（写真・動画・PDF）— 無料枠10GBに対するバー＋警告/上限マーカー＋内訳
    rows.push(el('div', { style: 'margin:6px 0 14px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
        el('strong', {}, '📦 R2 ファイルストレージ（写真・動画・PDF）'),
        el('span', { class: 'hint' }, `${formatBytes(r2.used_bytes)} / ${formatBytes(freeBytes)} 無料枠（${pctFree}%）`),
      ]),
      el('div', { style: 'height:12px;background:#e5e7eb;border-radius:6px;overflow:hidden;margin-top:5px;position:relative' }, [
        el('div', { style: `height:100%;width:${pctFree}%;background:${barColor}` }),
        el('div', { title: '警告ライン', style: `position:absolute;top:0;bottom:0;left:${warnLeft}%;width:2px;background:#b45309` }),
        el('div', { title: 'アップロード上限', style: `position:absolute;top:0;bottom:0;left:${hardLeft}%;width:2px;background:#dc2626` }),
      ]),
      el('div', { class: 'hint', style: 'margin-top:4px' },
        [`使用中 ${formatBytes(r2.active_bytes ?? r2.used_bytes)}`,
         r2.deleted_bytes ? `削除済み(R2に残存) ${formatBytes(r2.deleted_bytes)} ← 完全削除で解放` : null,
         r2.file_count != null ? `ファイル数 ${r2.file_count}` : null,
        ].filter(Boolean).join('　／　')),
      el('div', { class: 'hint' },
        `警告ライン ${formatBytes(r2.warn_bytes)}（黄線）　アップロード上限 ${formatBytes(r2.hard_limit_bytes)}（赤線・超過は停止し課金を防止）　無料枠まで残り ${formatBytes(remainFree)}`),
    ]));

    // D1 データベース（推定値・取れなければダッシュボード誘導）
    if (freeTier && freeTier.d1) {
      if (freeTier.d1.size_bytes != null) {
        rows.push(meterRow('🗄 D1 データベース（全業務データ）', freeTier.d1.size_bytes, freeTier.d1.free_tier_bytes));
      } else {
        rows.push(el('div', { style: 'margin:10px 0' }, [
          el('strong', {}, '🗄 D1 データベース（全業務データ）'),
          el('div', { class: 'hint' }, `無料枠 ${formatBytes(freeTier.d1.free_tier_bytes)}。正確な使用量は Cloudflare ダッシュボードの D1 で確認してください。`),
        ]));
      }
    }

    // Access ユーザー数（= ログイン許可ユーザー・50名無料）
    if (freeTier && freeTier.access && freeTier.access.user_count != null) {
      const ac = freeTier.access;
      const pct = Math.min(100, Math.round((ac.user_count / ac.free_limit) * 1000) / 10);
      rows.push(el('div', { style: 'margin:10px 0' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
          el('strong', {}, '👤 Cloudflare Access（ログインユーザー）'),
          el('span', { class: 'hint' }, `${ac.user_count} / ${ac.free_limit} 名 無料枠（${pct}%）`),
        ]),
        el('div', { style: 'height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin-top:4px' }, [
          el('div', { style: `height:100%;width:${pct}%;background:${pct >= 90 ? '#dc2626' : '#16a34a'}` }),
        ]),
      ]));
    }

    // アプリから取得できない無料枠 → Cloudflare ダッシュボードへ誘導
    rows.push(el('div', { style: 'margin-top:12px;padding-top:8px;border-top:1px solid #e5e7eb' }, [
      el('div', { class: 'hint' }, 'アプリから取得できない無料枠（Cloudflare ダッシュボードで確認）:'),
      el('ul', { class: 'hint', style: 'margin:4px 0 6px;padding-left:18px' }, [
        el('li', {}, 'Workers リクエスト 10万/日（Pages Functions）'),
        el('li', {}, 'D1 読取 500万行/日・書込 10万行/日'),
        el('li', {}, 'Pages ビルド 500回/月'),
      ]),
      el('a', { class: 'btn btn-sm', href: 'https://dash.cloudflare.com/', target: '_blank', rel: 'noopener' }, 'Cloudflare ダッシュボードを開く'),
    ]));

    if (overWarn) {
      rows.push(el('p', { class: 'notice is-warning', style: 'margin:10px 0 0' },
        '⚠ R2 が警告ラインを超えています。不要なファイルを完全削除して容量を空けてください。'));
    }

    render(usageBox, el('div', { class: 'card' }, [
      el('h3', { class: 'card-title', style: 'margin-top:0' }, '無料枠の使用状況'),
      ...rows,
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
