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
  el, render, formatDate, formatDateTime, formatBytes, ACTION_LABELS,
} from '/js/util.js';
import qrcode from '/js/vendor/qrcode.mjs';

const STATUS_LABELS = { active: '稼働中', stopped: '停止中', retired: '廃棄' };

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/ledger${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 一覧 ----------------

async function renderList() {
  const listBox = el('div', { class: 'row-list' }, []);
  let timer = null;

  const load = async (q) => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const { equipment } = await api.get(`/api/equipment${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (equipment.length === 0) {
      render(listBox, el('p', { class: 'empty' }, q ? '該当する設備がありません。' : '設備が未登録です。「設備を追加」から登録してください。'));
      return;
    }
    render(
      listBox,
      equipment.map((eq) =>
        el('a', { class: 'list-item', href: `/pages/ledger?id=${eq.id}` }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-sub' }, [
              eq.code,
              el('span', { class: `status-badge is-${eq.status}` }, STATUS_LABELS[eq.status] || eq.status),
            ]),
            el('div', { class: 'list-item-title' }, eq.name),
            el('div', { class: 'list-item-sub' }, eq.location || ''),
          ]),
          el('span', { class: 'chevron' }, '›'),
        ])
      )
    );
  };

  const searchInput = el('input', {
    type: 'search',
    placeholder: '設備番号・名称・場所で検索',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => load(e.target.value.trim()).catch(showError), 300);
    },
  });

  render(app, [
    el('div', { class: 'toolbar' }, [
      searchInput,
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 設備を追加')
        : null,
    ]),
    listBox,
  ]);
  await load('');
}

// ---------------- 詳細 ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

async function renderDetail(id) {
  const { equipment: eq, files, inspections, history } = await api.get(`/api/equipment/${id}`);
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

  // 関連資料
  const filesBox = el('div', { class: 'row-list' }, []);
  const renderFiles = (list) => {
    render(
      filesBox,
      list.length === 0
        ? el('p', { class: 'empty' }, '資料はまだありません。')
        : list.map((f) =>
            el('div', { class: 'file-row' }, [
              el('a', { class: 'file-name', href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, f.file_name),
              el('span', { class: 'file-meta' }, formatBytes(f.size_bytes)),
              canEdit
                ? el('button', {
                    class: 'btn btn-sm',
                    onclick: async () => {
                      if (!confirm(`「${f.file_name}」を削除しますか？`)) return;
                      await api.del(`/api/files/${f.id}`);
                      const fresh = await api.get(`/api/equipment/${id}`);
                      renderFiles(fresh.files);
                    },
                  }, '削除')
                : null,
            ])
          )
    );
  };
  renderFiles(files);

  const fileInput = el('input', {
    type: 'file',
    accept: 'application/pdf,image/*',
    hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const prepared = await resizeImageFile(file);
        await uploadFile(prepared, { relatedTable: 'equipment_ledger', relatedId: eq.id });
        const fresh = await api.get(`/api/equipment/${id}`);
        renderFiles(fresh.files);
      } catch (err) {
        alert(err.message);
      } finally {
        e.target.value = '';
      }
    },
  });

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, eq.name),
        el('span', { class: `status-badge is-${eq.status}` }, STATUS_LABELS[eq.status] || eq.status),
      ]),
      infoRow('設備番号', eq.code),
      infoRow('設備名（共有）', eq.line_name),
      infoRow('機器名（共有）', eq.equipment_name),
      infoRow('設置場所', eq.location),
      infoRow('メーカー', eq.manufacturer),
      infoRow('型式', eq.model),
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
        el('h3', { class: 'card-title' }, '関連資料（マニュアル・図面）'),
        canEdit ? el('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, '＋ アップロード') : null,
      ]),
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
                  el('div', { class: 'list-item-sub' }, `担当: ${r.assignee_name}`),
                ]),
                el('span', { class: r.has_abnormal ? 'abn-badge is-abn' : 'abn-badge' }, r.has_abnormal ? '異常あり' : '正常'),
              ])
            )
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
                el('span', {}, h.changed_by),
                el('span', { class: 'list-item-sub' }, formatDateTime(h.changed_at)),
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
  // 設備名・機器名の共有候補（在庫＋設備台帳）でカスケード入力を作る
  const names = await fetchEquipNames();
  const cascade = buildEquipCascade(names, {
    line: existing?.line_name || '',
    equip: existing?.equipment_name || '',
    idPrefix: 'ledger',
  });

  const f = {
    code: el('input', { type: 'text', value: existing ? existing.code : '', placeholder: '例: CP-001' }),
    name: el('input', { type: 'text', value: existing ? existing.name : '', placeholder: '例: 1号コンプレッサ' }),
    location: el('input', { type: 'text', value: existing?.location || '', placeholder: '例: 第1工場' }),
    manufacturer: el('input', { type: 'text', value: existing?.manufacturer || '' }),
    model: el('input', { type: 'text', value: existing?.model || '' }),
    installed_on: el('input', { type: 'date', value: existing?.installed_on || '' }),
    status: el('select', {},
      Object.entries(STATUS_LABELS).map(([value, label]) =>
        el('option', { value, selected: existing ? existing.status === value : value === 'active' }, label)
      )
    ),
    note: el('textarea', { value: existing?.note || '' }),
  };

  const save = async () => {
    const body = {
      code: f.code.value.trim(),
      name: f.name.value.trim(),
      line_name: cascade.lineInput.value.trim() || null,
      equipment_name: cascade.equipInput.value.trim() || null,
      location: f.location.value.trim(),
      manufacturer: f.manufacturer.value.trim(),
      model: f.model.value.trim(),
      installed_on: f.installed_on.value || null,
      status: f.status.value,
      note: f.note.value.trim(),
    };
    if (!body.code || !body.name) {
      alert('設備番号と設備名は必須です。');
      return;
    }
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
      field('設備名（必須）', f.name),
      field('設備名（共有・在庫/台帳から選択）', cascade.lineInput),
      cascade.lineDatalist,
      field('機器名（共有・設備名を選ぶと候補表示）', cascade.equipInput),
      cascade.equipDatalist,
      field('設置場所', f.location),
      field('メーカー', f.manufacturer),
      field('型式', f.model),
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
