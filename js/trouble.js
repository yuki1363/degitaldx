// 04 トラブル記録 — 一覧（ジャンル・設備・期間絞り込み）・登録・編集・詳細
//   URL: /pages/trouble            … 一覧
//        /pages/trouble?new=1      … 新規登録
//        /pages/trouble?edit=N     … 編集
//        /pages/trouble?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { uploadFile, resizeImageFile } from '/js/files.js';
import { el, render, formatDate, formatDateTime, formatBytes, maskEmail, ACTION_LABELS, nowLocalInputValue, isoToLocalInputValue, localInputToIso } from '/js/util.js';
import { buildCsvText, downloadCsv, excelText } from '/js/csv.js';
import { openQrScanner } from '/js/qr-scan.js';
import { openExcelExport } from '/js/excel-fill.js';
import { TROUBLE_REPORT_FIELDS } from '/js/permit-fields.js';
import { buildEquipSelect } from '/js/equip-picker.js';
import { createDraft, installUnsavedGuard, saveErrorMessage } from '/js/draft.js';
import { enqueue as enqueueOffline } from '/js/offline-queue.js';

// CSV出力の列定義（トラブル履歴）
const CSV_COLUMNS = [
  { label: '発生日時', value: (t) => formatDateTime(t.occurred_at) },
  { label: '設備番号', value: (t) => excelText(t.equipment_code) },
  { label: '設備',     value: (t) => t.equipment_name || '' },
  { label: 'ジャンル', value: (t) => t.category_name || '' },
  { label: '現象',     value: (t) => t.phenomenon || '' },
  { label: '原因',     value: (t) => t.cause || '' },
  { label: '対策',     value: (t) => t.countermeasure || '' },
  { label: '記録者',   value: (t) => t.reporter_name || t.creator_name || t.created_by || '' },
  { label: '登録日時', value: (t) => formatDateTime(t.created_at) },
];

// 業務依頼ステータスの表示ラベル（このトラブルから作成された依頼の状況表示に使う）
const REPAIR_STATUS_LABELS = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };

const app = document.getElementById('app');
let currentUser = null;
let categories = [];

