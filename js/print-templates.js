// 帳票テンプレート管理（09 管理機能内のタブ「帳票テンプレート」）
//   既存のExcel用紙を画像化してアップロードし、その上にデータ差込欄をドラッグで配置する。
//   保存した fields_json は印刷（js/print-form.js）で用紙画像に重ねて使う。
//   管理は admin。印刷は保全計画・トラブル記録の詳細画面（editor）から行う。

import { api } from '/js/api.js';
import { el, render } from '/js/util.js';
import { uploadFile, resizeImageFile } from '/js/files.js';

const TYPE_LABELS = { construction_notice: '工事連絡書', trouble_report: 'トラブル報告書' };

// データソース候補（種別別）。印刷時に recordData[source] を差し込む
const SOURCES = {
  construction_notice: ['title', 'plan_type', 'planned_date', 'planned_end_date', 'line_name', 'equipment_name', 'inspector_name', 'assignee_name', 'status', 'note'],
  trouble_report: ['occurred_at', 'equipment_code', 'equipment_name', 'category_name', 'phenomenon', 'cause', 'countermeasure', 'reporter_name'],
};
const SOURCE_LABELS = {
  title: 'タイトル', plan_type: '種別', planned_date: '予定日', planned_end_date: '期間終了日',
  line_name: '設備名', equipment_name: '機器名', inspector_name: '点検者', assignee_name: '担当者',
  status: '状態', note: '備考',
  occurred_at: '発生日時', equipment_code: '設備番号', category_name: 'ジャンル',
  phenomenon: '現象', cause: '原因', countermeasure: '対策', reporter_name: '記録者',
};
const KIND_LABELS = { data: '差込', date: '印刷日', manual: '手入力', fixed: '固定文字' };

function chipLabel(f) {
  if (f.kind === 'data') return SOURCE_LABELS[f.source] || f.source || '差込';
  if (f.kind === 'date') return '印刷日';
  if (f.kind === 'manual') return f.text || '手入力';
  if (f.kind === 'fixed') return f.text || '固定文字';
  return '項目';
}

export async function renderPrintTemplates(container) {
  let templates = [];
  try {
    ({ templates } = await api.get('/api/print-templates'));
  } catch (err) {
    render(container, el('p', { class: 'notice is-error' }, err.message));
    return;
  }

  render(container, [
    el('p', { class: 'hint' },
      '工事連絡書・トラブル報告書の用紙を登録します。Excel用紙を画像（JPEG/PNG）にして取り込み、データの差込位置をドラッグで指定してください。保全計画・トラブル記録の詳細画面から印刷できます。'),
    el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
      el('button', { class: 'btn btn-primary', onclick: () => showForm(container, null) }, '＋ テンプレートを追加'),
    ]),
    ...['construction_notice', 'trouble_report'].map((type) => {
      const list = templates.filter((t) => t.template_type === type);
      return el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, TYPE_LABELS[type]),
        list.length === 0
          ? el('p', { class: 'empty' }, 'テンプレートがありません。')
          : el('div', {}, list.map((t) => templateRow(container, t))),
      ]);
    }),
  ]);
}

function templateRow(container, t) {
  let fieldCount = 0;
  try { fieldCount = JSON.parse(t.fields_json || '[]').length; } catch { /* 壊れていても0扱い */ }
  return el('div', { class: 'pt-list-row' }, [
    el('div', { style: 'flex:1' }, [
      el('div', { class: 'list-item-title' }, t.name),
      el('div', { class: 'list-item-sub' },
        `差込欄 ${fieldCount}個 ・ ${t.orientation === 'landscape' ? '横向き' : '縦向き'}${t.image_file_id ? '' : ' ・ ⚠用紙画像なし'}`),
    ]),
    el('div', { class: 'action-row' }, [
      el('button', { class: 'btn btn-sm', onclick: () => showForm(container, t) }, '編集'),
      el('button', { class: 'btn btn-sm btn-danger', onclick: () => delTemplate(container, t) }, '削除'),
    ]),
  ]);
}

async function delTemplate(container, t) {
  if (!confirm(`帳票テンプレート「${t.name}」を削除しますか？`)) return;
  try {
    await api.del(`/api/print-templates/${t.id}`);
    await renderPrintTemplates(container);
  } catch (err) { alert(err.message); }
}

