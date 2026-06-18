// 06 設備台帳 — 一覧・詳細・登録・編集・QRコード生成/ラベル印刷・関連資料
//   URL: /pages/ledger            … 一覧
//        /pages/ledger?id=N       … 詳細（QRコードの遷移先）
//        /pages/ledger?new=1      … 新規登録
//        /pages/ledger?edit=N     … 編集

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { uploadFile, resizeImageFile } from '/js/files.js';
import { fetchEquipNames, buildEquipCascade } from '/js/equip-names.js';
import {
  el, render, formatDate, formatDateTime, formatBytes, maskEmail, ACTION_LABELS,
} from '/js/util.js';
import { buildCommentsCard } from '/js/comments.js';
import { openQrScanner } from '/js/qr-scan.js';
import qrcode from '/js/vendor/qrcode.mjs';

const STATUS_LABELS = { active: '稼働中', stopped: '停止中', retired: '廃棄' };

// 関連レコード表示用ラベル（各機能の表記に合わせる）
const REPAIR_STATUS_LABELS = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };
const PLAN_TYPE_LABELS = { inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他' };
const PLAN_STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };

// 一覧の設備名→機器名フィルタの内部値
const ALL_LINES = '__ALL__';
const ALL_EQUIPS = '__ALL__';
const NO_EQUIP = '__NONE__';

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/ledger${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// QRスキャナは共通モジュール（/js/qr-scan.js）に集約。
// 一覧では引数なしで呼び、読み取った設備ページへ直接遷移する。

// ---------------- 一覧 ----------------

async function renderList() {
  let searchQuery = '';
  let selectedLine = '';  // 設備名フィルタ（空 = 未選択／プロンプト）
  let selectedEquip = ''; // 機器名フィルタ（設備選択後に有効）
  let allEquipment = [];
  let timer = null;

  const listBox = el('div', { class: 'row-list' }, []);

  // 設備名 → 機器名の2段階セレクタ（選ぶまで一覧は出さない）
  const lineSelect = el('select', {
    class: 'parts-line-select',
    onchange: (e) => { selectedLine = e.target.value; selectedEquip = ''; refreshEquipOptions(); renderFiltered(); },
  }, [el('option', { value: '' }, '設備を選択してください')]);

  const equipSelect = el('select', {
    class: 'parts-line-select',
    onchange: (e) => { selectedEquip = e.target.value; renderFiltered(); },
  }, [el('option', { value: '' }, '（設備を選択）')]);

  const makeRow = (eq) => {
    const sub = [eq.line_name, eq.equipment_name].filter(Boolean).join(' / ') || eq.location || '';
    const noImage = eq.image_count === 0 || eq.image_count === null;
    return el('a', { class: 'list-item', href: `/pages/ledger?id=${eq.id}` }, [
      el('div', { class: 'list-item-main' }, [
        el('div', { class: 'list-item-sub' }, [
          eq.code,
          el('span', { class: `status-badge is-${eq.status}` }, STATUS_LABELS[eq.status] || eq.status),
          noImage ? el('span', { class: 'no-image-badge' }, '画像なし') : null,
        ]),
        el('div', { class: 'list-item-title' }, eq.name),
        sub ? el('div', { class: 'list-item-sub' }, sub) : null,
      ]),
      el('span', { class: 'chevron' }, '›'),
    ]);
  };

  // 設備名→機器名でグループ化して描画
  const renderGroups = (list) => {
    if (list.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '該当する設備がありません。'));
      return;
    }
    const lineMap = new Map();
    for (const eq of list) {
      const line = eq.line_name || '';
      const equip = eq.equipment_name || '';
      if (!lineMap.has(line)) lineMap.set(line, new Map());
      const em = lineMap.get(line);
      if (!em.has(equip)) em.set(equip, []);
      em.get(equip).push(eq);
    }
    const nodes = [];
    for (const [line, em] of lineMap) {
      nodes.push(el('div', { class: 'group-header-line' }, line || '（設備名なし）'));
      for (const [equip, items] of em) {
        nodes.push(el('div', { class: 'group-header-equip' }, equip || '（機器名なし）'));
        nodes.push(el('div', { class: 'row-list' }, items.map(makeRow)));
      }
    }
    render(listBox, nodes);
  };

  // 設備名→機器名を選ぶまで一覧は出さない（検索中は選択に関係なく該当を表示）
  const renderFiltered = () => {
    if (searchQuery) { renderGroups(allEquipment); return; }
    if (!selectedLine) {
      render(listBox, el('p', { class: 'empty' }, '「設備名で絞り込み」から設備を選んでください（「すべての設備を表示」で全件表示）。'));
      return;
    }
    if (selectedLine === ALL_LINES) { renderGroups(allEquipment); return; }
    if (!selectedEquip) {
      render(listBox, el('p', { class: 'empty' }, '「機器名で絞り込み」から機器を選んでください（「すべての機器」でこの設備の全件表示）。'));
      return;
    }
    let list = allEquipment.filter((eq) => (eq.line_name || '') === selectedLine);
    if (selectedEquip === NO_EQUIP) list = list.filter((eq) => (eq.equipment_name || '') === '');
    else if (selectedEquip !== ALL_EQUIPS) list = list.filter((eq) => (eq.equipment_name || '') === selectedEquip);
    renderGroups(list);
  };

  const refreshLineOptions = () => {
    const lines = [...new Set(allEquipment.map((eq) => eq.line_name || '').filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ja'));
    render(lineSelect, [
      el('option', { value: '' }, '設備を選択してください'),
      el('option', { value: ALL_LINES }, `すべての設備を表示（${allEquipment.length}件）`),
      ...lines.map((l) => el('option', { value: l }, l)),
    ]);
    const valid = ['', ALL_LINES, ...lines];
    if (valid.includes(selectedLine)) lineSelect.value = selectedLine;
    else { selectedLine = ''; lineSelect.value = ''; }
  };

  const refreshEquipOptions = () => {
    if (!selectedLine || selectedLine === ALL_LINES) {
      render(equipSelect, [el('option', { value: '' }, '（設備を選択）')]);
      equipSelect.value = '';
      equipSelect.disabled = true;
      return;
    }
    equipSelect.disabled = false;
    const equips = [...new Set(
      allEquipment.filter((eq) => (eq.line_name || '') === selectedLine).map((eq) => eq.equipment_name || '')
    )].sort((a, b) => a.localeCompare(b, 'ja'));
    const optValue = (e) => (e === '' ? NO_EQUIP : e);
    render(equipSelect, [
      el('option', { value: '' }, '機器を選択してください'),
      el('option', { value: ALL_EQUIPS }, 'すべての機器'),
      ...equips.map((e) => el('option', { value: optValue(e) }, e || '（機器名なし）')),
    ]);
    const valid = ['', ALL_EQUIPS, ...equips.map(optValue)];
    if (!valid.includes(selectedEquip)) selectedEquip = '';
    equipSelect.value = selectedEquip;
  };

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const { equipment } = await api.get(`/api/equipment${searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : ''}`);
    allEquipment = equipment || [];
    refreshLineOptions();
    refreshEquipOptions();
    renderFiltered();
  };

  const searchInput = el('input', {
    type: 'search',
    placeholder: '設備番号・名称・場所で検索',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { searchQuery = e.target.value.trim(); load().catch(showError); }, 300);
    },
  });

  // 在庫の設備名・機器名から、未登録の設備を台帳に一括登録する
  const importFromParts = async (btn) => {
    if (!confirm('在庫の設備名・機器名から、まだ台帳に無い設備をまとめて登録します。よろしいですか？')) return;
    btn.disabled = true;
    btn.textContent = '登録中…';
    try {
      const res = await api.post('/api/equipment/import-from-parts', {});
      alert(res.created > 0
        ? `${res.created}件の設備を台帳に登録しました。`
        : (res.message || '新規に追加する設備はありませんでした。'));
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📥 在庫から一括登録';
    }
  };

  // INV以外の設備番号を INV-xxx に一括振り直し（管理者のみ）
  const renumberEquipment = async (btn) => {
    if (!confirm('INV以外の設備番号をすべて INV-xxx 形式に振り直します。\n既存のINV番号はそのまま維持され、続きの番号が付与されます。\nよろしいですか？')) return;
    btn.disabled = true;
    btn.textContent = '処理中…';
    try {
      const res = await api.post('/api/equipment/renumber', {});
      alert(res.updated > 0
        ? `${res.updated}件の設備番号を INV-xxx 形式に更新しました。`
        : (res.message || 'INV以外の設備番号は見つかりませんでした。'));
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔢 設備番号を一括付与';
    }
  };

  render(app, [
    el('div', { class: 'field-pair', style: 'margin-bottom:10px' }, [
      el('div', { class: 'field' }, [el('label', {}, '設備名で絞り込み'), lineSelect]),
      el('div', { class: 'field' }, [el('label', {}, '機器名で絞り込み'), equipSelect]),
    ]),
    el('div', { class: 'toolbar' }, [searchInput]),
    el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 設備を追加')
        : null,
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn', onclick: (e) => importFromParts(e.currentTarget) }, '📥 在庫から一括登録')
        : null,
      hasRole(currentUser, 'admin')
        ? el('button', { class: 'btn', onclick: (e) => renumberEquipment(e.currentTarget) }, '🔢 設備番号を一括付与')
        : null,
      el('button', { class: 'btn', onclick: openQrScanner }, '📷 QRスキャン'),
      el('a', { class: 'btn', href: '/pages/labels' }, '🖨 ラベル一括印刷'),
    ]),
    listBox,
  ]);
  await load();
}