function go(query) {
  window.location.href = `/pages/trouble${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- 一覧 ----------------

async function renderList(equipmentId) {
  const [{ categories: cats }, { equipment }] = await Promise.all([
    api.get('/api/troubles/categories'),
    api.get('/api/equipment'),
  ]);
  categories = cats;

  // フィルタ状態（設備台帳の「すべて見る」から来た場合は設備で初期絞り込み）
  // 開いた時点で直近30日分を自動表示する（期間は入力で変更可）
  let filterCategory = '';
  let filterEquipment = equipmentId ? String(equipmentId) : '';
  let filterFrom = new Date(Date.now() - 30 * 86400000).toLocaleDateString('sv-SE');
  let filterTo = '';
  let currentTroubles = []; // 現在表示中の絞り込み結果（CSV出力用）

  const listBox = el('div', { class: 'row-list' }, []);

  const updateCsvButtons = () => {
    const disabled = currentTroubles.length === 0;
    csvUtf8Btn.disabled = disabled;
    csvSjisBtn.disabled = disabled;
    csvCount.textContent = `${currentTroubles.length}件`;
  };

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const params = new URLSearchParams();
    if (filterCategory) params.set('category_id', filterCategory);
    if (filterEquipment) params.set('equipment_id', filterEquipment);
    if (filterFrom) params.set('from', filterFrom);
    if (filterTo) params.set('to', filterTo);
    const { troubles } = await api.get(`/api/troubles${params.toString() ? '?' + params : ''}`);
    currentTroubles = troubles;
    updateCsvButtons();
    if (troubles.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '該当するトラブル記録がありません。'));
      return;
    }
    render(
      listBox,
      troubles.map((t) =>
        el('a', { class: 'list-item', href: `/pages/trouble?id=${t.id}` }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-sub' }, [
              formatDateTime(t.occurred_at),
              t.category_name ? el('span', { class: 'cat-badge' }, t.category_name) : null,
            ]),
            el('div', { class: 'list-item-title' }, t.phenomenon),
            el('div', { class: 'list-item-sub' }, t.equipment_name || '設備未指定'),
          ]),
          el('span', { class: 'chevron' }, '›'),
        ])
      )
    );
  };

  const catSel = el('select', { onchange: (e) => { filterCategory = e.target.value; } }, [
    el('option', { value: '' }, '全ジャンル'),
    ...cats.map((c) => el('option', { value: c.id }, c.name)),
  ]);
  const eqSel = buildEquipSelect(equipment, {
    value: filterEquipment || '',
    allLabel: '全設備',
    onchange: (e) => { filterEquipment = e.target.value; },
  });
  const fromInput = el('input', { type: 'date', value: filterFrom, onchange: (e) => { filterFrom = e.target.value; } });
  const toInput   = el('input', { type: 'date', onchange: (e) => { filterTo   = e.target.value; } });
  const searchBtn = el('button', { class: 'btn btn-primary', onclick: () => load().catch(showError) }, '🔍 検索');

  // CSV出力（現在の絞り込み結果をそのまま出力。Shift_JIS は Excel 文字化け対策）
  const exportCsv = (enc) => {
    if (currentTroubles.length === 0) return;
    const text = buildCsvText(currentTroubles, CSV_COLUMNS);
    const dateStr = new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
    downloadCsv(`trouble_${dateStr}.csv`, text, enc);
  };
  const csvUtf8Btn = el('button', { class: 'btn btn-sm', onclick: () => exportCsv('utf8') }, '📥 CSV（UTF-8/BOM）');
  const csvSjisBtn = el('button', { class: 'btn btn-sm', onclick: () => exportCsv('sjis') }, '📥 CSV（Shift_JIS）');
  const csvCount = el('span', { class: 'hint' }, '');

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'field-pair' }, [
        el('div', { class: 'field' }, [el('label', {}, 'ジャンル'), catSel]),
        el('div', { class: 'field' }, [el('label', {}, '設備'), eqSel]),
      ]),
      el('div', { class: 'field-pair' }, [
        el('div', { class: 'field' }, [el('label', {}, '期間（から）'), fromInput]),
        el('div', { class: 'field' }, [el('label', {}, '〜（まで）'), toInput]),
      ]),
      el('div', { class: 'action-row', style: 'margin-top:8px' }, [searchBtn]),
    ]),
    el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
      hasRole(currentUser, 'editor')
        ? el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ トラブルを記録')
        : null,
      csvUtf8Btn,
      csvSjisBtn,
      csvCount,
    ]),
    listBox,
  ]);
  // 開いた時点で直近30日分を自動表示（条件を変えたら「検索」で再絞り込み）
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
  const { trouble, files, history } = await api.get(`/api/troubles/${id}`);
  // このトラブルから作成された業務依頼（相互リンクの逆引き）。列未追加の環境でも落ちないよう握りつぶす。
  const { repairs: linkedRepairs = [] } =
    await api.get(`/api/repairs?source_table=trouble_record&source_id=${id}`).catch(() => ({ repairs: [] }));
  const canEdit = hasRole(currentUser, 'editor');

  // ファイル一覧
  const filesBox = el('div', { class: 'row-list' }, []);
  const renderFiles = (list) => {
    if (list.length === 0) {
      render(filesBox, el('p', { class: 'empty' }, '添付ファイルはありません。'));
      return;
    }
    const imgs = list.filter((f) => f.content_type.startsWith('image/'));
    const others = list.filter((f) => !f.content_type.startsWith('image/'));
    render(filesBox, [
      imgs.length > 0
        ? el('div', { class: 'thumb-grid' },
            imgs.map((f) =>
              el('a', { href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' },
                el('img', { class: 'thumb', src: `/api/files/${f.id}`, alt: f.file_name, loading: 'lazy' })
              )
            )
          )
        : null,
      ...others.map((f) =>
        el('div', { class: 'file-row' }, [
          el('a', { class: 'file-name', href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, f.file_name),
          el('span', { class: 'file-meta' }, formatBytes(f.size_bytes)),
        ])
      ),
    ]);
  };
  renderFiles(files);

  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*,video/*',
    multiple: true,
    hidden: true,
    onchange: async (e) => {
      const fileList = Array.from(e.target.files);
      if (!fileList.length) return;
      try {
        for (const file of fileList) {
          const prepared = await resizeImageFile(file);
          await uploadFile(prepared, { relatedTable: 'trouble_record', relatedId: id });
        }
        const fresh = await api.get(`/api/troubles/${id}`);
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
        el('h2', { class: 'card-title' }, trouble.phenomenon),
        trouble.category_name ? el('span', { class: 'cat-badge' }, trouble.category_name) : null,
      ]),
      infoRow('発生日時', formatDateTime(trouble.occurred_at)),
      infoRow('設備', trouble.equipment_name ? `${trouble.equipment_code} ${trouble.equipment_name}` : null),
      infoRow('原因', trouble.cause),
      infoRow('対策', trouble.countermeasure),
      ...parseCustomValues(trouble.custom_fields_json).map((v) => infoRow(v.name, v.value)),
      infoRow('記録者', trouble.reporter_name || trouble.creator_name || maskEmail(trouble.created_by)),
    ]),
    canEdit
      ? el('div', { class: 'action-row' }, [
          // このトラブルを業務依頼へエスカレーション（設備・現象・原因・対策をプリフィル＋起票元リンク）
          (() => {
            const q = new URLSearchParams({ new: '1', source_table: 'trouble_record', source_id: String(id) });
            if (trouble.equipment_id) q.set('equipment_id', String(trouble.equipment_id));
            q.set('title', `【トラブル対応】${trouble.equipment_name || trouble.phenomenon || ''}`.slice(0, 80));
            q.set('description', [
              `現象: ${trouble.phenomenon || ''}`,
              trouble.cause ? `原因: ${trouble.cause}` : null,
              trouble.countermeasure ? `対策: ${trouble.countermeasure}` : null,
            ].filter(Boolean).join('\n'));
            return el('a', { class: 'btn btn-primary', href: `/pages/repair?${q}` }, '🔧 業務依頼を作成');
          })(),
          // このトラブルを日報に記録（発生日を初期日付に設定・現象/原因/対策を本文へプリフィル・プリチェック済みで開く）
          (() => {
            const date = trouble.occurred_at
              ? new Date(trouble.occurred_at).toLocaleDateString('sv-SE')
              : new Date().toLocaleDateString('sv-SE');
            const q = new URLSearchParams({ new: '1', link_type: 'trouble', link_id: String(trouble.id), date });
            const eqLabel = trouble.equipment_name ? `${trouble.equipment_code} ${trouble.equipment_name}` : '';
            q.set('body', [
              `【トラブル対応】${eqLabel}`.trim(),
              `現象: ${trouble.phenomenon || ''}`,
              trouble.cause ? `原因: ${trouble.cause}` : null,
              trouble.countermeasure ? `対策: ${trouble.countermeasure}` : null,
            ].filter(Boolean).join('\n'));
            return el('a', { class: 'btn', href: `/pages/report?${q}` }, '📝 日報に記録');
          })(),
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}`) }, '編集'),
          el('button', { class: 'btn', onclick: () => openExcelExport('trouble_report', trouble) }, '📄 帳票(Excel)出力'),
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm('このトラブル記録を削除しますか？')) return;
              await api.del(`/api/troubles/${id}`);
              go('');
            },
          }, '削除'),
        ])
      : null,
    // このトラブルから作成された業務依頼（あれば対応状況まで辿れる）
    linkedRepairs.length > 0
      ? el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, 'このトラブルから作成された業務依頼'),
          el('div', { class: 'row-list' },
            linkedRepairs.map((r) =>
              el('a', { class: 'list-item', href: `/pages/repair?id=${r.id}` }, [
                el('div', { class: 'list-item-main' }, [
                  el('div', { class: 'list-item-title' }, r.title),
                  el('div', { class: 'list-item-sub' }, formatDateTime(r.created_at)),
                ]),
                el('span', { class: `status-badge is-${r.status}` }, REPAIR_STATUS_LABELS[r.status] || r.status),
              ])
            )
          ),
        ])
      : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h3', { class: 'card-title' }, '添付写真・ファイル'),
        canEdit ? el('button', { class: 'btn btn-sm', onclick: () => fileInput.click() }, '＋ 添付') : null,
      ]),
      fileInput,
      filesBox,
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
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', {}, label), input]);
}

