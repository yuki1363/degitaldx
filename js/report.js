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
  const [{ categories }] = await Promise.all([
    api.get('/api/reports/categories'),
  ]);

  let filterCategory = '';
  let filterReporter = '';
  let filterFrom     = '';
  let filterTo       = '';
  let reporterTimer  = null;
  const listBox = el('div', { class: 'row-list' }, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const p = new URLSearchParams();
    if (filterCategory) p.set('category_id', filterCategory);
    if (filterReporter) p.set('reporter', filterReporter);
    if (filterFrom) p.set('from', filterFrom);
    if (filterTo)   p.set('to',   filterTo);
    const { reports } = await api.get(`/api/reports${p.size ? '?' + p : ''}`);
    if (reports.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '日報はありません。'));
      return;
    }
    render(listBox, reports.map((r) => {
      const body = r.body || '';
      const title = body ? body.slice(0, 60) + (body.length > 60 ? '…' : '') : '（本文なし）';
      return el('a', { class: 'list-item', href: `/pages/report?id=${r.id}` }, [
        el('div', { class: 'list-item-main' }, [
          el('div', { class: 'list-item-sub' }, [
            r.category_name ? el('span', { class: 'cat-badge' }, r.category_name) : null,
            ` ${r.report_date}  ${r.reporter_name || r.created_by}`,
          ]),
          el('div', { class: 'list-item-title' }, title),
        ]),
        el('span', { class: 'chevron' }, '›'),
      ]);
    }));
  };

  const catSel = el('select', { onchange: (e) => { filterCategory = e.target.value; load().catch(showError); } }, [
    el('option', { value: '' }, '全カテゴリ'),
    ...categories.map((c) => el('option', { value: c.id }, c.name)),
  ]);
  const reporterIn = el('input', {
    type: 'search',
    placeholder: '入力者で検索',
    oninput: (e) => {
      clearTimeout(reporterTimer);
      const v = e.target.value.trim();
      reporterTimer = setTimeout(() => { filterReporter = v; load().catch(showError); }, 300);
    },
  });
  const fromIn = el('input', { type: 'date', onchange: (e) => { filterFrom = e.target.value; load().catch(showError); } });
  const toIn   = el('input', { type: 'date', onchange: (e) => { filterTo   = e.target.value; load().catch(showError); } });

  render(app, [
    el('div', { class: 'filter-bar' }, [catSel, reporterIn]),
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
  // 日報は共有記録のため、入力可（editor）なら誰でも編集・削除できる（作成者/管理者の区別なし）
  const canEdit = hasRole(currentUser, 'editor');

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
      infoRow('入力者', report.reporter_name || report.created_by),
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
    canEdit
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
  const [{ categories }, { troubles }, { repairs }, { inspections }, usersRes] = await Promise.all([
    api.get('/api/reports/categories'),
    api.get(`/api/troubles?from=${todayStr()}&to=${todayStr()}`).catch(() => ({ troubles: [] })),
    api.get('/api/repairs?status=open').catch(() => ({ repairs: [] })),
    api.get(`/api/inspections?from=${todayStr()}&to=${todayStr()}`).catch(() => ({ inspections: [] })),
    api.get('/api/users').catch(() => ({ users: [] })),
  ]);
  const users = usersRes.users || [];

  // 既存のリンク済み記録を取得
  const existingLinks = (() => {
    if (!existing?.linked_records_json) return [];
    try { return JSON.parse(existing.linked_records_json) || []; }
    catch { return []; }
  })();

  const f = {
    date:     el('input', { type: 'date', value: existing?.report_date || todayStr() }),
    // 入力者は自由入力（新規は自分の名前を初期値。登録ユーザー名を候補表示）
    reporter: el('input', {
      type: 'text',
      value: existing ? (existing.reporter_name || '') : (currentUser.name || ''),
      placeholder: '入力者名（自由入力）',
      list: 'report-reporter-options',
    }),
    category: el('select', {},
      [el('option', { value: '' }, '— カテゴリを選択（任意）'),
      ...categories.map((c) => el('option', { value: c.id, selected: existing?.category_id === c.id }, c.name))]
    ),
    body: el('textarea', { placeholder: '今日の作業内容・申し送り事項・気づきを記録してください', style: 'min-height:140px' }, existing?.body || ''),
  };
  const reporterOptions = el('datalist', { id: 'report-reporter-options' },
    users.map((u) => el('option', { value: u.name || u.email }))
  );

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
  const inspectionChecks = inspections.map((i) => {
    const title = `${i.equipment_name || '設備未指定'}${i.has_abnormal ? '（異常あり）' : ''}`;
    const cb = el('input', { type: 'checkbox', checked: isLinked('inspection', i.id), 'data-type': 'inspection', 'data-id': i.id, 'data-title': title.slice(0, 40) });
    return el('label', { class: 'link-check-row' }, [cb, ` [点検] ${title.slice(0, 40)}`]);
  });

  const linkedSection = (troubleChecks.length + repairChecks.length + inspectionChecks.length > 0)
    ? el('div', { class: 'field' }, [
        el('label', {}, '関連する記録を紐づける（任意）'),
        el('div', { class: 'link-check-list' }, [...troubleChecks, ...inspectionChecks, ...repairChecks]),
      ])
    : null;

  const save = async () => {
    const report_date   = f.date.value;
    const bodyText      = f.body.value.trim();      // 本文は任意（空でも保存可）
    const reporter_name = f.reporter.value.trim() || null;
    const category_id   = f.category.value ? Number(f.category.value) : null;
    if (!report_date) { alert('日付は必須です。'); return; }

    // チェック済みの関連記録を収集
    const linked_records_json = [];
    const allChecks = [...troubleChecks, ...inspectionChecks, ...repairChecks].map((row) => row.querySelector('input[type=checkbox]'));
    for (const cb of allChecks) {
      if (cb.checked) {
        linked_records_json.push({ type: cb.dataset.type, id: Number(cb.dataset.id), title: cb.dataset.title });
      }
    }

    try {
      if (existing) {
        await api.put(`/api/reports/${existing.id}`, { report_date, body: bodyText, reporter_name, category_id, linked_records_json });
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/reports', { report_date, body: bodyText, reporter_name, category_id, linked_records_json });
        renderSaved(id);  // 保存後の確認画面（続けて入力できる）
      }
    } catch (err) { alert(err.message); }
  };

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '日報を編集' : '日報を書く'),
      field('日付（必須）', f.date),
      field('入力者', f.reporter),
      reporterOptions,
      field('カテゴリ', f.category),
      field('内容', f.body, '今日の作業・引き継ぎ・気づき等を記録してください（任意）。'),
      linkedSection,
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', { class: 'btn', onclick: () => (existing ? go(`?id=${existing.id}`) : go('')) }, 'キャンセル'),
      ]),
    ]),
  ]);
}

// 保存後の確認画面（続けて次の日報を入力できる）
function renderSaved(id) {
  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, '✓ 日報を保存しました'),
      el('p', { class: 'hint' }, '続けて入力できます。'),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => go('?new=1') }, '＋ 次の日報を作成する'),
        el('a', { class: 'btn', href: `/pages/report?id=${id}` }, 'この日報を見る'),
        el('a', { class: 'btn', href: '/pages/report' }, '一覧へ戻る'),
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