function showForm(container, existing) {
  let imageFileId = existing?.image_file_id || null;
  let orientation = existing?.orientation || 'portrait';
  let templateType = existing?.template_type || 'construction_notice';
  let fields = [];
  try { fields = existing ? JSON.parse(existing.fields_json || '[]') : []; } catch { fields = []; }

  const nameInput = el('input', { type: 'text', value: existing?.name || '', placeholder: '例: 工事連絡書（標準）' });

  const typeSelect = el('select', {
    onchange: (e) => { templateType = e.target.value; refresh(); },
  }, Object.entries(TYPE_LABELS).map(([v, l]) => el('option', { value: v }, l)));
  typeSelect.value = templateType;
  if (existing) typeSelect.disabled = true; // 編集時は種別固定（差込ソースの不整合を防ぐ）

  const orientSel = el('select', {
    onchange: (e) => { orientation = e.target.value; renderPaper(); },
  }, [['portrait', '縦'], ['landscape', '横']].map(([v, l]) => el('option', { value: v }, l)));
  orientSel.value = orientation;

  const paper = el('div', { class: 'pt-paper' });
  const fieldListBox = el('div', {});

  function renderPaper() {
    paper.replaceChildren();
    paper.classList.toggle('is-landscape', orientation === 'landscape');
    if (imageFileId) {
      paper.appendChild(el('img', { class: 'pt-paper-img', src: `/api/files/${imageFileId}`, alt: '用紙' }));
    } else {
      paper.appendChild(el('div', { class: 'pt-paper-empty' }, '用紙画像をアップロードしてください'));
    }
    for (const f of fields) paper.appendChild(makeChip(f));
  }

  function makeChip(field) {
    const chip = el('div', { class: 'pt-chip' }, chipLabel(field));
    chip.style.left = `${field.x}%`;
    chip.style.top = `${field.y}%`;
    chip.style.fontSize = `${field.font_size || 12}pt`;
    let dragging = false;
    chip.addEventListener('pointerdown', (e) => {
      dragging = true;
      chip.setPointerCapture(e.pointerId);
      chip.classList.add('is-dragging');
      e.preventDefault();
    });
    chip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = paper.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
      field.x = Math.round(x * 10) / 10;
      field.y = Math.round(y * 10) / 10;
      chip.style.left = `${field.x}%`;
      chip.style.top = `${field.y}%`;
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      chip.classList.remove('is-dragging');
      try { chip.releasePointerCapture(e.pointerId); } catch { /* 解放失敗は無視 */ }
    };
    chip.addEventListener('pointerup', end);
    chip.addEventListener('pointercancel', end);
    return chip;
  }

  function fieldRow(f, i) {
    const kindSel = el('select', {
      onchange: (e) => {
        f.kind = e.target.value;
        if (f.kind === 'data' && !SOURCES[templateType].includes(f.source)) f.source = SOURCES[templateType][0];
        refresh();
      },
    }, Object.entries(KIND_LABELS).map(([v, l]) => el('option', { value: v }, l)));
    kindSel.value = f.kind;

    let detail;
    if (f.kind === 'data') {
      const srcSel = el('select', {
        onchange: (e) => { f.source = e.target.value; refresh(); },
      }, SOURCES[templateType].map((s) => el('option', { value: s }, SOURCE_LABELS[s] || s)));
      srcSel.value = SOURCES[templateType].includes(f.source) ? f.source : SOURCES[templateType][0];
      detail = srcSel;
    } else if (f.kind === 'fixed' || f.kind === 'manual') {
      detail = el('input', {
        type: 'text', value: f.text || '',
        placeholder: f.kind === 'fixed' ? '固定文字' : '手入力の初期値（任意）',
        onchange: (e) => { f.text = e.target.value; refresh(); },
      });
    } else {
      detail = el('span', { class: 'hint' }, '印刷時に当日日付を差込');
    }

    const sizeInput = el('input', {
      type: 'number', min: '6', max: '48', value: String(f.font_size || 12), style: 'width:56px',
      onchange: (e) => { f.font_size = Number(e.target.value) || 12; refresh(); },
    });
    const alignSel = el('select', {
      onchange: (e) => { f.align = e.target.value; refresh(); },
    }, [['left', '左'], ['center', '中'], ['right', '右']].map(([v, l]) => el('option', { value: v }, l)));
    alignSel.value = f.align || 'left';

    return el('div', { class: 'pt-field-row' }, [
      el('span', { class: 'pt-field-num' }, String(i + 1)),
      kindSel,
      detail,
      el('label', { class: 'pt-field-mini' }, ['字', sizeInput, 'pt']),
      alignSel,
      el('button', { class: 'btn btn-sm btn-danger', onclick: () => { fields.splice(i, 1); refresh(); } }, '×'),
    ]);
  }

  function renderFieldList() {
    render(fieldListBox, fields.length === 0
      ? el('p', { class: 'hint' }, '「＋差込欄を追加」で項目を追加し、用紙の上でドラッグして配置します。')
      : fields.map((f, i) => fieldRow(f, i)));
  }

  const refresh = () => { renderFieldList(); renderPaper(); };

  function addField() {
    const id = `f${Date.now()}${Math.floor(Math.random() * 1000)}`;
    fields.push({ id, kind: 'data', source: SOURCES[templateType][0], text: '', x: 40, y: 10, font_size: 12, align: 'left' });
    refresh();
  }

  async function onUpload(file) {
    if (!file) return;
    try {
      const resized = await resizeImageFile(file, 2000, 0.85);
      const meta = await uploadFile(resized, { relatedTable: 'print_templates' });
      imageFileId = meta.id;
      // 縦横は画像のアスペクト比から自動推定（手動でも変更可）
      const probe = new Image();
      probe.onload = () => {
        orientation = probe.naturalWidth > probe.naturalHeight ? 'landscape' : 'portrait';
        orientSel.value = orientation;
        renderPaper();
      };
      probe.src = meta.url;
      renderPaper();
    } catch (err) {
      alert(`画像のアップロードに失敗しました: ${err.message}`);
    }
  }

  async function save() {
    const name = nameInput.value.trim();
    if (!name) { alert('テンプレート名は必須です。'); return; }
    if (!imageFileId && !confirm('用紙画像が未設定です。画像なしで保存しますか？')) return;
    const payload = {
      name, template_type: templateType, orientation,
      image_file_id: imageFileId, fields_json: JSON.stringify(fields),
    };
    try {
      if (existing) await api.put(`/api/print-templates/${existing.id}`, payload);
      else await api.post('/api/print-templates', payload);
      await renderPrintTemplates(container);
    } catch (err) { alert(err.message); }
  }

  const uploadInput = el('input', { type: 'file', accept: 'image/*', onchange: (e) => onUpload(e.target.files[0]) });

  render(container, el('div', { class: 'card' }, [
    el('div', { class: 'action-row', style: 'margin-bottom:8px' }, [
      el('button', { class: 'btn btn-sm', onclick: () => renderPrintTemplates(container) }, '← 一覧へ戻る'),
    ]),
    el('h3', { class: 'card-title' }, existing ? 'テンプレート編集' : 'テンプレート追加'),
    el('div', { class: 'field' }, [el('label', {}, 'テンプレート名（必須）'), nameInput]),
    el('div', { class: 'field' }, [el('label', {}, '種別'), typeSelect]),
    el('div', { class: 'field' }, [el('label', {}, '用紙画像（JPEG/PNG・長辺2000pxに縮小）'), uploadInput]),
    el('div', { class: 'field' }, [el('label', {}, '用紙の向き'), orientSel]),
    el('p', { class: 'hint', style: 'margin:8px 0 4px' }, '↓ 用紙の上で各差込欄をドラッグして配置します。'),
    paper,
    el('div', { class: 'action-row', style: 'margin:8px 0' }, [
      el('button', { class: 'btn btn-sm', onclick: addField }, '＋ 差込欄を追加'),
    ]),
    fieldListBox,
    el('div', { class: 'action-row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
      el('button', { class: 'btn', onclick: () => renderPrintTemplates(container) }, 'キャンセル'),
    ]),
  ]));
  renderPaper();
  renderFieldList();
}