// custom_fields_json（文字列）→ [{ field_id, name, value }] を安全にパース
function parseCustomValues(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// トラブル報告書テンプレートの「入力項目」を集める（未登録時は標準項目 TROUBLE_REPORT_FIELDS）
function buildReportFields(templates) {
  const seen = new Set();
  const fields = [];
  for (const t of (templates || [])) {
    if (t.template_type !== 'trouble_report') continue;
    let fs = [];
    try { fs = JSON.parse(t.fields_json || '[]'); } catch { fs = []; }
    for (const f of (Array.isArray(fs) ? fs : [])) {
      if (f && f.tag && !seen.has(f.tag)) {
        seen.add(f.tag);
        fields.push({ tag: f.tag, label: f.label || f.tag, type: f.type || 'text', ...(Array.isArray(f.options) ? { options: f.options } : {}) });
      }
    }
  }
  if (fields.length === 0) return TROUBLE_REPORT_FIELDS.map((f) => ({ ...f }));
  return fields;
}

// form_values_json を安全にパース
function parseFormValues(jsonStr) {
  try { return jsonStr ? (JSON.parse(jsonStr) || {}) : {}; }
  catch { return {}; }
}

async function renderForm(existing, prefill = null) {
  // existing = 本物の編集（PUT）。prefill = 点検異常などからの新規プリフィル（POST のまま）。
  const init = existing || prefill || {};
  const [{ categories: cats }, { equipment }, { fields: customFields }, usersRes, templatesRes] = await Promise.all([
    api.get('/api/troubles/categories'),
    api.get('/api/equipment'),
    // カスタム項目テーブル未作成の環境でもフォーム自体は使えるようにする
    api.get('/api/troubles/fields').catch(() => ({ fields: [] })),
    api.get('/api/users').catch(() => ({ users: [] })),
    // トラブル報告書テンプレートの入力項目（帳票入力欄に使う。未登録時は標準項目）
    api.get('/api/print-templates').catch(() => ({ templates: [] })),
  ]);
  const users = usersRes.users || [];

  // トラブル報告書（帳票）の入力欄。ここで入力した値を form_values_json に保存し、
  // 帳票出力時に Excel へ自動差込する（出力時の再入力が不要になる）。
  const reportFields = buildReportFields(templatesRes.templates);
  const reportValues = parseFormValues(existing?.form_values_json);

  const f = {
    occurred_at: el('input', {
      type: 'datetime-local',
      value: existing ? isoToLocalInputValue(existing.occurred_at) : nowLocalInputValue(),
    }),
    category_id: el('select', {},
      [el('option', { value: '' }, '— ジャンルを選択'),
      ...cats.map((c) =>
        el('option', { value: c.id, selected: existing?.category_id === c.id }, c.name)
      )]
    ),
    equipment_id: buildEquipSelect(equipment, {
      value: init.equipment_id || '',
      allLabel: '設備を選択（任意）',
    }),
    phenomenon: el('textarea', { placeholder: '例: 異音が発生した' }, init.phenomenon || ''),
    cause: el('textarea', { placeholder: '例: ベルトの摩耗' }, existing?.cause || ''),
    countermeasure: el('textarea', { placeholder: '例: ベルト交換' }, existing?.countermeasure || ''),
    reporter_name: el('input', {
      type: 'text',
      // 記録者は自由入力。編集時は保存済みの値（旧データは作成者名で補完）、
      // 新規はログインユーザー名を初期値にする（毎回の手入力を省く。変更可）
      value: existing ? (existing.reporter_name || existing.creator_name || '') : (currentUser?.name || ''),
      placeholder: '記録者名（自由入力）',
      list: 'trouble-reporter-options',
    }),
  };

  // 記録者の入力候補（登録ユーザー名）
  const reporterOptions = el('datalist', { id: 'trouble-reporter-options' },
    users.map((u) => el('option', { value: u.name || u.email }))
  );

  // カスタム項目（管理画面で定義した追加入力欄）
  const existingCustom = parseCustomValues(existing?.custom_fields_json);
  const customInputs = customFields.map((fld) => {
    const prev = existingCustom.find((v) => v.field_id === fld.id);
    let input;
    if (fld.input_type === 'select') {
      let opts = [];
      try { opts = JSON.parse(fld.options_json) || []; } catch { /* 定義不正時は選択肢なし */ }
      input = el('select', {}, [
        el('option', { value: '' }, '— 選択'),
        ...opts.map((o) => el('option', { value: o, selected: prev?.value === o }, o)),
      ]);
    } else if (fld.input_type === 'number') {
      input = el('input', { type: 'number', value: prev?.value ?? '' });
    } else {
      input = el('input', { type: 'text', value: prev?.value ?? '' });
    }
    return { fld, input };
  });

  // 写真・動画・PDF（保存時にまとめてアップロードして紐づける）
  const pendingFiles = [];
  const fileListBox = el('div', { class: 'row-list' }, []);
  const renderPending = () => {
    render(fileListBox, pendingFiles.map((file, idx) =>
      el('div', { class: 'file-row' }, [
        el('span', { class: 'file-name' }, file.name),
        el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => { pendingFiles.splice(idx, 1); renderPending(); },
        }, '外す'),
      ])
    ));
  };
  const fileInput = el('input', {
    type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true,
    onchange: (e) => {
      for (const file of e.target.files) pendingFiles.push(file);
      renderPending();
      e.target.value = '';
    },
  });

  // トラブル報告書（帳票）の入力欄を1項目ぶん作る（reportValues に値をバインド）
  const reportInput = (fld) => {
    const tag = fld.tag;
    const cur = reportValues[tag] != null ? String(reportValues[tag]) : '';
    if (fld.type === 'check') {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = cur === '✓';
      cb.addEventListener('change', () => { reportValues[tag] = cb.checked ? '✓' : ''; });
      return el('label', { class: 'pf-input-check' }, [cb, ` ${fld.label || tag}`]);
    }
    if (fld.type === 'choice' && Array.isArray(fld.options)) {
      const name = `trb-choice-${tag}`;
      const radios = fld.options.map((o) => {
        const rb = el('input', { type: 'radio', name, value: o });
        rb.checked = (cur === o);
        rb.addEventListener('change', () => { if (rb.checked) reportValues[tag] = o; });
        return el('label', { class: 'pf-input-check' }, [rb, ` ${o}`]);
      });
      return el('div', { class: 'field' }, [el('label', {}, fld.label || tag), el('div', { class: 'pf-choice-row' }, radios)]);
    }
    if (fld.type === 'hanko') {
      const input = el('input', { type: 'text', value: cur, placeholder: '苗字（例: 田中）' });
      input.addEventListener('input', () => { reportValues[tag] = input.value; });
      return el('div', { class: 'field' }, [el('label', {}, `${fld.label || tag}（ハンコ）`), input]);
    }
    let input;
    if (fld.type === 'textarea') input = el('textarea', { rows: '2', value: cur });
    else if (fld.type === 'date') input = el('input', { type: 'date', value: cur });
    else if (fld.type === 'time') input = el('input', { type: 'time', value: cur });
    else input = el('input', { type: 'text', value: cur });
    input.addEventListener('input', () => { reportValues[tag] = input.value; });
    return el('div', { class: 'field' }, [el('label', {}, fld.label || tag), input]);
  };
  // 帳票入力欄は再描画できる箱にしておく（下書き復元時に reportValues を反映し直すため）
  const reportBox = el('div', {});
  const renderReportSection = () => {
    if (reportFields.length === 0) { render(reportBox, []); return; }
    render(reportBox, el('div', { class: 'card', style: 'background:#f8fafc;margin:0' }, [
      el('h4', { style: 'margin:0 0 4px;font-size:14px;color:#374151' }, 'トラブル報告書（帳票）の入力'),
      el('p', { class: 'hint', style: 'margin:0 0 8px' }, 'ここで入力した内容が「帳票出力」でExcelに差し込まれます（出力時に入力し直す必要はありません）。'),
      ...reportFields.map(reportInput),
    ]));
  };
  renderReportSection();

  // ---- 入力を失わない仕組み ----
  //   新規: 入力を下書きとして自動保存（localStorage）。誤って閉じても次回「復元」できる。
  //   編集: サーバーに元データがあるため下書きは使わず、離脱時の未保存警告のみ。
  const collectDraft = () => ({
    occurred_at: f.occurred_at.value,
    category_id: f.category_id.value,
    equipment_id: f.equipment_id.value,
    phenomenon: f.phenomenon.value,
    cause: f.cause.value,
    countermeasure: f.countermeasure.value,
    reporter_name: f.reporter_name.value,
    custom: customInputs.map(({ fld, input }) => ({ id: fld.id, value: input.value })),
    report: { ...reportValues },
  });
  const applyDraft = (d) => {
    if (d.occurred_at) f.occurred_at.value = d.occurred_at;
    if (d.category_id != null) f.category_id.value = d.category_id;
    if (d.equipment_id != null) f.equipment_id.value = d.equipment_id;
    f.phenomenon.value = d.phenomenon || '';
    f.cause.value = d.cause || '';
    f.countermeasure.value = d.countermeasure || '';
    if (d.reporter_name) f.reporter_name.value = d.reporter_name;
    for (const c of (d.custom || [])) {
      const target = customInputs.find(({ fld }) => fld.id === c.id);
      if (target) target.input.value = c.value;
    }
    Object.assign(reportValues, d.report || {});
    renderReportSection();
  };
  const draft = existing ? null : createDraft('trouble-new', collectDraft);
  const guard = installUnsavedGuard(); // 新規・編集とも離脱時に警告（新規はさらに下書きでも守る）
  if (draft) {
    const touch = () => draft.touch();
    app.addEventListener('input', touch);
    app.addEventListener('change', touch);
  }
  const draftBanner = draft ? draft.banner(applyDraft) : null;

  const save = async () => {
    const customValues = customInputs
      .map(({ fld, input }) => ({ field_id: fld.id, name: fld.name, value: String(input.value).trim() }))
      .filter((v) => v.value !== '');
    // 帳票入力値は空でないものだけ保存（空文字は除外）
    const reportClean = {};
    for (const [k, v] of Object.entries(reportValues)) {
      if (v != null && String(v) !== '') reportClean[k] = v;
    }
    const body = {
      occurred_at: localInputToIso(f.occurred_at.value),
      category_id: f.category_id.value ? Number(f.category_id.value) : null,
      equipment_id: f.equipment_id.value ? Number(f.equipment_id.value) : null,
      phenomenon: f.phenomenon.value.trim(),
      cause: f.cause.value.trim() || null,
      countermeasure: f.countermeasure.value.trim() || null,
      reporter_name: f.reporter_name.value.trim() || null,
      custom_fields_json: customValues.length > 0 ? customValues : null,
      form_values_json: Object.keys(reportClean).length > 0 ? reportClean : null,
      // 同時編集ガード: 編集開始時点の updated_at を送り、他の人が先に更新していたら409で知らせる
      ...(existing ? { expected_updated_at: existing.updated_at } : {}),
    };
    if (!body.phenomenon) { alert('現象は必須です。'); return; }
    if (!body.occurred_at) { alert('発生日時は必須です。'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    const fileIds = []; // アップロード済み分（オフライン失敗時のキュー投入で使うため try の外に置く）
    try {
      // 添付（画像はリサイズしてEXIF除去、動画はそのまま）を先に送って file_ids を集める
      for (const file of pendingFiles) {
        saveBtn.textContent = `写真を送信中… (${fileIds.length + 1}/${pendingFiles.length})`;
        const prepared = await resizeImageFile(file);
        const meta = await uploadFile(prepared, {});
        fileIds.push(meta.id);
      }
      saveBtn.textContent = '保存中…';
      body.file_ids = fileIds;
      if (existing) {
        await api.put(`/api/troubles/${existing.id}`, body);
        guard?.clear(); // 保存済みなので離脱警告を出さない
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/troubles', body);
        draft?.clear(); // 保存できたので下書きを消す
        guard?.clear();
        go(`?id=${id}`);
      }
    } catch (err) {
      // オフライン起因の失敗（新規のみ）は送信待ちキューに保存し、復帰時に自動送信する。
      // アップロード済みの写真IDは payload に、未送信の写真はリサイズ済みBlobでキューに入れる
      // （二重アップロードも取り残しも発生しない）。
      const offline = err?.offline === true || navigator.onLine === false;
      if (offline && !existing) {
        try {
          const remaining = [];
          for (const file of pendingFiles.slice(fileIds.length)) {
            remaining.push(await resizeImageFile(file));
          }
          await enqueueOffline('trouble', { ...body, file_ids: fileIds }, remaining);
          draft?.clear();
          guard?.clear();
          alert('オフラインのため「送信待ち」に保存しました。\n通信が回復すると自動で送信されます。');
          go('');
          return;
        } catch { /* キュー保存に失敗した場合は通常のエラー表示にフォールバック */ }
      }
      alert(saveErrorMessage(err));
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  };
  const saveBtn = el('button', { class: 'btn btn-primary', onclick: () => save() }, '保存');

  render(app, [
    draftBanner,
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? 'トラブル記録を編集' : 'トラブルを記録'),
      field('発生日時（必須）', f.occurred_at),
      field('ジャンル', f.category_id),
      el('div', { class: 'field' }, [
        el('label', {}, '設備'),
        el('div', { class: 'inline-form' }, [
          f.equipment_id,
          el('button', {
            type: 'button', class: 'btn btn-sm',
            onclick: () => openQrScanner((eqId) => { f.equipment_id.value = String(eqId); }),
          }, '📷 QR'),
        ]),
      ]),
      field('現象（必須）', f.phenomenon),
      field('原因', f.cause),
      field('対策', f.countermeasure),
      field('記録者', f.reporter_name),
      reporterOptions,
      ...customInputs.map(({ fld, input }) => field(fld.name, input)),
      reportBox,
      el('div', { class: 'field' }, [
        el('label', {}, '写真・動画'),
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:4px' }, [
          el('button', { type: 'button', class: 'btn btn-sm', onclick: () => fileInput.click() }, '📷 写真・動画を追加'),
        ]),
        fileInput,
        fileListBox,
      ]),
      el('div', { class: 'action-row' }, [
        saveBtn,
        el('button', {
          class: 'btn',
          // 明示的なキャンセルでは未保存警告を出さない（新規の下書きは残る＝次回復元できる）
          onclick: () => { guard?.clear(); existing ? go(`?id=${existing.id}`) : go(''); },
        }, 'キャンセル'),
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
      const { trouble } = await api.get(`/api/troubles/${Number(params.get('edit'))}`);
      await renderForm(trouble);
    } else if (params.get('new')) {
      if (!hasRole(currentUser, 'editor')) throw new Error('登録する権限がありません。');
      // 点検異常などからのプリフィル（設備・現象）を受け取る
      const prefill = {
        equipment_id: Number(params.get('equipment_id')) || null,
        phenomenon: params.get('phenomenon') || '',
      };
      await renderForm(null, prefill);
    } else {
      await renderList(Number(params.get('equipment_id')) || undefined);
    }
  } catch (err) {
    showError(err);
  }
})();
