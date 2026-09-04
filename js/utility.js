// 13 ユーティリティ日報 — 一覧・入力・詳細・項目マスタ
//   URL: /pages/utility            … 一覧
//        /pages/utility?new=1      … 新規入力（当日分）
//        /pages/utility?edit=N     … 編集
//        /pages/utility?id=N       … 詳細
//        /pages/utility?items=1    … 点検項目マスタ（管理者のみ）
//
//   入力UIは 02 点検の buildItemInput をそのまま流用する（前回値・基準範囲外の警告つき）。
//   1日1件が原則。同じ日が既にあると API が 409 を返すので、既存の編集画面へ誘導する。

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail, ACTION_LABELS } from '/js/util.js';
import { buildItemInput, normalizeNumberText } from '/js/inspection-items.js';
import { createDraft, installUnsavedGuard, saveErrorMessage } from '/js/draft.js';
import { buildCsvText, downloadCsv } from '/js/csv.js';

const app = document.getElementById('app');
let currentUser = null;

const go = (query = '') => { window.location.href = `/pages/utility${query}`; };
const showError = (err) => render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
const todayStr = () => new Date().toLocaleDateString('sv-SE');

/** 保存値を表示用の文字列にする（複数選択は「1号機、2号機」） */
function displayValue(v) {
  if (v === null || v === undefined || v === '') return '';
  const text = Array.isArray(v.value) ? v.value.join('、') : String(v.value);
  return v.unit ? `${text} ${v.unit}` : text;
}

/** datetime-local 用のローカル日時文字列（YYYY-MM-DDTHH:MM） */
function toLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return toLocalInput(null);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------- 一覧 ----------------

async function renderList() {
  let from = new Date(Date.now() - 30 * 86400000).toLocaleDateString('sv-SE');
  let to = todayStr();
  let loaded = [];

  const listBox = el('div', { class: 'row-list' }, []);
  const actionBox = el('div', { class: 'filter-bar' }, []);

  const renderAction = () => {
    if (!hasRole(currentUser, 'editor')) { render(actionBox, []); return; }
    const today = loaded.find((r) => r.report_date === todayStr());
    render(actionBox, today
      ? el('button', { class: 'btn', onclick: () => go(`?edit=${today.id}`) }, '✅ 本日入力済み（編集する）')
      : el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 本日分を入力する'));
  };

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const { reports } = await api.get(`/api/utility-reports?${p}`);
    loaded = reports;
    renderAction();
    if (reports.length === 0) {
      render(listBox, el('p', { class: 'empty' }, 'この期間のユーティリティ日報はありません。'));
      return;
    }
    render(listBox, reports.map((r) => el('a', { class: 'list-item', href: `/pages/utility?id=${r.id}` }, [
      el('div', { class: 'list-item-main' }, [
        el('div', { class: 'list-item-sub' }, [
          r.has_abnormal ? el('span', { class: 'cat-badge', style: 'background:#fee2e2;color:#b91c1c' }, '⚠ 異常あり') : null,
          ` ${r.reporter_name || maskEmail(r.created_by)}`,
        ]),
        el('div', { class: 'list-item-title' }, r.report_date.replace(/-/g, '/')),
        r.note ? el('div', { class: 'list-item-sub' }, r.note.slice(0, 40)) : null,
      ]),
      el('span', { class: 'chevron' }, '›'),
    ])));
  };

  // CSV出力: 項目マスタから列を組み立て、値は各記録の values から引く
  const exportCsv = async (encoding) => {
    const p = new URLSearchParams({ with_values: '1' });
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const [{ items }, { reports }] = await Promise.all([
      api.get('/api/utility-reports/items'),
      api.get(`/api/utility-reports?${p}`),
    ]);
    if (reports.length === 0) { window.alert('出力できる記録がありません。'); return; }
    const columns = [
      { label: '点検日', value: (r) => r.report_date },
      { label: '点検日時', value: (r) => formatDateTime(r.inspected_at) },
      { label: '入力者', value: (r) => r.reporter_name || maskEmail(r.created_by) },
      { label: '異常', value: (r) => (r.has_abnormal ? '異常あり' : '') },
      ...items.map((it) => ({
        label: it.unit ? `${it.name}(${it.unit})` : it.name,
        value: (r) => {
          const v = (r.values || []).find((x) => x.item_id === it.id);
          if (!v) return '';
          return Array.isArray(v.value) ? v.value.join('・') : String(v.value);
        },
      })),
      { label: '特記事項', value: (r) => r.note || '' },
    ];
    downloadCsv(`utility-report-${todayStr()}.csv`, buildCsvText(reports, columns), encoding);
  };

  const fromIn = el('input', { type: 'date', value: from, onchange: (e) => { from = e.target.value; } });
  const toIn = el('input', { type: 'date', value: to, onchange: (e) => { to = e.target.value; } });

  render(app, [
    actionBox,
    el('div', { class: 'filter-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromIn]),
      el('label', { class: 'filter-label' }, ['TO ', toIn]),
      el('button', { class: 'btn btn-primary', onclick: () => load().catch(showError) }, '🔍 検索'),
    ]),
    el('div', { class: 'filter-bar' }, [
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv('UTF-8').catch(showError) }, '📥 CSV（UTF-8/BOM）'),
      el('button', { class: 'btn btn-sm', onclick: () => exportCsv('sjis').catch(showError) }, '📥 CSV（Shift_JIS）'),
      hasRole(currentUser, 'admin')
        ? el('button', { class: 'btn btn-sm', onclick: () => go('?items=1') }, '⚙️ 点検項目')
        : null,
    ]),
    listBox,
  ]);
  await load();
}