// ---------------- 詳細 ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

async function renderDetail(id) {
  const { equipment: eq, files, inspections, troubles = [], repairs = [], plans = [], history, parts = [] } =
    await api.get(`/api/equipment/${id}`);
  const canEdit = hasRole(currentUser, 'editor');
  const isAdmin = hasRole(currentUser, 'admin');

  // QRコード（この詳細ページのURLを埋め込む → カメラで読むと直接開く）
  const detailUrl = `${window.location.origin}/pages/ledger?id=${eq.id}`;
  const qr = qrcode(0, 'M');
  qr.addData(detailUrl);
  qr.make();
  const qrImg = el('img', { class: 'qr-img', alt: `QRコード: ${eq.code}`, src: qr.createDataURL(6, 4) });

  const printLabel = () => {
    const label = el('div', { class: 'print-label' }, [
      el('img', { src: qr.createDataURL(8, 4), alt: '' }),
      el('div', { class: 'print-label-code' }, eq.code),
      el('div', { class: 'print-label-name' }, eq.name),
    ]);
    document.body.appendChild(label);
    document.body.classList.add('printing-label');
    const cleanup = () => {
      document.body.classList.remove('printing-label');
      label.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  };

  // 写真・関連資料（画像はサムネイル表示、PDF等はファイル名で表示）
  const filesBox = el('div', { class: 'row-list' }, []);

  const deleteFile = async (f) => {
    if (!confirm(`「${f.file_name}」を削除しますか？`)) return;
    await api.del(`/api/files/${f.id}`);
    const fresh = await api.get(`/api/equipment/${id}`);
    renderFiles(fresh.files);
  };

  const renderFiles = (list) => {
    if (list.length === 0) {
      render(filesBox, el('p', { class: 'empty' }, '写真・資料はまだありません。'));
      return;
    }
    const imgs = list.filter((f) => (f.content_type || '').startsWith('image/'));
    const others = list.filter((f) => !(f.content_type || '').startsWith('image/'));
    render(filesBox, [
      imgs.length > 0
        ? el('div', { class: 'thumb-grid' },
            imgs.map((f) =>
              el('div', { class: 'thumb-cell' }, [
                el('a', { href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' },
                  el('img', { class: 'thumb', src: `/api/files/${f.id}`, alt: f.file_name, loading: 'lazy' })),
                canEdit ? el('button', { class: 'thumb-del', title: '削除', onclick: () => deleteFile(f) }, '×') : null,
              ])
            )
          )
        : null,
      ...others.map((f) =>
        el('div', { class: 'file-row' }, [
          el('a', { class: 'file-name', href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, f.file_name),
          el('span', { class: 'file-meta' }, formatBytes(f.size_bytes)),
          canEdit ? el('button', { class: 'btn btn-sm', onclick: () => deleteFile(f) }, '削除') : null,
        ])
      ),
    ]);
  };
  renderFiles(files);

  // 画像・PDFのアップロード共通処理（画像はリサイズで EXIF=位置情報 を自動除去）
  const uploadAndRefresh = async (file) => {
    if (!file) return;
    try {
      const prepared = await resizeImageFile(file);
      await uploadFile(prepared, { relatedTable: 'equipment_ledger', relatedId: eq.id });
      const fresh = await api.get(`/api/equipment/${id}`);
      renderFiles(fresh.files);
    } catch (err) {
      alert(err.message);
    }
  };

  // 📷 撮影: モバイルでは端末のカメラを直接起動して撮影 → そのまま添付
  const cameraInput = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment', hidden: true,
    onchange: async (e) => { await uploadAndRefresh(e.target.files[0]); e.target.value = ''; },
  });
  // ＋ ファイル: 写真ライブラリ / PDF（マニュアル・図面）から選んで添付
  const fileInput = el('input', {
    type: 'file', accept: 'application/pdf,image/*', hidden: true,
    onchange: async (e) => { await uploadAndRefresh(e.target.files[0]); e.target.value = ''; },
  });

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, eq.name),
        el('span', { class: `status-badge is-${eq.status}` }, STATUS_LABELS[eq.status] || eq.status),
      ]),
      infoRow('設備番号', eq.code),
      infoRow('設備名', eq.line_name),
      infoRow('機器名', eq.equipment_name),
      infoRow('設置場所', eq.location),
      infoRow('メーカー', eq.manufacturer),
      infoRow('型式', eq.model),
      infoRow('製造番号', eq.serial_no),
      infoRow('製造年月', eq.manufactured_on ? eq.manufactured_on.replace('-', '/') : null),
      infoRow('設置日', formatDate(eq.installed_on)),
      infoRow('備考', eq.note),
    ]),
    el('div', { class: 'action-row' }, [
      canEdit
        ? el('a', { class: 'btn btn-primary', href: `/pages/inspection?new=1&equipment_id=${eq.id}` }, '✅ 点検開始')
        : el('a', { class: 'btn', href: `/pages/inspection?equipment_id=${eq.id}` }, '点検履歴'),
      isAdmin
        ? el('a', { class: 'btn', href: `/pages/inspection?masters=${eq.id}` }, '点検項目の管理')
        : null,
      canEdit ? el('button', { class: 'btn', onclick: () => go(`?edit=${eq.id}`) }, '編集') : null,
      canEdit
        ? el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm(`設備「${eq.name}」を削除しますか？\n（削除済みデータは管理画面から復元できます）`)) return;
              await api.del(`/api/equipment/${eq.id}`);
              go('');
            },
          }, '削除')
        : null,
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, 'QRコード'),
      el('div', { class: 'qr-box' }, [
        qrImg,
        el('div', {}, [
          el('div', { class: 'list-item-title' }, eq.code),
          el('p', { class: 'hint' }, 'スマホのカメラで読み取ると、この設備のページが直接開きます。'),
          el('button', { class: 'btn', onclick: printLabel }, '🖨 ラベル印刷'),
        ]),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '写真・関連資料'),
        canEdit
          ? el('div', { class: 'btn-group' }, [
              el('button', { class: 'btn btn-sm btn-primary', onclick: () => cameraInput.click() }, '📷 撮影'),
              el('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, '＋ ファイル'),
            ])
          : null,
      ]),
      cameraInput,
      fileInput,
      filesBox,
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '点検履歴（直近10件）'),
        el('a', { class: 'btn btn-sm', href: `/pages/inspection?equipment_id=${eq.id}` }, 'すべて見る'),
      ]),
      inspections.length === 0
        ? el('p', { class: 'empty' }, '点検記録はまだありません。')
        : el('div', { class: 'row-list' },
            inspections.map((r) =>
              el('a', { class: 'list-item', href: `/pages/inspection?id=${r.id}` }, [
                el('div', { class: 'list-item-main' }, [
                  el('div', { class: 'list-item-title' }, formatDateTime(r.inspected_at)),
                  el('div', { class: 'list-item-sub' }, `担当: ${r.assignee_name || '未設定'}`),
                ]),
                el('span', { class: r.has_abnormal ? 'abn-badge is-abn' : 'abn-badge' }, r.has_abnormal ? '異常あり' : '正常'),
              ])
            )
          ),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, 'トラブル履歴（直近10件）'),
        el('a', { class: 'btn btn-sm', href: `/pages/trouble?equipment_id=${eq.id}` }, 'すべて見る'),
      ]),
      troubles.length === 0
        ? el('p', { class: 'empty' }, 'トラブル記録はまだありません。')
        : el('div', { class: 'row-list' },
            troubles.map((t) =>
              el('a', { class: 'list-item', href: `/pages/trouble?id=${t.id}` }, [
                el('div', { class: 'list-item-main' }, [
                  el('div', { class: 'list-item-title' }, t.phenomenon || '（現象の記載なし）'),
                  el('div', { class: 'list-item-sub' },
                    [t.category_name, formatDateTime(t.occurred_at)].filter(Boolean).join(' / ')),
                ]),
                el('span', { class: 'chevron' }, '›'),
              ])
            )
          ),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '業務依頼（直近10件）'),
        el('a', { class: 'btn btn-sm', href: `/pages/repair?equipment_id=${eq.id}` }, 'すべて見る'),
      ]),
      repairs.length === 0
        ? el('p', { class: 'empty' }, '業務依頼はまだありません。')
        : el('div', { class: 'row-list' },
            repairs.map((r) =>
              el('a', { class: 'list-item', href: `/pages/repair?id=${r.id}` }, [
                el('div', { class: 'list-item-main' }, [
                  el('div', { class: 'list-item-title' }, r.title),
                  el('div', { class: 'list-item-sub' }, formatDateTime(r.created_at)),
                ]),
                el('span', { class: `status-badge is-${r.status}` }, REPAIR_STATUS_LABELS[r.status] || r.status),
              ])
            )
          ),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '今後の保全計画'),
        el('a', { class: 'btn btn-sm', href: '/pages/plan' }, 'カレンダー'),
      ]),
      plans.length === 0
        ? el('p', { class: 'empty' }, '予定されている保全計画はありません。')
        : el('div', { class: 'row-list' },
            plans.map((p) =>
              el('a', { class: 'list-item', href: `/pages/plan?id=${p.id}` }, [
                el('div', { class: 'list-item-main' }, [
                  el('div', { class: 'list-item-title' }, p.title),
                  el('div', { class: 'list-item-sub' },
                    [PLAN_TYPE_LABELS[p.plan_type] || p.plan_type,
                     p.planned_end_date && p.planned_end_date !== p.planned_date
                       ? `${formatDate(p.planned_date)} 〜 ${formatDate(p.planned_end_date)}`
                       : formatDate(p.planned_date)].filter(Boolean).join(' / ')),
                ]),
                el('span', { class: 'status-badge' }, PLAN_STATUS_LABELS[p.status] || p.status),
              ])
            )
          ),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '関連部品'),
        el('a', { class: 'btn btn-sm', href: '/pages/parts' }, '在庫一覧'),
      ]),
      parts.length === 0
        ? el('p', { class: 'empty' }, eq.line_name
            ? '設備名・機器名が一致する部品が登録されていません。'
            : '設備名が未設定のため照合できません。')
        : el('div', { class: 'row-list' },
            parts.map((p) => {
              const isLow = p.quantity < p.safety_stock;
              const impClass = p.importance === '高' ? 'imp-high' : p.importance === '中' ? 'imp-mid' : 'imp-low';
              return el('a', { class: 'list-item', href: `/pages/parts?id=${p.id}` }, [
                el('div', { class: 'list-item-main' }, [
                  el('div', { class: 'list-item-title' }, [
                    p.name,
                    p.importance ? el('span', { class: `imp-badge ${impClass}` }, p.importance) : null,
                  ]),
                  p.model_no ? el('div', { class: 'list-item-sub' }, `型番: ${p.model_no}`) : null,
                ]),
                el('div', { class: `parts-qty${isLow ? ' is-low' : ''}` }, [
                  el('span', { class: 'parts-qty-num' }, String(p.quantity)),
                  el('span', { class: 'parts-qty-unit' }, `/ ${p.safety_stock}`),
                  isLow ? el('span', { class: 'abn-badge is-abn', style: 'font-size:10px;padding:1px 6px;margin-left:4px' }, '要発注') : null,
                ]),
              ]);
            })
          ),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '変更履歴'),
      history.length === 0
        ? el('p', { class: 'empty' }, '履歴はありません。')
        : el('div', { class: 'row-list' },
            history.map((h) =>
              el('div', { class: 'history-row' }, [
                el('span', { class: `action-badge is-${h.action}` }, ACTION_LABELS[h.action] || h.action),
                el('span', {}, maskEmail(h.changed_by)),
                el('span', { class: 'list-item-sub' }, formatDateTime(h.changed_at)),
              ])
            )
          ),
    ]),
    buildCommentsCard('equipment_ledger', eq.id, currentUser),
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', {}, label), input]);
}

