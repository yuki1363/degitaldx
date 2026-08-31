// 帳票出力 — Excel差込（タグ置換）方式
//   管理画面で登録した Excel 用紙（セルに {{予定日}} 等のタグを入力済み）を取得し、
//   タグを保全計画／トラブル記録のデータ＋画面入力値に置換した .xlsx をダウンロードする。
//   PDF が必要な場合は、出力した Excel を開いて「PDFで保存／エクスポート」する。
//   .xlsx は ZIP+XML なので JSZip で内部XMLのタグ文字列だけを置換する。これにより
//   書式・罫線・結合セル・ロゴ画像などのレイアウトは完全に保持される。
//
//   タグの種類:
//     ・自動タグ … 保全計画/トラブル記録のデータから自動で入る（buildValues）
//     ・入力タグ … テンプレートに定義された「画面で入力する項目」（fields_json）。
//                  出力時にフォームを表示して入力。type='check' はレ点(✓)になる。

import { api } from '/js/api.js';
import { el, formatDate, formatDateTime } from '/js/util.js';
import { CONSTRUCTION_NOTICE_FIELDS, TROUBLE_REPORT_FIELDS } from '/js/permit-fields.js';
import { makeHankoPngBase64 } from '/js/hanko.js';
import { embedHankos } from '/js/xlsx-image.js';

// 種別ごとの標準入力項目（テンプレートの fields_json が不完全でも choice(○)/hanko 等を認識するため）
const STANDARD_FIELDS = {
  construction_notice: CONSTRUCTION_NOTICE_FIELDS,
  trouble_report: TROUBLE_REPORT_FIELDS,
};

const TYPE_LABELS = { construction_notice: '工事連絡書', trouble_report: 'トラブル報告書' };
const PLAN_TYPE_LABELS = { inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他' };
const STATUS_LABELS = { pending: '未実施', done: '完了', overdue: '期限超過' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CHECK_MARK = '✓';

const JSZIP_SRC = '/js/vendor/jszip.min.js'; // 同梱版（CDN不通・オフラインでも動作）
let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSZIP_SRC;
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => { jszipPromise = null; reject(new Error('JSZip の読み込みに失敗しました（オンラインで実行してください）。')); };
      document.head.appendChild(s);
    });
  }
  return jszipPromise;
}

// 'YYYY-MM-DD' → { y, mo, da }（月日は先頭ゼロなし）
function datePart(d) {
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  if (!mt) return { y: '', mo: '', da: '' };
  return { y: mt[1], mo: String(Number(mt[2])), da: String(Number(mt[3])) };
}
// 日付('YYYY-MM-DD') でも ISO日時でも JST の { y, mo, da } に分解（月日は先頭ゼロなし）
//   トラブルの occurred_at は UTC 日時なので、JST に変換してから分解する（日付ズレ防止）。
function datePartJst(v) {
  const mt = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(formatDate(v) || '');
  if (!mt) return { y: '', mo: '', da: '' };
  return { y: mt[1], mo: String(Number(mt[2])), da: String(Number(mt[3])) };
}
// 開始〜終了の日数（両端含む）。終了が無ければ1日
function daysBetween(start, end) {
  if (!start) return '';
  const s = new Date(start);
  const e = new Date(end || start);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  return String(Math.floor((e - s) / 86400000) + 1);
}

