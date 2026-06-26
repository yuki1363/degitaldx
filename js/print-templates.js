// 帳票テンプレート管理（09 管理機能内のタブ「帳票テンプレート」）
//   自社の Excel 用紙の「差し込みたいセル」に {{予定日}} 等のタグを入力してアップロードする。
//   タグは2種類:
//     ・自動タグ … 保全計画/トラブル記録のデータから自動で入る
//     ・入力項目 … 出力時に画面で入力する欄（会社名・許可作業のレ点・備考など）。
//                  ここで「タグ名・ラベル・種類(文字/複数行/日付/チェック)」を定義する。
//   出力時にアプリがタグを実データ＋入力値に置換した .xlsx を生成する（js/excel-fill.js）。
//   PDF にするには、出力した Excel を開いて「PDFで保存／エクスポート」する。管理は admin。

import { api } from '/js/api.js';
import { el, render } from '/js/util.js';
import { uploadFile } from '/js/files.js';
import { CONSTRUCTION_NOTICE_FIELDS } from '/js/permit-fields.js';

const TYPE_LABELS = { construction_notice: '工事連絡書', trouble_report: 'トラブル報告書' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FIELD_TYPES = { text: '文字', textarea: '複数行', date: '日付', time: '時刻', check: 'チェック(レ点)', choice: '○で1つ選択', hanko: 'ハンコ(赤丸印)' };

// 種別ごとの標準入力項目（「標準項目を読み込む」で一括投入。後から1つずつ編集・削除できる）
// 工事連絡書の標準項目は plan.js（計画ページの入力欄）と共有する（permit-fields.js）
const DEFAULT_FIELDS = {
  construction_notice: CONSTRUCTION_NOTICE_FIELDS,
  // トラブル報告書（設備関係修理報告書）の、記録に無い項目を出力時に入力するための標準セット。
  // 設備名・発生年月日・現象・原因・対策はトラブル記録から自動で入る（AUTO_TAGS 参照）。
  trouble_report: [
    { tag: '整理NO', label: '整理NO.', type: 'text' },
    { tag: '調査対象', label: '調査対象', type: 'text' },
    { tag: 'トラブル名', label: 'トラブル名', type: 'text' },
    { tag: '休止時間', label: '休止時間（分）', type: 'text' },
    { tag: '休止種別', label: '休止区分（1つ選び○）', type: 'choice', options: ['故障休止', '点検休止', '調整休止'] },
    { tag: '処置', label: '処置', type: 'textarea' },
    { tag: '有効性の確認', label: '有効性の確認', type: 'textarea' },
    { tag: '特記事項', label: '特記事項', type: 'textarea' },
    { tag: '担当者印', label: '担当者（ハンコ・苗字）', type: 'hanko' },
  ],
};
const cloneDefaults = (type) =>
  (DEFAULT_FIELDS[type] || []).map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) }));

// 計画/記録から自動で入る差込タグ（種別別）。excel-fill.js の buildValues と対応させる
const AUTO_TAGS = {
  construction_notice: ['タイトル', '工事作業名称', '種別', '予定日', '期間終了日', '開始年', '開始月', '開始日', '終了年', '終了月', '終了日', '開始時間', '終了時間', '日間', '設備名', '機器名', '点検者', '担当者', '状態', '備考', '印刷日'],
  trouble_report: ['発生年月日', '発生年', '発生月', '発生日', '発生日時', '設備番号', '設備名', 'ジャンル', '現象', '原因', '対策', '記録者', '印刷日'],
};

function autoTagHelp(type) {
  return el('div', { class: 'pt-tags' }, [
    el('div', { class: 'pt-tags-label' }, '計画から自動で入る差込タグ:'),
    el('div', { class: 'pt-tag-chips' }, AUTO_TAGS[type].map((t) => el('code', { class: 'pt-tag' }, `{{${t}}}`))),
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
      '自社の Excel 用紙の「差し込みたいセル」にタグ（例 {{予定日}}）をそのまま入力して保存し、ここでアップロードします。'
      + '日付や設備などは保全計画/トラブル記録から自動で入ります。会社名・許可作業のレ点・備考などは「入力項目」として定義すると、'
      + '出力時に入力フォームが出ます。詳細画面の「帳票出力」で、タグを実データに置換した Excel がダウンロードされ、'
      + 'Excel を開いて「PDFで保存／エクスポート」すれば PDF になります。'),
    el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
      el('button', { class: 'btn btn-primary', onclick: () => showForm(container, null) }, '＋ テンプレートを追加'),
    ]),
    ...['construction_notice', 'trouble_report'].map((type) => {
      const list = templates.filter((t) => t.template_type === type);
      return el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, TYPE_LABELS[type]),
        autoTagHelp(type),
        list.length === 0
          ? el('p', { class: 'empty' }, 'テンプレートがありません。')
          : el('div', {}, list.map((t) => templateRow(container, t))),
      ]);
    }),
  ]);
}