// ---------------- 入力（新規・編集） ----------------

async function renderForm(existing) {
  const { items } = await api.get('/api/utility-reports/items');
  if (items.length === 0) {
    render(app, [
      el('p', { class: 'notice is-warning' }, '点検項目が登録されていません。'),
      hasRole(currentUser, 'admin')
        ? el('a', { class: 'btn', href: '/pages/utility?items=1' }, '点検項目を登録する')
        : el('p', { class: 'hint' }, '管理者に点検項目の登録を依頼してください。'),
    ]);
    return;
  }

  const reportDate = existing ? existing.report_date : todayStr();

  // 前回値（この日より前の直近の記録）。数値は差分（↑↓→）付き、
  // 選択式・複数選択・時刻は「前回 ○○（日付）」を入力欄の下に表示する。
  // 取得に失敗しても入力は続けられる。
  const lastValues = new Map();
  try {
    const p = new URLSearchParams({ before: reportDate });
    if (existing) p.set('exclude_id', String(existing.id));
    const { report: prev } = await api.get(`/api/utility-reports/latest?${p}`);
    for (const v of prev?.values || []) {
      if (v.value !== null && v.value !== undefined && v.value !== '') {
        lastValues.set(v.item_id, { value: v.value, date: prev.report_date });
      }
    }
  } catch { /* 前回値なしで続行 */ }

  const existingValues = new Map((existing?.values || []).map((v) => [v.item_id, v.value]));

  const draft = createDraft(existing ? `utility-${existing.id}` : 'utility-new', () => ({
    report_date: dateIn.value,
    inspected_at: datetimeIn.value,
    reporter_name: reporterIn.value,
    note: noteIn.value,
  }));
  const guard = installUnsavedGuard();

  const dateIn = el('input', { type: 'date', value: reportDate, onchange: () => draft.touch() });
  const datetimeIn = el('input', {
    type: 'datetime-local',
    value: toLocalInput(existing?.inspected_at),
    onchange: () => draft.touch(),
  });
  const reporterIn = el('input', {
    type: 'text',
    value: existing ? (existing.reporter_name || '') : (currentUser?.name || ''),
    placeholder: '入力者名',
    oninput: () => draft.touch(),
  });
  const noteIn = el('textarea', {
    rows: 4,
    placeholder: '異常・特記事項があれば入力',
    oninput: () => draft.touch(),
  }, existing?.note || '');

  // セクションごとに1枚のカードにまとめ、縦1カラムで並べる（375px幅基準）。
  //（el() は呼び出し時点の子要素しか取り込まないため、入れ物を先に作って追記していく。
  //   同じセクション名は1枚にまとめる＝管理画面で並び順が前後してもカードが分断されない）
  const inputs = [];
  const sections = [];
  const bodyBySection = new Map();
  for (const item of items) {
    const name = item.section || 'その他';
    let body = bodyBySection.get(name);
    if (!body) {
      body = el('div', {}, []);
      bodyBySection.set(name, body);
      sections.push(el('div', { class: 'card' }, [el('h2', { class: 'card-title' }, name), body]));
    }
    const built = buildItemInput(item, existingValues.get(item.id), lastValues.get(item.id));
    inputs.push({ item, getValue: built.getValue });
    body.appendChild(built.box);
  }

  const notice = el('p', { class: 'notice is-error', hidden: true }, '');
  const saveBtn = el('button', { class: 'btn btn-primary' }, existing ? '保存する' : '登録する');

  saveBtn.addEventListener('click', async () => {
    notice.hidden = true;
    saveBtn.disabled = true;
    try {
      const values = {};
      for (const { item, getValue } of inputs) {
        const v = getValue();
        if (v !== undefined && v !== '') values[item.id] = v;
      }
      const body = {
        report_date: dateIn.value,
        inspected_at: datetimeIn.value ? new Date(datetimeIn.value).toISOString() : undefined,
        reporter_name: reporterIn.value.trim(),
        note: noteIn.value.trim(),
        values,
      };
      if (existing) {
        await api.put(`/api/utility-reports/${existing.id}`, { ...body, expected_updated_at: existing.updated_at });
      } else {
        await api.post('/api/utility-reports', body);
      }
      draft.clear();
      guard.clear();
      go(existing ? `?id=${existing.id}` : '');
    } catch (err) {
      // 1日1件ガード（409）は既存記録の編集へ誘導する
      const existingId = err?.detail?.existing_id;
      if (err?.status === 409 && existingId) {
        if (window.confirm(`${err.message}\n\n既存の記録を開きますか？`)) {
          draft.clear();
          guard.clear();
          go(`?edit=${existingId}`);
          return;
        }
      }
      notice.textContent = saveErrorMessage(err);
      notice.hidden = false;
      saveBtn.disabled = false;
    }
  });

  const restore = (data) => {
    if (data.report_date) dateIn.value = data.report_date;
    if (data.inspected_at) datetimeIn.value = data.inspected_at;
    if (data.reporter_name) reporterIn.value = data.reporter_name;
    if (data.note) noteIn.value = data.note;
  };

  render(app, [
    existing ? null : draft.banner(restore),
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, '基本情報'),
      el('label', { class: 'field' }, ['点検日', dateIn]),
      el('label', { class: 'field' }, ['点検日時', datetimeIn]),
      el('label', { class: 'field' }, ['入力者', reporterIn]),
    ]),
    ...sections,
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, '特記事項・備考'),
      el('label', { class: 'field' }, [noteIn]),
    ]),
    notice,
    el('div', { class: 'action-row' }, [
      saveBtn,
      el('button', { class: 'btn', onclick: () => { guard.clear(); go(existing ? `?id=${existing.id}` : ''); } }, 'キャンセル'),
    ]),
  ]);
}