// 自動タグ → 値（種別ごと）。入力タグ（fields_json）はここに無く、フォームで集める
function buildValues(type, r) {
  const today = formatDate(new Date().toISOString());
  if (type === 'construction_notice') {
    const ds = datePart(r.planned_date);
    const de = datePart(r.planned_end_date || r.planned_date);
    return {
      'タイトル': r.title || '',
      '工事作業名称': r.title || '',
      '種別': PLAN_TYPE_LABELS[r.plan_type] || r.plan_type || '',
      '予定日': formatDate(r.planned_date),
      '期間終了日': formatDate(r.planned_end_date),
      '開始年': ds.y, '開始月': ds.mo, '開始日': ds.da,
      '終了年': de.y, '終了月': de.mo, '終了日': de.da,
      '日間': daysBetween(r.planned_date, r.planned_end_date),
      '設備名': r.line_name || '',
      '機器名': r.equipment_name || '',
      '点検者': r.inspector_name || '',
      '担当者': r.assignee_name || '',
      '状態': STATUS_LABELS[r.status] || r.status || '',
      '備考': r.note || '',
      '印刷日': today,
    };
  }
  const od = datePartJst(r.occurred_at);
  return {
    '発生日時': formatDateTime(r.occurred_at),
    '発生年月日': formatDate(r.occurred_at),
    '発生年': od.y, '発生月': od.mo, '発生日': od.da,
    '設備番号': r.equipment_code || '',
    '設備名': r.equipment_name || '',
    'ジャンル': r.category_name || '',
    '現象': r.phenomenon || '',
    '原因': r.cause || '',
    '対策': r.countermeasure || '',
    '記録者': r.reporter_name || r.creator_name || '',
    '印刷日': today,
  };
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n]+/g, ' ')   // セル内改行は空白に（書式崩れ防止）
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// XML文字列中の {{タグ}} を置換する。未知タグは原文のまま残す。
//   Excel はセルに {{会社名}} と入力しても、書式や編集履歴の都合で文字を複数の
//   <r>（run）に分割して保存することがある（例: <t>{{会社</t></r><r><t>名}}</t>）。
//   その場合タグ名の途中に XML タグが挟まるため、捕捉した名前から <...> を除去してから
//   照合する。一致したらマッチ全体（途中の run 区切りタグを含む）を値に置換するので、
//   分割された run は1つにまとまり、書式・レイアウトは保持される。
function replaceTags(xml, values) {
  return xml.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, raw) => {
    const tag = raw.replace(/<[^>]*>/g, '').trim();
    return Object.prototype.hasOwnProperty.call(values, tag) ? xmlEscape(values[tag]) : m;
  });
}

// 1つの文字列項目（共有文字列 <si> / インライン文字列 <is>）の中身を、タグ置換した
// テキストに作り直す。タグを含まなければ null を返す（＝その項目は一切変更しない）。
//   ・ふりがな <rPh> を取り除いてから本文 <t> を連結する。連結することで Excel が
//     {{会社名}} を複数の run に分割保存していても確実に置換できる。
//   ・<rPh> を残したままテキスト長が変わると、ふりがなの文字オフセットが範囲外になり
//     Excel が「内容に問題が見つかりました（修復）」を出す原因になるため、置換した
//     項目では <rPh> を捨てて単一の <t> に作り直す。
function fillStringItemInner(inner, values) {
  const noPh = inner.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '');
  let text = '';
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = tRe.exec(noPh)) !== null) text += m[1];
  if (text.indexOf('{{') === -1) return null; // タグ無し → 変更しない（書式・ふりがな保持）
  return replaceTags(text, values);
}

// sharedStrings/worksheet の文字列項目（si または is）ごとにタグ置換する。
// 置換した項目だけを単一<t>に作り直し、それ以外の項目はそのまま残す。
function fillStringItems(xml, tagName, values) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'g');
  return xml.replace(re, (whole, inner) => {
    const replaced = fillStringItemInner(inner, values);
    return replaced === null ? whole : `<${tagName}><t xml:space="preserve">${replaced}</t></${tagName}>`;
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildFilename(type, r) {
  const base = TYPE_LABELS[type] || '帳票';
  const label = type === 'construction_notice' ? (r.title || '') : (r.phenomenon || r.equipment_name || '');
  const safe = String(label).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
  return `${base}${safe ? '_' + safe : ''}.xlsx`;
}

// テンプレートが複数ある場合の選択シート
function chooseTemplate(templates) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'sheet-backdrop' });
    const done = (v) => { backdrop.remove(); resolve(v); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    backdrop.appendChild(el('div', { class: 'sheet' }, [
      el('div', { class: 'sheet-title' }, '帳票テンプレートを選択'),
      ...templates.map((t) => el('button', { class: 'sheet-btn', onclick: () => done(t) }, t.name)),
      el('button', { class: 'sheet-btn sheet-cancel', onclick: () => done(null) }, 'キャンセル'),
    ]));
    document.body.appendChild(backdrop);
  });
}

