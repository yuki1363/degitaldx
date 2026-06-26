// 07 日報 — 一覧・登録・編集・詳細
//   URL: /pages/report            … 一覧
//        /pages/report?new=1      … 新規登録
//        /pages/report?edit=N     … 編集
//        /pages/report?id=N       … 詳細

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';

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
  let filterFrom     = todayStr();
  let filterTo       = todayStr();
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
            ` ${r.report_date}  ${r.reporter_name || maskEmail(r.created_by)}`,
          ]),
          el('div', { class: 'list-item-title' }, title),
        ]),
        el('span', { class: 'chevron' }, '›'),
      ]);
    }));
  };

  // 「＋ 日報を書く」は選択中のカテゴリを引き継ぐ（該当カテゴリで日報を作成できる）
  const writeBtn = hasRole(currentUser, 'editor')
    ? el('button', {
        class: 'btn btn-primary',
        onclick: () => {
          const q = new URLSearchParams({ new: '1' });
          if (filterCategory) q.set('category', filterCategory);
          go(`?${q}`);
        },
      }, '＋ 日報を書く')
    : null;

  const updateWriteLabel = () => {
    if (!writeBtn) return;
    const cat = categories.find((c) => String(c.id) === String(filterCategory));
    writeBtn.textContent = cat ? `＋ 「${cat.name}」で日報を書く` : '＋ 日報を書く';
  };

  const catSel = el('select', {
    onchange: (e) => { filterCategory = e.target.value; updateWriteLabel(); },
  }, [
    el('option', { value: '' }, '全カテゴリ'),
    ...categories.map((c) => el('option', { value: c.id }, c.name)),
  ]);
  const reporterIn = el('input', {
    type: 'search',
    placeholder: '入力者で検索',
    oninput: (e) => { filterReporter = e.target.value.trim(); },
  });
  const fromIn = el('input', { type: 'date', value: filterFrom, onchange: (e) => { filterFrom = e.target.value; } });
  const toIn   = el('input', { type: 'date', value: filterTo,   onchange: (e) => { filterTo   = e.target.value; } });
  const searchBtn = el('button', { class: 'btn btn-primary', onclick: () => load().catch(showError) }, '🔍 検索');

  render(app, [
    el('div', { class: 'filter-bar' }, [catSel, reporterIn]),
    el('div', { class: 'filter-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromIn]),
      el('label', { class: 'filter-label' }, ['TO ', toIn]),
      searchBtn,
    ]),
    (writeBtn || hasRole(currentUser, 'admin'))
      ? el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
          writeBtn,
          hasRole(currentUser, 'admin')
            ? el('a', { class: 'btn', href: '/pages/admin?tab=manage' }, '⚙ カテゴリを管理')
            : null,
        ])
      : null,
    listBox,
  ]);
  updateWriteLabel();
  render(listBox, el('p', { class: 'empty' }, '🔍 条件を選んで「検索」を押してください。'));
}

// ---------------- 詳細 ----------------

function infoRow(label, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'info-label' }, label),
    el('span', { class: 'info-value' }, value || '—'),
  ]);
}

async function renderDetail(id) {
  const { report } = await api.get(`/api/reports/${id}`);
  // 日報は共有記録のため、入力可（editor）なら誰でも編集・削除できる（作成者/管理者の区別なし）
  const canEdit = hasRole(currentUser, 'editor');

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title-row' }, [
        el('h2', { class: 'card-title' }, report.report_date),
        report.category_name ? el('span', { class: 'cat-badge' }, report.category_name) : null,
      ]),
      infoRow('入力者', report.reporter_name || maskEmail(report.created_by)),
      infoRow('記録日時', formatDateTime(report.created_at)),
      el('div', { class: 'note-box', style: 'white-space:pre-wrap' }, report.body),
    ]),
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
  // 点検・トラブル詳細からのプリフィル（本文・日付・カテゴリ。記録の紐づけは行わない）
  const urlParams   = new URLSearchParams(window.location.search);
  const prefillDate = urlParams.get('date');
  const prefillCategory = urlParams.get('category'); // 一覧で選んだカテゴリで新規作成
  const prefillBody = urlParams.get('body');         // トラブル等から本文（現象・原因・対策）をプリフィル

  const initDate = existing?.report_date || prefillDate || todayStr();

  const [{ categories }, usersRes] = await Promise.all([
    api.get('/api/reports/categories'),
    api.get('/api/users').catch(() => ({ users: [] })),
  ]);
  const users = usersRes.users || [];

  const f = {
    date: el('input', { type: 'date', value: initDate }),
    reporter: el('input', {
      type: 'text',
      value: existing ? (existing.reporter_name || '') : '',
      placeholder: '入力者名（自由入力）',
      list: 'report-reporter-options',
    }),
    category: el('select', {},
      [el('option', { value: '' }, '— カテゴリを選択（任意）'),
      ...categories.map((c) => {
        const selected = existing
          ? existing.category_id === c.id
          : (prefillCategory != null && String(prefillCategory) === String(c.id));
        return el('option', { value: c.id, selected }, c.name);
      })]
    ),
    body: el('textarea', {
      placeholder: '今日の作業内容・申し送り事項・気づきを記録してください',
      style: 'min-height:140px',
    }, existing?.body || prefillBody || ''),
  };

  const reporterOptions = el('datalist', { id: 'report-reporter-options' },
    users.map((u) => el('option', { value: u.name || u.email }))
  );

  const save = async () => {
    const report_date   = f.date.value;
    const bodyText      = f.body.value.trim();
    const reporter_name = f.reporter.value.trim() || null;
    const category_id   = f.category.value ? Number(f.category.value) : null;
    if (!report_date) { alert('日付は必須です。'); return; }

    try {
      if (existing) {
        await api.put(`/api/reports/${existing.id}`, { report_date, body: bodyText, reporter_name, category_id });
        go(`?id=${existing.id}`);
      } else {
        const { id } = await api.post('/api/reports', { report_date, body: bodyText, reporter_name, category_id });
        renderSaved(id);
      }
    } catch (err) { alert(err.message); }
  };

  // カテゴリが未登録のときは入力欄の下に案内を出す（管理者は管理画面へのリンク付き）
  const categoryField = el('div', { class: 'field' }, [
    el('label', {}, 'カテゴリ'),
    f.category,
    categories.length === 0
      ? el('p', { class: 'hint' },
          hasRole(currentUser, 'admin')
            ? ['カテゴリがまだありません。', el('a', { href: '/pages/admin?tab=manage' }, '管理画面（マスタ管理）'), 'から追加できます。']
            : 'カテゴリがまだありません。管理者が管理画面から追加できます。')
      : null,
  ]);

  render(app, [
    el('div', { class: 'card' }, [
      el('h2', { class: 'card-title' }, existing ? '日報を編集' : '日報を書く'),
      field('日付（必須）', f.date),
      field('入力者', f.reporter),
      reporterOptions,
      categoryField,
      field('内容', f.body, '今日の作業・引き継ぎ・気づき等を記録してください（任意）。'),
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
