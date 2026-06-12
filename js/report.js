// 07 日報 — 一覧・登録・編集・詳細
//   URL: /pages/report            … 一覧
//        /pages/report?new=1      … 新規登録
//        /pages/report?edit=N     … 編集
//        /pages/report?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime } from '/js/util.js';

const app = document.getElementById('app');
let currentUser = null;

function go(query) {
  window.location.href = `/pages/report${query}`;
}

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// 今日の日付を YYYY-MM-DD で返す
function todayStr() {
  return new Date().toLocaleDateString('sv-SE');
}

// ---------------- 一覧 ----------------

async function renderList() {
  const [{ categories }, { users }] = await Promise.all([
    api.get('/api/reports/categories'),
    api.get('/api/users'),
  ]);

  let filterCategory = '';
  let filterReporter = '';
  let filterFrom     = '';
  let filterTo       = '';
  const listBox = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const p = new URLSearchParams();
    if (filterCategory) p.set('category_id', filterCategory);
    if (filterReporter) p.set('reporter_id', filterReporter);
    if (filterFrom) p.set('from', filterFrom);
    if (filterTo)   p.set('to',   filterTo);
    const { reports } = await api.get(`/api/reports${p.size ? '?' + p : ''}`);
    if (reports.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '日報はありません。'));
      return;
    }
    render(listBox, reports.map((r) =>
      el('a', { class: 'list-item', href: `/pages/report?id=${r.id}` }, [
        el('div', { class: 'list-item-main' }, [
          el('div', { class: 'list-item-sub' }, [
            r.category_name ? el('span', { class: 'cat-badge' }, r.category_name) : null,
            ` ${r.report_date}  ${r.reporter_name || r.created_by}`,
          ]),
          el('div', { class: 'list-item-title' }, r.body.slice(0, 60) + (r.body.length > 60 ? '…' : '')),
        ]),
        el('span', { class: 'chevron' }, '›'),
      ])
    ));
  };

  const catSel = el('select', { onchange: (e) => { filterCategory = e.target.value; load().catch(showError); } }, [
    el('option', { value: '' }, '全カテゴリ'),
    ...categories.map((c) => el('option', { value: c.id }, c.name)),
  ]);
  const userSel = el('select', { onchange: (e) => { filterReporter = e.target.value; load().catch(showError); } }, [
    el('option', { value: '' }, '全記録者'),
    ...users.map((u) => el('option', { value: u.id }, u.name || u.email)),
  ]);
  const fromIn = el('input', { type: 'date', onchange: (e) => { filterFrom = e.target.value; load().catch(showError); } });
  const toIn   = el('input', { type: 'date', onchange: (e) => { filterTo   = e.target.value; load().catch(showError); } });

  render(app, [
    el('div', { class: 'filter-bar' }, [catSel, userSel]),
    el('div', { class: 'filter-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromIn]),
      el('label', { class: 'filter-label' }, ['TO ', toIn]),
    ]),
    hasRole(currentUser, 'editor')
      ? el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
          el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 日報を書く'),
        ])
      : null,
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

const LINKED_TYPE_LABELS = { trouble: 'トラブル', inspection: '点検', repair: '業務依頼' };
const LINKED_TYPE_URLS   = { trouble: '/pages/trouble?id=', inspection: '/pages/inspection?id=', repair: '/pages/repair?id=' };

async function renderDetail(id) {
  const { report } = await api.get(`/api/reports/${id}`);
  const canEdit = hasRole(currentUser, 'admin') || report.created_by === currentUser.email;

  const linkedItems = (() => {
    try { return JSON.parse(report.linked_records_json) || []; }
    catch { return []; }
  })();

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, report.report_date),
        report.category_name ? el('span', { class: 'cat-badge' }, report.category_name) : null,
      ]),
      infoRow('記録者', report.reporter_name || report.created_by),
      infoRow('記録日時', formatDateTime(report.created_at)),
      el('div', { class: 'note-box', style: 'white-space:pre-wrap' }, report.body),
    ]),
    linkedItems.length > 0
      ? el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, '関連記録'),
          el('div', { class: 'row-list' },
            linkedItems.map((lnk) =>
              el('a', {
                class: 'list-item',
                href: `${LINKED_TYPE_URLS[lnk.type] || '#'}${lnk.id}`,
              }, [
                el('span', { class: 'action-badge is-update' }, LINKED_TYPE_LABELS[lnk.type] || lnk.type),
                el('span', {}, lnk.title || `#${lnk.id}`),
              ])
            )
          ),
        ])
      : null,
    hasRole(currentUser, 'editor') && canEdit
      ? el('div', { class: 'action-row' }, [
          el('button', { class: 'btn', onclick: () => go(`?edit=${id}`) }, '編集'),
          el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              if (!confirm('この日報を削除しますか？')) return;
              await api.del(`/api/reports/${id}`);
              go('');
            },
          }, '削除'),
        ])
      : null,
  ]);
}