// 入力タグ（fields_json）の値を画面フォームで集める。キャンセルは null を返す
function collectInputs(title, inputFields) {
  return new Promise((resolve) => {
    const getters = [];
    const rows = inputFields.map((f, idx) => {
      const tag = f.tag;
      if (f.type === 'check') {
        const cb = el('input', { type: 'checkbox' });
        getters.push(() => [tag, cb.checked ? CHECK_MARK : '']);
        return el('label', { class: 'pf-input-check' }, [cb, ` ${f.label || tag}（レ点）`]);
      }
      // ハンコ（赤丸印）。苗字を入力すると、該当セルに印影画像が入る（テキストは出ない）。
      if (f.type === 'hanko') {
        const input = el('input', { type: 'text', placeholder: '苗字（例: 田中）' });
        getters.push(() => [tag, input.value || '']);
        return el('div', { class: 'field' }, [
          el('label', {}, `${f.label || tag}（ハンコ）`),
          input,
        ]);
      }
      // ○で1つ選択。値は「群タグ→選んだ選択肢名」で持つ（○展開は fillAndDownload 側）。
      if (f.type === 'choice' && Array.isArray(f.options) && f.options.length) {
        const name = `pf-choice-${idx}`;
        const radios = f.options.map((o) => el('input', { type: 'radio', name, value: o }));
        getters.push(() => {
          const sel = f.options.find((o, k) => radios[k].checked);
          return [tag, sel || ''];
        });
        return el('div', { class: 'field' }, [
          el('label', {}, f.label || tag),
          el('div', { class: 'pf-choice-row' },
            f.options.map((o, k) => el('label', { class: 'pf-input-check' }, [radios[k], ` ${o}`]))),
        ]);
      }
      let input;
      if (f.type === 'textarea') input = el('textarea', { rows: '2' });
      else if (f.type === 'date') input = el('input', { type: 'date' });
      else if (f.type === 'time') input = el('input', { type: 'time' });
      else input = el('input', { type: 'text' });
      getters.push(() => [tag, f.type === 'date' ? formatDate(input.value) : (input.value || '')]);
      return el('div', { class: 'field' }, [el('label', {}, f.label || tag), input]);
    });

    const backdrop = el('div', { class: 'modal-backdrop' });
    const done = (val) => { backdrop.remove(); resolve(val); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    backdrop.appendChild(el('div', { class: 'modal' }, [
      el('h2', { class: 'modal-title' }, title),
      el('p', { class: 'hint' }, '入力した内容が Excel に差し込まれます（日付・設備などは計画から自動）。'),
      el('div', { class: 'pf-input-form' }, rows),
      el('div', { class: 'modal-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          onclick: () => {
            const values = {};
            for (const get of getters) { const [t, v] = get(); values[t] = v; }
            done(values);
          },
        }, '出力'),
        el('button', { class: 'btn', onclick: () => done(null) }, 'キャンセル'),
      ]),
    ]));
    document.body.appendChild(backdrop);
  });
}

