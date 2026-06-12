// 09 管理機能 — ユーザー管理・監査ログ・削除済み復元・マスタ変更履歴
//   管理者（admin）のみアクセス可能

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime } from '/js/util.js';

const app = document.getElementById('app');
let currentUser = null;

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- タブ共通 ----------------

const TABS = [
  { id: 'users',   label: 'ユーザー管理' },
  { id: 'audit',   label: '監査ログ' },
  { id: 'restore', label: '削除済みデータ' },
  { id: 'masters', label: 'マスタ変更履歴' },
];

let activeTab = 'users';
let tabContent = null;

function setTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.tab === tabId)
  );
  loadTab().catch((err) => render(tabContent, el('p', { class: 'notice is-error' }, err.message)));
}

async function loadTab() {
  render(tabContent, el('p', { class: 'loading' }, '読み込み中…'));
  if (activeTab === 'users')   await renderUsers();
  if (activeTab === 'audit')   await renderAudit();
  if (activeTab === 'restore') await renderRestore();
  if (activeTab === 'masters') await renderMasters();
}

// ---------------- ユーザー管理 ----------------

const ROLE_LABELS = { viewer: '閲覧のみ', editor: '入力可', admin: '管理者' };

async function renderUsers() {
  const { users } = await api.get('/api/admin/users');
  let formVisible = false;
  const formBox = el('div', {}, []);

  const showForm = (existing) => {
    formVisible = true;
    const f = {
      email:      el('input', { type: 'email', value: existing?.email || '', disabled: !!existing, placeholder: 'user@example.com' }),
      name:       el('input', { type: 'text',  value: existing?.name  || '', placeholder: '山田 太郎' }),
      group_name: el('input', { type: 'text',  value: existing?.group_name || '', placeholder: '保全G' }),
      role:       el('select', {}, [
        el('option', { value: 'viewer', selected: (existing?.role || 'viewer') === 'viewer' }, '閲覧のみ'),
        el('option', { value: 'editor', selected: existing?.role === 'editor' }, '入力可'),
        el('option', { value: 'admin',  selected: existing?.role === 'admin'  }, '管理者'),
      ]),
    };
    const save = async () => {
      try {
        const body = { email: f.email.value.trim(), name: f.name.value.trim(), group_name: f.group_name.value.trim() || null, role: f.role.value };
        if (existing) {
          await api.put(`/api/admin/users/${existing.id}`, body);
        } else {
          await api.post('/api/admin/users', body);
        }
        await renderUsers();
      } catch (err) { alert(err.message); }
    };
    render(formBox, el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, existing ? 'ユーザーを編集' : 'ユーザーを追加'),
      el('div', { class: 'field' }, [el('label', {}, 'メールアドレス'), f.email]),
      el('div', { class: 'field' }, [el('label', {}, '氏名'), f.name]),
      el('div', { class: 'field' }, [el('label', {}, 'グループ'), f.group_name]),
      el('div', { class: 'field' }, [el('label', {}, '権限'), f.role]),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn btn-primary', onclick: save }, '保存'),
        el('button', { class: 'btn', onclick: () => render(formBox, []) }, 'キャンセル'),
      ]),
    ]));
    formBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const active  = users.filter((u) => !u.deleted_at);
  const deleted = users.filter((u) => u.deleted_at);

  render(tabContent, [
    el('div', { class: 'action-row', style: 'margin-bottom:12px' }, [
      el('button', { class: 'btn btn-primary', onclick: () => showForm(null) }, '＋ ユーザーを追加'),
    ]),
    formBox,
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, `登録ユーザー（${active.length}名）`),
      active.length === 0
        ? el('p', { class: 'empty' }, 'ユーザーがいません')
        : el('div', { style: 'overflow-x:auto' }, [
            el('table', { class: 'extract-table' }, [
              el('thead', {}, [el('tr', {}, ['メール', '氏名', 'グループ', '権限', '操作'].map((h) => el('th', {}, h)))]),
              el('tbody', {}, active.map((u) =>
                el('tr', {}, [
                  el('td', {}, u.email),
                  el('td', {}, u.name),
                  el('td', {}, u.group_name || '—'),
                  el('td', {}, ROLE_LABELS[u.role] || u.role),
                  el('td', {}, [
                    el('button', { class: 'btn btn-sm', onclick: () => showForm(u) }, '編集'),
                    ' ',
                    u.email !== currentUser.email
                      ? el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
                          if (!confirm(`${u.name} を無効化しますか？`)) return;
                          await api.del(`/api/admin/users/${u.id}`);
                          await renderUsers();
                        }}, '無効化')
                      : null,
                  ]),
                ])
              )),
            ]),
          ]),
    ]),
    deleted.length > 0
      ? el('div', { class: 'card' }, [
          el('h3', { class: 'card-title' }, `無効化済みユーザー（${deleted.length}名）`),
          el('div', { style: 'overflow-x:auto' }, [
            el('table', { class: 'extract-table' }, [
              el('thead', {}, [el('tr', {}, ['メール', '氏名', '操作'].map((h) => el('th', {}, h)))]),
              el('tbody', {}, deleted.map((u) =>
                el('tr', { style: 'opacity:0.6' }, [
                  el('td', {}, u.email),
                  el('td', {}, u.name),
                  el('td', {}, [
                    el('button', { class: 'btn btn-sm', onclick: async () => {
                      await api.put(`/api/admin/users/${u.id}`, { name: u.name, group_name: u.group_name, role: u.role });
                      await renderUsers();
                    }}, '再有効化'),
                  ]),
                ])
              )),
            ]),
          ]),
        ])
      : null,
  ]);
}