// ---------------- 詳細 ----------------

async function renderDetail(id) {
  const { report, history } = await api.get(`/api/utility-reports/${id}`);

  // セクションごとにカード化し、02 点検の詳細と同じ result-row で値を並べる
  //（入力画面と同じく、同じセクション名は1枚にまとめる）
  const cards = [];
  const rowsBySection = new Map();
  for (const v of report.values || []) {
    const section = v.section || 'その他';
    let rows = rowsBySection.get(section);
    if (!rows) {
      rows = el('div', { class: 'row-list' }, []);
      rowsBySection.set(section, rows);
      cards.push(el('div', { class: 'card' }, [el('h2', { class: 'card-title' }, section), rows]));
    }
    rows.appendChild(el('div', { class: v.abnormal ? 'result-row is-abn' : 'result-row' }, [
      el('span', { class: 'result-name' }, v.name),
      el('span', { class: 'result-value' }, [
        displayValue(v),
        v.abnormal ? el('span', { class: 'abn-mark' }, ' ⚠') : null,
      ]),
    ]));
  }

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, report.report_date.replace(/-/g, '/')),
      report.has_abnormal ? el('p', { class: 'notice is-warning' }, '⚠ 基準範囲外・異常の項目があります。') : null,
      el('p', { class: 'hint' }, `点検日時: ${formatDateTime(report.inspected_at)}`),
      el('p', { class: 'hint' }, `入力者: ${report.reporter_name || maskEmail(report.created_by)}`),
    ]),
    ...cards,
    report.note ? el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, '特記事項・備考'),
      el('p', { class: 'note-box' }, report.note),
    ]) : null,
    hasRole(currentUser, 'editor') ? el('div', { class: 'action-row' }, [
      el('button', { class: 'btn btn-primary', onclick: () => go(`?edit=${report.id}`) }, '✏️ 編集'),
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          if (!window.confirm('この日報を削除しますか？（管理画面から復元できます）')) return;
          try { await api.del(`/api/utility-reports/${report.id}`); go(''); }
          catch (err) { showError(err); }
        },
      }, '🗑 削除'),
    ]) : null,
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, '変更履歴'),
      history.length === 0
        ? el('p', { class: 'empty' }, '履歴はありません。')
        : history.map((h) => el('div', { class: 'history-row' }, [
            `${formatDateTime(h.changed_at)}　${ACTION_LABELS[h.action] || h.action}　${maskEmail(h.changed_by)}`,
          ])),
    ]),
  ]);
}