async function fillAndDownload(template, type, record, inputValues) {
  const JSZip = await loadJSZip();
  const res = await fetch(`/api/files/${template.image_file_id}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`テンプレートファイルを取得できません（HTTP ${res.status}）`);
  const buf = await res.arrayBuffer();

  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('テンプレートが Excel(.xlsx) ではないようです。管理画面で Excel を登録し直してください。');
  }
  if (!zip.file('xl/workbook.xml')) {
    throw new Error('Excel(.xlsx) として読み取れませんでした。管理画面で Excel を登録し直してください。');
  }

  // 自動タグ → 標準/定義済み入力項目の「空」既定 → 実際の入力値、の順でマージする。
  // これで未入力の入力項目も {{タグ}} を残さず空欄になる（自動タグと同名のものは除外）。
  const auto = buildValues(type, record);
  const base = { '開始時間': '', '終了時間': '' };

  // テンプレートの入力項目(fields_json)と、種別の標準項目をマージする。
  // テンプレ定義を優先しつつ、choice の options 等が欠けていれば標準項目から補う。
  // これでテンプレ定義が不完全でも、休止区分(○)・ハンコ等が正しく差し込まれる。
  let templateFields = [];
  try {
    const fields = JSON.parse(template.fields_json || '[]');
    if (Array.isArray(fields)) templateFields = fields.filter(Boolean);
  } catch { /* テンプレ定義が壊れていても続行 */ }
  const byTag = new Map();
  for (const f of (STANDARD_FIELDS[type] || [])) if (f && f.tag) byTag.set(f.tag, { ...f });
  for (const f of templateFields) {
    if (!f || !f.tag) continue;
    const std = byTag.get(f.tag);
    byTag.set(f.tag, std ? { ...std, ...f, options: f.options || std.options } : { ...f });
  }
  const parsedFields = [...byTag.values()];

  for (const f of parsedFields) {
    // choice は選択肢名そのものがセルのタグ。未選択でも {{選択肢}} を残さないよう空既定にする
    if (f.type === 'choice' && Array.isArray(f.options)) {
      if (f.tag && !(f.tag in auto)) base[f.tag] = '';
      for (const opt of f.options) if (opt && !(opt in auto)) base[opt] = '';
    } else if (f.tag && !(f.tag in auto)) {
      base[f.tag] = '';
    }
  }
  const values = { ...auto, ...base, ...(inputValues || {}) };

  // ○で1つ選択: 群タグ（例 休止種別）→選んだ選択肢名。各選択肢セル（例 {{故障休止}}）は
  // 「選択肢名」を残したまま、選ばれたものにだけ ○ を付ける（○◯故障休止 のように）。
  // セルに {{故障休止}} だけを置いても、ラベルが消えて○だけになることを防ぐ（用紙は
  // 全選択肢を並べ、該当を○で囲む運用）。群タグ自体には選んだ選択肢名が残る（任意で使える）。
  for (const f of parsedFields) {
    if (f.type !== 'choice' || !Array.isArray(f.options)) continue;
    const sel = values[f.tag] != null ? String(values[f.tag]) : '';
    for (const opt of f.options) values[opt] = opt ? (opt === sel ? `○${opt}` : opt) : '';
  }

  // ハンコ（赤丸印）: 苗字 → 印影画像を該当セルに埋め込み、タグ文字は空にして消す（画像で表現）。
  // セル特定のため、文字列置換より前に実行する（タグがまだ残っている状態で位置を探す）。
  const hankoItems = [];
  for (const f of parsedFields) {
    if (f.type !== 'hanko' || !f.tag) continue;
    const surname = String((inputValues && inputValues[f.tag]) || '').trim();
    values[f.tag] = '';
    if (surname) hankoItems.push({ tag: f.tag, base64: makeHankoPngBase64(surname) });
  }
  if (hankoItems.length) {
    try { await embedHankos(zip, hankoItems); }
    catch (e) { console.error('ハンコ画像の埋め込みに失敗しました:', e); }
  }

  // 文字列セル単位（共有文字列 <si> / インライン文字列 <is>）で置換する。
  // run 分割やふりがなの影響を受けず、置換したセルだけを作り直す（他セルは無変更）。
  if (zip.file('xl/sharedStrings.xml')) {
    const xml = await zip.file('xl/sharedStrings.xml').async('string');
    zip.file('xl/sharedStrings.xml', fillStringItems(xml, 'si', values));
  }
  for (const path of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) continue;
    const xml = await zip.file(path).async('string');
    zip.file(path, fillStringItems(xml, 'is', values));
  }

  const outBlob = await zip.generateAsync({ type: 'blob', mimeType: XLSX_MIME });
  downloadBlob(outBlob, buildFilename(type, record));
}

// テンプレートの Excel から差込タグ {{...}} を抽出する（管理画面のタグ確認用）。
//   run 分割・ふりがな(<rPh>)を考慮して <si>/<is> ごとにテキストを連結してから拾う
//   （fillStringItemInner と同じ考え方。分割保存された {{休止時間}} も1つとして拾える）。
export async function extractTemplateTags(fileId) {
  const JSZip = await loadJSZip();
  const res = await fetch(`/api/files/${fileId}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`テンプレートファイルを取得できません（HTTP ${res.status}）`);
  let zip;
  try { zip = await JSZip.loadAsync(await res.arrayBuffer()); }
  catch { throw new Error('Excel(.xlsx) として読み取れませんでした。登録し直してください。'); }

  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const tags = new Set();
  const collectFrom = async (path, tagName) => {
    const file = zip.file(path);
    if (!file) return;
    const xml = await file.async('string');
    const itemRe = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'g');
    let im;
    while ((im = itemRe.exec(xml)) !== null) {
      const noPh = im[1].replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '');
      let text = '';
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(noPh)) !== null) text += tm[1];
      text = decode(text);
      const gRe = /\{\{\s*([^{}]+?)\s*\}\}/g;
      let gm;
      while ((gm = gRe.exec(text)) !== null) tags.add(gm[1].replace(/<[^>]*>/g, '').trim());
    }
  };
  await collectFrom('xl/sharedStrings.xml', 'si');
  for (const path of Object.keys(zip.files)) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) await collectFrom(path, 'is');
  }
  return [...tags];
}