// ---------------- 監査ログ ----------------

const TABLE_OPTIONS = [
  'trouble_record', 'repair_request', 'parts_inventory', 'inspection_result',
  'daily_report', 'maintenance_plan', 'equipment_ledger', 'users', 'comments', 'chat_messages',
  'trouble_category', 'report_category', 'inspection_master',
];
const ACTION_LABELS = { create: '追加', update: '更新', delete: '削除', restore: '復元' };

async function renderAudit() {
  let filterTable  = '';
  let filterAction = '';
  let filterFrom   = '';
  let filterTo     = '';
  let offset       = 0;
  const PAGE_SIZE  = 50;
  const listBox    = el('div', {}, []);

  const load = async () => {
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const p = new URLSearchParams({ limit: PAGE_SIZE, offset });
    if (filterTable)  p.set('table', filterTable);
    if (filterAction) p.set('action', filterAction);
    if (filterFrom)   p.set('from', filterFrom);
    if (filterTo)     p.set('to', filterTo);
    const { logs, total } = await api.get(`/api/admin/audit?${p}`);

    if (logs.length === 0 && offset === 0) {
      render(listBox, el('p', { class: 'empty' }, '該当するログはありません'));
      return;
    }
    render(listBox, [
      el('p', { style: 'font-size:12px;color:#64748b' }, `${total}件中 ${offset + 1}〜${offset + logs.length}件`),
      el('div', { style: 'overflow-x:auto' }, [
        el('table', { class: 'extract-table' }, [
          el('thead', {}, [el('tr', {}, ['日時', 'テーブル', 'ID', '操作', '操作者', '内容'].map((h) => el('th', {}, h)))]),
          el('tbody', {}, logs.map((log) =>
            el('tr', {}, [
              el('td', {}, log.changed_at?.slice(0, 16).replace('T', ' ')),
              el('td', {}, log.table_name),
              el('td', {}, String(log.record_id)),
              el('td', {}, el('span', {
                class: `action-badge ${log.action === 'create' ? 'is-create' : log.action === 'delete' ? 'is-delete' : 'is-update'}`,
              }, ACTION_LABELS[log.action] || log.action)),
              el('td', {}, log.changed_by),
              el('td', { style: 'font-size:11px;max-width:200px;word-break:break-all' },
                log.diff_json ? log.diff_json.slice(0, 120) + (log.diff_json.length > 120 ? '…' : '') : '—'
              ),
            ])
          )),
        ]),
      ]),
      el('div', { class: 'action-row', style: 'margin-top:8px' }, [
        offset > 0 ? el('button', { class: 'btn btn-sm', onclick: () => { offset -= PAGE_SIZE; load().catch(() => {}); }}, '← 前') : null,
        offset + logs.length < total ? el('button', { class: 'btn btn-sm', onclick: () => { offset += PAGE_SIZE; load().catch(() => {}); }}, '次 →') : null,
      ]),
    ]);
  };

  const tableSel  = el('select', { onchange: (e) => { filterTable = e.target.value; offset = 0; load().catch(() => {}); }}, [
    el('option', { value: '' }, '全テーブル'),
    ...TABLE_OPTIONS.map((t) => el('option', { value: t }, t)),
  ]);
  const actionSel = el('select', { onchange: (e) => { filterAction = e.target.value; offset = 0; load().catch(() => {}); }}, [
    el('option', { value: '' }, '全操作'),
    ...Object.entries(ACTION_LABELS).map(([v, l]) => el('option', { value: v }, l)),
  ]);
  const fromIn = el('input', { type: 'date', onchange: (e) => { filterFrom = e.target.value; offset = 0; load().catch(() => {}); }});
  const toIn   = el('input', { type: 'date', onchange: (e) => { filterTo   = e.target.value; offset = 0; load().catch(() => {}); }});

  render(tabContent, [
    el('div', { class: 'filter-bar' }, [tableSel, actionSel]),
    el('div', { class: 'filter-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromIn]),
      el('label', { class: 'filter-label' }, ['TO ', toIn]),
    ]),
    listBox,
  ]);
  await load();
}

// ---------------- 削除済みデータ復元 ----------------

const TABLE_LABELS = {
  trouble_record: 'トラブル記録', repair_request: '業務依頼', parts_inventory: '部品在庫',
  inspection_result: '点検結果', daily_report: '日報', maintenance_plan: '保全計画', equipment_ledger: '設備台帳',
};