// ---------------- 点検項目マスタ（管理者のみ） ----------------

async function renderItems() {
  if (!hasRole(currentUser, 'admin')) {
    render(app, el('p', { class: 'notice is-error' }, 'この画面は管理者のみ利用できます。'));
    return;
  }
  let items = (await api.get('/api/utility-reports/items')).items;

  const nameIn = el('input', { type: 'text', placeholder: '項目名' });
  const sectionIn = el('input', { type: 'text', placeholder: '表示グループ（例: 各種タンク）', list: 'utility-sections' });
  const typeSel = el('select', {}, [
    el('option', { value: 'number' }, '数値'),
    el('option', { value: 'select' }, '選択式（1つ）'),
    el('option', { value: 'multi' }, '複数選択'),
    el('option', { value: 'time' }, '時刻（HH:MM）'),
    el('option', { value: 'text' }, '自由記述'),
  ]);
  const unitIn = el('input', { type: 'text', placeholder: '単位（L・MPa 等）' });
  // 上下限も入力欄と同じ理由で type=text（スピナー誤爆・IMEで弾かれるのを避ける）
  const minIn = el('input', { type: 'text', inputmode: 'decimal', placeholder: '下限値' });
  const maxIn = el('input', { type: 'text', inputmode: 'decimal', placeholder: '上限値' });
  const optionsIn = el('input', { type: 'text', placeholder: '選択肢（カンマ区切り）' });
  const alertIn = el('input', { type: 'text', placeholder: '異常扱いの選択肢（カンマ区切り）' });
  const notice = el('p', { class: 'notice is-error', hidden: true }, '');

  const split = (s) => s.split(/[,、]/).map((v) => v.trim()).filter(Boolean);

  const addBtn = el('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      notice.hidden = true;
      try {
        await api.post('/api/utility-reports/items', {
          name: nameIn.value.trim(),
          section: sectionIn.value.trim(),
          input_type: typeSel.value,
          unit: unitIn.value.trim(),
          min_value: normalizeNumberText(minIn.value),
          max_value: normalizeNumberText(maxIn.value),
          options: split(optionsIn.value),
          alert_options: split(alertIn.value),
          // 並び順は ▲▼ で決めるため、追加はいちばん後ろに置く
          sort_order: (items.at(-1)?.sort_order ?? 0) + 1,
        });
        go('?items=1');
      } catch (err) {
        notice.textContent = err.message;
        notice.hidden = false;
      }
    },
  }, '＋ 項目を追加');

  // ---- 並び替え（▲▼）----
  // 表示グループ（セクション）ごとにまとめ、グループ内での項目の入れ替えと
  // グループ自体の入れ替えができるようにする。入力画面（renderForm）も同じ
  // まとめ方で描画するため、ここでの並び＝現場が見る並びになる。
  const listBox = el('div', { class: 'row-list' }, []);
  let saving = false;

  const groupBySection = (list) => {
    const groups = [];
    const byName = new Map();
    for (const it of list) {
      const name = it.section || 'その他';
      let group = byName.get(name);
      if (!group) { group = { name, items: [] }; byName.set(name, group); groups.push(group); }
      group.items.push(it);
    }
    return groups;
  };

  const swapped = (arr, index, delta) => {
    const next = [...arr];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    return next;
  };

  /** 並び替えた結果を保存する。先に画面へ反映し、失敗したら元へ戻す */
  const saveOrder = async (nextItems, movedId) => {
    if (saving) return;
    saving = true;
    const before = items;
    items = nextItems;
    renderList();
    try {
      const res = await api.put('/api/utility-reports/items/reorder', {
        order: nextItems.map((i) => i.id),
        moved_id: movedId,
      });
      if (Array.isArray(res.items)) items = res.items;
    } catch (err) {
      items = before;
      window.alert(`並び順を保存できませんでした。\n${err.message || err}`);
    } finally {
      saving = false;
      renderList();
    }
  };

  const moveBtn = (label, title, enabled, onclick) => el('button', {
    class: 'btn btn-sm',
    title,
    'aria-label': title,
    disabled: !enabled || saving,
    onclick,
  }, label);

  function renderList() {
    const groups = groupBySection(items);
    const flatten = (gs) => gs.flatMap((g) => g.items);

    render(listBox, groups.map((group, gi) => el('div', { class: 'card' }, [
      el('div', { class: 'list-item' }, [
        el('div', { class: 'list-item-main' }, [
          el('div', { class: 'list-item-title' }, group.name),
          el('div', { class: 'list-item-sub' }, `${group.items.length}項目`),
        ]),
        moveBtn('▲', 'このグループを上へ', gi > 0,
          () => saveOrder(flatten(swapped(groups, gi, -1)), group.items[0]?.id)),
        moveBtn('▼', 'このグループを下へ', gi < groups.length - 1,
          () => saveOrder(flatten(swapped(groups, gi, 1)), group.items[0]?.id)),
      ]),
      el('div', { class: 'row-list' }, group.items.map((it, ii) => el('div', { class: 'list-item' }, [
        el('div', { class: 'list-item-main' }, [
          el('div', { class: 'list-item-sub' }, `${ii + 1}／${group.items.length} ・ ${typeLabel(it.input_type)}`),
          el('div', { class: 'list-item-title' }, it.unit ? `${it.name}（${it.unit}）` : it.name),
          it.input_type === 'number' && (it.min_value !== null || it.max_value !== null)
            ? el('div', { class: 'list-item-sub' }, `基準: ${it.min_value ?? ''} 〜 ${it.max_value ?? ''}`)
            : null,
          Array.isArray(it.options) ? el('div', { class: 'list-item-sub' }, it.options.join('・')) : null,
        ]),
        moveBtn('▲', `${it.name} を上へ`, ii > 0, () => {
          const next = groups.map((g, i) => (i === gi ? { ...g, items: swapped(g.items, ii, -1) } : g));
          saveOrder(flatten(next), it.id);
        }),
        moveBtn('▼', `${it.name} を下へ`, ii < group.items.length - 1, () => {
          const next = groups.map((g, i) => (i === gi ? { ...g, items: swapped(g.items, ii, 1) } : g));
          saveOrder(flatten(next), it.id);
        }),
        el('button', {
          class: 'btn btn-sm btn-danger',
          disabled: saving,
          onclick: async () => {
            if (!window.confirm(`「${it.name}」を削除しますか？（管理画面のマスタ履歴から復元できます）`)) return;
            try { await api.del(`/api/utility-reports/items/${it.id}`); go('?items=1'); }
            catch (err) { showError(err); }
          },
        }, '🗑'),
      ]))),
    ])));
  }

  renderList();

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, '点検項目を追加'),
      el('datalist', { id: 'utility-sections' },
        [...new Set(items.map((i) => i.section).filter(Boolean))].map((s) => el('option', { value: s }))),
      sectionIn, nameIn, typeSel, unitIn,
      el('div', { class: 'filter-bar' }, [minIn, maxIn]),
      optionsIn, alertIn, notice, addBtn,
      el('p', { class: 'hint' }, '追加した項目はそのグループのいちばん下に入ります。順番は下の ▲▼ で変えられます。'),
    ]),
    el('p', { class: 'hint' }, '▲▼ で点検の順番を入れ替えます（押すたびに保存され、入力画面の並びに反映されます）。'),
    listBox,
  ]);
}

function typeLabel(t) {
  return { number: '数値', select: '選択式', multi: '複数選択', time: '時刻', text: '自由記述' }[t] || t;
}

// ---------------- エントリポイント ----------------

try {
  currentUser = await getCurrentUser();
  const params = new URLSearchParams(window.location.search);
  if (params.get('items')) {
    await renderItems();
  } else if (params.get('id')) {
    await renderDetail(Number(params.get('id')));
  } else if (params.get('edit')) {
    const { report } = await api.get(`/api/utility-reports/${Number(params.get('edit'))}`);
    await renderForm(report);
  } else if (params.get('new')) {
    await renderForm(null);
  } else {
    await renderList();
  }
} catch (err) {
  showError(err);
}