/**
 * 帳票（Excel差込）を出力する。入力項目が定義されていればフォームを表示し、
 * 入力後にタグを置換した .xlsx をダウンロードする。PDF は Excel で「PDFで保存」。
 * @param {'construction_notice'|'trouble_report'} type
 * @param {object} record 取得済みの plan / trouble オブジェクト
 */
export async function openExcelExport(type, record) {
  let templates = [];
  try {
    ({ templates } = await api.get('/api/print-templates'));
  } catch (err) {
    alert(`帳票テンプレートの取得に失敗しました: ${err.message}`);
    return;
  }
  const matches = (templates || []).filter((t) => t.template_type === type && t.image_file_id);
  if (matches.length === 0) {
    alert(`「${TYPE_LABELS[type] || type}」の Excel テンプレートが登録されていません。\n管理画面の「帳票テンプレート」から登録してください。`);
    return;
  }
  const template = matches.length === 1 ? matches[0] : await chooseTemplate(matches);
  if (!template) return;

  let inputValues = {};
  // 記録/計画ページで入力・保存済みの帳票入力値があれば、それを使う（出力時フォームは出さない）
  if (record && typeof record.form_values_json === 'string' && record.form_values_json) {
    try { inputValues = JSON.parse(record.form_values_json) || {}; } catch { inputValues = {}; }
  } else if (type !== 'trouble_report' && type !== 'construction_notice') {
    // トラブル報告書・工事連絡書は記録/計画ページで入力するため、出力時フォームは出さない。
    // それ以外で保存値が無い場合のみ、テンプレートの入力項目をフォームで集める（後方互換）。
    let inputFields = [];
    try {
      const parsed = JSON.parse(template.fields_json || '[]');
      if (Array.isArray(parsed)) inputFields = parsed.filter((f) => f && f.tag);
    } catch { inputFields = []; }
    if (inputFields.length > 0) {
      const collected = await collectInputs(`${TYPE_LABELS[type] || '帳票'}の入力`, inputFields);
      if (collected === null) return; // キャンセル
      inputValues = collected;
    }
  }

  try {
    await fillAndDownload(template, type, record, inputValues);
    // 工事連絡書を出力したら「印刷した」ものとして計画に記録する
    // （計画詳細の「印刷日」表示・工事3日前の未印刷通知に使う）。出力自体は成功しているので、
    // 記録失敗（権限・通信）ではユーザーを止めない（best-effort）。
    if (type === 'construction_notice' && record && record.id != null) {
      try {
        const { printed_at } = await api.post(`/api/plans/${record.id}/printed`);
        record.printed_at = printed_at; // 開いたままの詳細画面でも再取得なしで反映できるように
      } catch { /* 印刷記録の失敗は無視（帳票は出力済み） */ }
    }
  } catch (err) {
    alert(`帳票の出力に失敗しました: ${err.message}`);
  }
}