// ---------------- 登録・編集フォーム ----------------

function field(label, input, hint) {
  return el('div', { class: 'field' }, [
    el('label', {}, label),
    input,
    hint ? el('p', { class: 'hint' }, hint) : null,
  ]);
}

async function renderForm(existing) {
  const [{ categories }, { troubles }, { repairs }] = await Promise.all([
    api.get('/api/reports/categories'),
    api.get(`/api/troubles?from=${todayStr()}&to=${todayStr()}`).catch(() => ({ troubles: [] })),
    api.get('/api/repairs?status=open').catch(() => ({ repairs: [] })),
  ]);

  // 既存のリンク済み記録を取得
  const existingLinks = (() => {
    if (!existing?.linked_records_json) return [];
    try { return JSON.parse(existing.linked_records_json) || []; }
    catch { return []; }
  })();

  const f = {
    date:     el('input', { type: 'date', value: existing?.report_date || todayStr() }),
    category: el('select', {},
      [el('option', { value: '' }, '— カテゴリを選択（任意）'),
      ...categories.map((c) => el('option', { value: c.id, selected: existing?.category_id === c.id }, c.name))]
    ),
    body: el('textarea', { placeholder: '今日の作業内容・申し送り事項・気づきを記録してください', style: 'min-height:140px' }, existing?.body || ''),
  };

  // 関連記録チェックボックス
  const isLinked = (type, id) => existingLinks.some((l) => l.type === type && l.id === id);

  const troubleChecks = troubles.map((t) => {
    const cb = el('input', { type: 'checkbox', checked: isLinked('trouble', t.id), 'data-type': 'trouble', 'data-id': t.id, 'data-title': t.phenomenon.slice(0, 40) });
    return el('label', { class: 'link-check-row' }, [cb, ` [トラブル] ${t.phenomenon.slice(0, 40)}`]);
  });
  const repairChecks = repairs.map((r) => {
    const cb = el('input', { type: 'checkbox', checked: isLinked('repair', r.id), 'data-type': 'repair', 'data-id': r.id, 'data-title': r.title.slice(0, 40) });
    return el('label', { class: 'link-check-row' }, [cb, ` [業務依頼] ${r.title.slice(0, 40)}`]);
  });

  const linkedSection = (troubleChecks.length + repairChecks.length > 0)
    ? el('div', { class: 'field' }, [
        el('label', {}, '関連する記録を紐づける（任意）'),
        el('div', { class: 'link-check-list' }, [...troubleChecks, ...repairChecks]),
      ])
    : null;

  const save = async () => {
    const report_date = f.date.value;
    const bodyText    = f.body.value.trim();
    const category_id = f.category.value ? Number(f.category.value) : null;
    if (!report_date) { alert('日付は必須です。'); return; }
    if (!bodyText)    { alert('本文は必須です。'); return; }

    // チェック済みの関連記録を収集
    const linked_records_json = [];
    const allChecks = [...troubleChecks, ...repairChecks].map((row) => row.querySelector('input[type=checkbox]'));
    for (const cb of allChecks) {
      if (cb.checked) {
        linked_records_json.push({ type: cb.dataset.type, id: Number(cb.dataset.id), title: cb.dataset.title });
      }
    }

    try {
      if (existing) {
        await api.put(`/api/reports/${existing.id}`, { report_date, body: bodyText, category_id, linked_records_json });
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/reports', { report_date, body: bodyText, category_id, linked_records_json });
        go(`?id=${id}`);
      }
    } catch (err) { alert(err.message); }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '日報を編集' : '日報を書く'),
      field('日付（必須）', f.date),
      field('カテゴリ', f.category),
      field('内容（必須）', f.body, '今日の作業・引き継ぎ・気づき等を記録してください。'),
      linkedSection,
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
      const { report } = await api.get(`/api/reports/${Number(params.get('edit'))}`);
      await renderForm(report);
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
