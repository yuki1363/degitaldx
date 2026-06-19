// 帳票テンプレート管理（09 管理機能内のタブ「帳票テンプレート」）
//   自社の Excel 用紙の「差し込みたいセル」に {{予定日}} 等のタグを入力してアップロードする。
//   出力時にアプリがタグを実データに置換した .xlsx を生成する（js/excel-fill.js）。
//   PDF にするには、出力した Excel を開いて「PDFで保存／エクスポート」する。
//   管理は admin。出力は保全計画・トラブル記録の詳細画面（editor）から行う。

import { api } from '/js/api.js';
import { el, render } from '/js/util.js';
import { uploadFile } from '/js/files.js';

const TYPE_LABELS = { construction_notice: '工事連絡書', trouble_report: 'トラブル報告書' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// 用紙のセルに入力できる差込タグ（種別別）。excel-fill.js の buildValues と対応させる
const TAGS = {
  construction_notice: ['タイトル', '種別', '予定日', '期間終了日', '設備名', '機器名', '点検者', '担当者', '状態', '備考', '印刷日'],
  trouble_report: ['発生日時', '設備番号', '設備名', 'ジャンル', '現象', '原因', '対策', '記録者', '印刷日'],
};

function tagHelp(type) {
  return el('div', { class: 'pt-tags' }, [
    el('div', { class: 'pt-tags-label' }, 'この用紙のセルに入力できるタグ:'),
    el('div', { class: 'pt-tag-chips' }, TAGS[type].map((t) => el('code', { class: 'pt-tag' }, `{{${t}}}`))),
  ]);
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
      '自社の Excel 用紙の「差し込みたいセル」に下のタグ（例 {{予定日}}）をそのまま入力して保存し、ここでアップロードします。'
      + '保全計画・トラブル記録の詳細画面の「帳票出力」で、タグを実データに置換した Excel がダウンロードされます。'
      + 'PDF にするには、その Excel を開いて「PDFで保存／エクスポート」してください。'),
    el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
      el('button', { class: 'btn btn-primary', onclick: () => showForm(container, null) }, '＋ テンプレートを追加'),
    ]),
    ...['construction_notice', 'trouble_report'].map((type) => {
      const list = templates.filter((t) => t.template_type === type);
      return el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, TYPE_LABELS[type]),
        tagHelp(type),
        list.length === 0
          ? el('p', { class: 'empty' }, 'テンプレートがありません。')
          : el('div', {}, list.map((t) => templateRow(container, t))),
      ]);
    }),
  ]);
}

function templateRow(container, t) {
  return el('div', { class: 'pt-list-row' }, [
    el('div', { style: 'flex:1' }, [
      el('div', { class: 'list-item-title' }, t.name),
      el('div', { class: 'list-item-sub' }, t.image_file_id ? 'Excel: 設定済み' : '⚠ Excel未設定'),
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
  let templateType = existing?.template_type || 'construction_notice';
  let fileId = existing?.image_file_id || null;
  let fileName = '';

  const nameInput = el('input', { type: 'text', value: existing?.name || '', placeholder: '例: 工事連絡書（標準）' });

  const typeSelect = el('select', {
    onchange: (e) => { templateType = e.target.value; render(tagsBox, tagHelp(templateType)); },
  }, Object.entries(TYPE_LABELS).map(([v, l]) => el('option', { value: v }, l)));
  typeSelect.value = templateType;
  if (existing) typeSelect.disabled = true; // 編集時は種別固定（差込タグの不整合を防ぐ）

  const statusBox = el('div', { class: 'hint', style: 'margin-top:4px' });
  const renderStatus = () => render(statusBox, fileId ? `Excel: ${fileName || '設定済み'}` : 'Excel: 未設定');
  renderStatus();

  const tagsBox = el('div', {});
  render(tagsBox, tagHelp(templateType));

  const fileInput = el('input', { type: 'file', accept: '.xlsx', onchange: (e) => onUpload(e.target.files[0]) });

  async function onUpload(file) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) { alert('Excel（.xlsx）ファイルを選んでください。'); return; }
    // 一部のブラウザは .xlsx の MIME を空で渡すため、正しい Content-Type を明示する
    const typed = file.type === XLSX_MIME ? file : new File([file], file.name, { type: XLSX_MIME });
    render(statusBox, 'アップロード中…');
    try {
      const meta = await uploadFile(typed, { relatedTable: 'print_templates' });
      fileId = meta.id;
      fileName = meta.file_name || file.name;
      renderStatus();
    } catch (err) {
      alert(`アップロードに失敗しました: ${err.message}`);
      renderStatus();
    }
  }

  async function save() {
    const name = nameInput.value.trim();
    if (!name) { alert('テンプレート名は必須です。'); return; }
    if (!fileId && !confirm('Excelファイルが未設定です。あとで設定する場合はこのまま保存できます。続けますか？')) return;
    const payload = { name, template_type: templateType, image_file_id: fileId };
    try {
      if (existing) await api.put(`/api/print-templates/${existing.id}`, payload);
      else await api.post('/api/print-templates', payload);
      await renderPrintTemplates(container);
    } catch (err) { alert(err.message); }
  }

  render(container, el('div', { class: 'card' }, [
    el('div', { class: 'action-row', style: 'margin-bottom:8px' }, [
      el('button', { class: 'btn btn-sm', onclick: () => renderPrintTemplates(container) }, '← 一覧へ戻る'),
    ]),
    el('h3', { class: 'card-title' }, existing ? 'テンプレート編集' : 'テンプレート追加'),
    el('div', { class: 'field' }, [el('label', {}, 'テンプレート名（必須）'), nameInput]),
    el('div', { class: 'field' }, [el('label', {}, '種別'), typeSelect]),
    el('div', { class: 'field' }, [el('label', {}, 'Excel用紙（.xlsx）'), fileInput, statusBox]),
    el('div', { class: 'field' }, [
      el('label', {}, '差込タグ（Excelのセルに入力）'),
      tagsBox,
      el('p', { class: 'hint' }, '※ タグはセルに書式を変えずそのまま入力してください（例: A3 セルに {{予定日}}）。'),
    ]),
    el('div', { class: 'action-row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
      el('button', { class: 'btn', onclick: () => renderPrintTemplates(container) }, 'キャンセル'),
    ]),
  ]));
}