async function renderForm(existing) {
  // 設備名・機器名は全機能で共有の候補（在庫＋設備台帳）からカスケード入力する。
  // 旧データ（line_name 未設定で name のみ）の編集時は name を設備名の初期値に流用する。
  const [names, nextCodeRes] = await Promise.all([
    fetchEquipNames(),
    existing ? Promise.resolve(null) : api.get('/api/equipment/next-code').catch(() => null),
  ]);
  const cascade = buildEquipCascade(names, {
    line: existing?.line_name || existing?.name || '',
    equip: existing?.equipment_name || '',
    idPrefix: 'ledger',
  });

  const f = {
    code: el('input', { type: 'text', value: existing ? existing.code : (nextCodeRes?.code || ''), placeholder: 'INV-001' }),
    location: el('input', { type: 'text', value: existing?.location || '', placeholder: '例: 第1工場' }),
    manufacturer: el('input', { type: 'text', value: existing?.manufacturer || '' }),
    model: el('input', { type: 'text', value: existing?.model || '' }),
    serial_no: el('input', { type: 'text', value: existing?.serial_no || '', placeholder: '製造番号（シリアル番号）' }),
    manufactured_on: el('input', { type: 'month', value: existing?.manufactured_on || '' }),
    installed_on: el('input', { type: 'date', value: existing?.installed_on || '' }),
    status: el('select', {},
      Object.entries(STATUS_LABELS).map(([value, label]) =>
        el('option', { value, selected: existing ? existing.status === value : value === 'active' }, label)
      )
    ),
    note: el('textarea', { value: existing?.note || '' }),
  };

  const save = async () => {
    // 表示名(name)はサーバー側で「設備名＋機器名」から自動生成する
    const body = {
      code: f.code.value.trim(),
      line_name: cascade.lineInput.value.trim() || null,
      equipment_name: cascade.equipInput.value.trim() || null,
      location: f.location.value.trim(),
      manufacturer: f.manufacturer.value.trim(),
      model: f.model.value.trim(),
      serial_no: f.serial_no.value.trim(),
      manufactured_on: f.manufactured_on.value || null,
      installed_on: f.installed_on.value || null,
      status: f.status.value,
      note: f.note.value.trim(),
    };
    if (!body.code) { alert('設備番号は必須です。'); return; }
    if (!body.line_name) { alert('設備名は必須です。'); return; }
    try {
      if (existing) {
        await api.put(`/api/equipment/${existing.id}`, body);
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/equipment', body);
        go(`?id=${id}`);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '設備を編集' : '設備を追加'),
      field('設備番号（必須・QRラベルに使用）', f.code),
      field('設備名（必須・在庫/台帳から選択 or 自由入力）', cascade.lineInput),
      cascade.lineDatalist,
      field('機器名（設備名を選ぶと候補表示）', cascade.equipInput),
      cascade.equipDatalist,
      field('設置場所', f.location),
      field('メーカー', f.manufacturer),
      field('型式', f.model),
      field('製造番号', f.serial_no),
      field('製造年月', f.manufactured_on),
      field('設置日', f.installed_on),
      field('状態', f.status),
      field('備考', f.note),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', { class: 'btn', onclick: () => (existing ? go(`?id=${existing.id}`) : go('')) }, 'キャンセル'),
      ]),
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
      const { equipment } = await api.get(`/api/equipment/${Number(params.get('edit'))}`);
      await renderForm(equipment);
    } else if (params.get('new')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('登録する権限がありません。');
      await renderForm(null);
    } else {
      await renderList();
    }
  } catch (err) {
    showError(err);
  }
})();