function templateRow(container, t) {
  let inputCount = 0;
  try { const a = JSON.parse(t.fields_json || '[]'); if (Array.isArray(a)) inputCount = a.filter((f) => f && f.tag).length; } catch { /* 壊れていても0 */ }
  return el('div', { class: 'pt-list-row' }, [
    el('div', { style: 'flex:1' }, [
      el('div', { class: 'list-item-title' }, t.name),
      el('div', { class: 'list-item-sub' },
        `${t.image_file_id ? 'Excel: 設定済み' : '⚠ Excel未設定'} ・ 入力項目 ${inputCount}個`),
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
  // 新規は種別の標準項目を最初から入れておく（編集・削除可）。既存は保存済みを読む
  let inputFields = [];
  try {
    const parsed = existing ? JSON.parse(existing.fields_json || '[]') : cloneDefaults(templateType);
    if (Array.isArray(parsed)) inputFields = parsed.map((f) => ({
      tag: f.tag || '', label: f.label || '', type: f.type || 'text',
      ...(Array.isArray(f.options) ? { options: [...f.options] } : {}),
    }));
  } catch { inputFields = []; }

  const nameInput = el('input', { type: 'text', value: existing?.name || '', placeholder: '例: 工事連絡書（標準）' });

  const typeSelect = el('select', {
    onchange: (e) => {
      templateType = e.target.value;
      render(autoBox, autoTagHelp(templateType));
      if (!existing) { inputFields = cloneDefaults(templateType); renderFields(); } // 新規は種別の標準項目に切替
    },
  }, Object.entries(TYPE_LABELS).map(([v, l]) => el('option', { value: v }, l)));
  typeSelect.value = templateType;
  if (existing) typeSelect.disabled = true; // 編集時は種別固定

  const statusBox = el('div', { class: 'hint', style: 'margin-top:4px' });
  const renderStatus = () => { statusBox.textContent = fileId ? `Excel: ${fileName || '設定済み'}` : 'Excel: 未設定'; };
  renderStatus();

  const autoBox = el('div', {});
  render(autoBox, autoTagHelp(templateType));

  // 入力項目エディタ
  const fieldsBox = el('div', {});
  const renderFields = () => {
    render(fieldsBox, inputFields.length === 0
      ? el('p', { class: 'hint' }, '「＋ 入力項目を追加」で、画面で入力する欄（会社名・許可作業のレ点・備考など）を追加します。')
      : inputFields.map((f, i) => fieldRow(f, i)));
  };
  function fieldRow(f, i) {
    const tagIn = el('input', { type: 'text', value: f.tag, placeholder: 'タグ名 例: 会社名', style: 'width:140px', oninput: (e) => { f.tag = e.target.value; } });
    const labelIn = el('input', { type: 'text', value: f.label, placeholder: 'ラベル 例: 工事業者会社名', style: 'flex:1;min-width:120px', oninput: (e) => { f.label = e.target.value; } });
    const typeSel = el('select', { onchange: (e) => { f.type = e.target.value; renderFields(); } },
      Object.entries(FIELD_TYPES).map(([v, l]) => el('option', { value: v }, l)));
    typeSel.value = f.type;
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= inputFields.length) return;
      [inputFields[i], inputFields[j]] = [inputFields[j], inputFields[i]];
      renderFields();
    };
    const row = el('div', { class: 'pt-field-row' }, [
      el('span', { class: 'pt-field-num' }, String(i + 1)),
      el('span', { class: 'pt-tag-brace' }, '{{'), tagIn, el('span', { class: 'pt-tag-brace' }, '}}'),
      labelIn,
      typeSel,
      el('button', { class: 'btn btn-sm', disabled: i === 0, title: '上へ', onclick: () => move(-1) }, '↑'),
      el('button', { class: 'btn btn-sm', disabled: i === inputFields.length - 1, title: '下へ', onclick: () => move(1) }, '↓'),
      el('button', { class: 'btn btn-sm btn-danger', title: '削除', onclick: () => { inputFields.splice(i, 1); renderFields(); } }, '×'),
    ]);
    // ○で1つ選択：選択肢を入力（選択肢名がそのままセルのタグ {{故障休止}} 等になる）
    if (f.type === 'choice') {
      const optsIn = el('input', {
        type: 'text', value: (f.options || []).join(' / '),
        placeholder: '選択肢（/ 区切り）例: 故障休止 / 点検休止 / 調整休止',
        style: 'flex:1;min-width:200px',
        oninput: (e) => { f.options = e.target.value.split(/[\/、,]/).map((s) => s.trim()).filter(Boolean); },
      });
      return el('div', {}, [
        row,
        el('div', { class: 'pt-field-row', style: 'margin-top:2px' }, [
          el('span', { class: 'pt-field-num' }, ''),
          el('span', { class: 'hint', style: 'white-space:nowrap' }, '選択肢:'),
          optsIn,
        ]),
      ]);
    }
    return row;
  }
  const addField = () => { inputFields.push({ tag: '', label: '', type: 'text' }); renderFields(); };
  const loadDefaults = () => {
    const def = cloneDefaults(templateType);
    if (!def.length) return;
    if (inputFields.some((f) => f.tag) && !confirm('現在の入力項目を、標準項目で置き換えますか？')) return;
    inputFields = def;
    renderFields();
  };
  renderFields();

  const fileInput = el('input', { type: 'file', accept: '.xlsx', onchange: (e) => onUpload(e.target.files[0]) });

  async function onUpload(file) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) { alert('Excel（.xlsx）ファイルを選んでください。'); return; }
    const typed = file.type === XLSX_MIME ? file : new File([file], file.name, { type: XLSX_MIME });
    statusBox.textContent = 'アップロード中…';
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
    const fields = inputFields
      .map((f) => ({
        tag: (f.tag || '').trim(), label: f.label || '', type: f.type || 'text',
        ...(f.type === 'choice' && Array.isArray(f.options) ? { options: f.options.filter(Boolean) } : {}),
      }))
      .filter((f) => f.tag);
    if (!fileId && !confirm('Excelファイルが未設定です。あとで設定する場合はこのまま保存できます。続けますか？')) return;
    const payload = { name, template_type: templateType, image_file_id: fileId, fields_json: JSON.stringify(fields) };
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
    autoBox,
    el('div', { class: 'field', style: 'margin-top:8px' }, [
      el('label', {}, '画面で入力する項目（Excelのセルに {{タグ名}} を置く）'),
      el('p', { class: 'hint', style: 'margin:2px 0 6px' }, '会社名・TEL・許可作業のレ点（チェック）・備考など、計画にない項目をここで定義します。種類「チェック(レ点)」はチェックすると Excel に ✓ が入ります。種類「○で1つ選択」は選択肢から1つ選ぶと、その選択肢名のセル（例 故障休止 のセルに {{故障休止}}）に ○ が入ります。種類「ハンコ(赤丸印)」は苗字を入力すると、そのタグのセル（例 {{担当者印}}）に赤丸の印影画像が入ります。'),
      fieldsBox,
      el('div', { class: 'action-row', style: 'margin-top:6px' }, [
        el('button', { class: 'btn btn-sm', onclick: addField }, '＋ 入力項目を追加'),
        DEFAULT_FIELDS[templateType] ? el('button', { class: 'btn btn-sm', onclick: loadDefaults }, '📋 標準項目を読み込む') : null,
      ]),
    ]),
    el('p', { class: 'hint', style: 'margin-top:8px' }, '※ タグはセルに書式を変えずそのまま入力してください（例: A3 セルに {{予定日}}、レ点セルに {{高所作業}}）。'),
    el('div', { class: 'action-row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
      el('button', { class: 'btn', onclick: () => renderPrintTemplates(container) }, 'キャンセル'),
    ]),
  ]));
}