async function renderRestore() {
  let selectedTable = '';
  const listBox = el('div', {}, []);

  const load = async () => {
    if (!selectedTable) { render(listBox, []); return; }
    render(listBox, el('p', { class: 'loading' }, '読み込み中…'));
    const { records } = await api.get(`/api/admin/restore?table=${selectedTable}`);
    if (!records || records.length === 0) {
      render(listBox, el('p', { class: 'empty' }, '削除済みデータはありません'));
      return;
    }
    render(listBox, el('div', { style: 'overflow-x:auto' }, [
      el('table', { class: 'extract-table' }, [
        el('thead', {}, [el('tr', {}, ['内容', '日付', '削除者', '削除日時', '操作'].map((h) => el('th', {}, h)))]),
        el('tbody', {}, records.map((r) =>
          el('tr', { style: 'opacity:0.7' }, [
            el('td', {}, String(r.display || '').slice(0, 40)),
            el('td', {}, r.date_val?.slice(0, 10) || '—'),
            el('td', {}, r.deleted_by || '—'),
            el('td', {}, r.deleted_at?.slice(0, 16).replace('T', ' ') || '—'),
            el('td', {}, el('button', {
              class: 'btn btn-sm',
              onclick: async () => {
                if (!confirm('このデータを復元しますか？')) return;
                await api.post('/api/admin/restore', { table: selectedTable, id: r.id });
                await load();
              },
            }, '復元')),
          ])
        )),
      ]),
    ]));
  };

  const tableSel = el('select', { onchange: (e) => { selectedTable = e.target.value; load().catch(() => {}); }}, [
    el('option', { value: '' }, '— テーブルを選択'),
    ...Object.entries(TABLE_LABELS).map(([v, l]) => el('option', { value: v }, l)),
  ]);

  render(tabContent, [
    el('div', { class: 'filter-bar' }, [el('label', { class: 'filter-label' }, ['対象 ', tableSel])]),
    el('p', { class: 'hint' }, '削除したデータを元に戻せます。復元後は通常の画面から確認してください。'),
    listBox,
  ]);
}

// ---------------- マスタ変更履歴 ----------------

const MASTER_LABELS = {
  inspection_master: '点検項目マスタ', trouble_category: 'トラブルジャンル',
  report_category: '日報カテゴリ',
};

async function renderMasters() {
  let selectedMaster = '';
  const listBox = el('div', {}, []);

  const load = async () => {
    const p = new URLSearchParams();
    if (selectedMaster) p.set('master_name', selectedMaster);
    const { history, master_names } = await api.get(`/api/admin/masters?${p}`);

    if (history.length === 0) {
      render(listBox, el('p', { class: 'empty' }, 'マスタ変更履歴はありません'));
      return;
    }
    render(listBox, el('div', { style: 'overflow-x:auto' }, [
      el('table', { class: 'extract-table' }, [
        el('thead', {}, [el('tr', {}, ['マスタ', 'レコードID', '変更者', '変更日時', '変更前スナップショット'].map((h) => el('th', {}, h)))]),
        el('tbody', {}, history.map((h) =>
          el('tr', {}, [
            el('td', {}, MASTER_LABELS[h.master_name] || h.master_name),
            el('td', {}, h.record_id != null ? String(h.record_id) : '—'),
            el('td', {}, h.changed_by),
            el('td', {}, h.changed_at?.slice(0, 16).replace('T', ' ') || '—'),
            el('td', { style: 'font-size:11px;max-width:200px;word-break:break-all' },
              String(h.snapshot_json || '').slice(0, 120)
            ),
          ])
        )),
      ]),
    ]));
  };

  const { master_names } = await api.get('/api/admin/masters?limit=1').catch(() => ({ master_names: [] }));

  const masterSel = el('select', { onchange: (e) => { selectedMaster = e.target.value; load().catch(() => {}); }}, [
    el('option', { value: '' }, '全マスタ'),
    ...(master_names || []).map((m) => el('option', { value: m }, MASTER_LABELS[m] || m)),
  ]);

  render(tabContent, [
    el('div', { class: 'filter-bar' }, [el('label', { class: 'filter-label' }, ['対象 ', masterSel])]),
    el('p', { class: 'hint' }, 'マスタ変更前のスナップショットを確認できます（復元は管理者に相談してください）。'),
    listBox,
  ]);
  await load();
}

// ---------------- 起動 ----------------

(async () => {
  try {
    currentUser = await getCurrentUser();
    if (!hasRole(currentUser, 'admin')) {
      render(app, el('p', { class: 'notice is-error' }, 'この画面は管理者のみ閲覧できます。'));
      return;
    }

    tabContent = el('div', { id: 'tab-content' }, []);

    render(app, [
      el('div', { class: 'tab-bar' },
        TABS.map(({ id, label }) =>
          el('button', {
            class: `tab-btn ${id === activeTab ? 'is-active' : ''}`,
            dataset: { tab: id },
            onclick: () => setTab(id),
          }, label)
        )
      ),
      tabContent,
    ]);

    await loadTab();
  } catch (err) {
    showError(err);
  }
})();
