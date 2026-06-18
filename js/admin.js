// 09 管理機能 — ユーザー管理・監査ログ・削除済み復元・マスタ変更履歴
//   管理者（admin）のみアクセス可能

import { api } from '/js/api.js';
import { getCurrentUser, hasRole } from '/js/auth.js';
import { el, render, formatDateTime, maskEmail } from '/js/util.js';

const app = document.getElementById('app');
let currentUser = null;

function showError(err) {
  render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
}

// ---------------- タブ共通 ----------------

const TABS = [
  { id: 'users',   label: 'ユーザー管理' },
  { id: 'manage',  label: 'マスタ管理' },
  { id: 'audit',   label: '監査ログ' },
  { id: 'restore', label: '削除済みデータ' },
  { id: 'masters', label: 'マスタ変更履歴' },
  { id: 'backup',  label: 'バックアップ' },
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
  if (activeTab === 'manage')  await renderManage();
  if (activeTab === 'audit')   await renderAudit();
  if (activeTab === 'restore') await renderRestore();
  if (activeTab === 'masters') await renderMasters();
  if (activeTab === 'backup')  await renderBackup();
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
                  el('td', {}, maskEmail(u.email)),
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
                  el('td', {}, maskEmail(u.email)),
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

// ---------------- マスタ管理（カテゴリ・カスタム項目） ----------------

// 並び順を表示順どおり 1..N に振り直し、変わった行だけ PUT する
async function persistOrder(items, putUrl, buildBody) {
  for (let i = 0; i < items.length; i++) {
    const wanted = i + 1;
    if (items[i].sort_order !== wanted) {
      await api.put(putUrl(items[i]), buildBody(items[i], wanted));
    }
  }
}

// トラブルジャンル・日報カテゴリ共通のセクション（{id, name, sort_order} 形）
function categorySection(title, base, hint) {
  const wrap = el('div', { class: 'card' }, []);

  const reload = async () => {
    const { categories } = await api.get(base);
    const addInput = el('input', { type: 'text', placeholder: '新しい名称' });

    const move = async (idx, delta) => {
      const items = [...categories];
      [items[idx], items[idx + delta]] = [items[idx + delta], items[idx]];
      try {
        await persistOrder(items, (c) => `${base}/${c.id}`, (c, order) => ({ name: c.name, sort_order: order }));
        await reload();
      } catch (err) { alert(err.message); }
    };

    render(wrap, [
      el('h3', { class: 'card-title' }, title),
      hint ? el('p', { class: 'hint' }, hint) : null,
      categories.length === 0
        ? el('p', { class: 'empty' }, '登録がありません')
        : el('div', {}, categories.map((c, idx) =>
            el('div', { class: 'master-row' }, [
              el('span', { class: 'master-name' }, c.name),
              el('span', { class: 'master-actions' }, [
                el('button', { class: 'btn-icon', disabled: idx === 0, onclick: () => move(idx, -1) }, '↑'),
                el('button', { class: 'btn-icon', disabled: idx === categories.length - 1, onclick: () => move(idx, +1) }, '↓'),
                el('button', { class: 'btn btn-sm', onclick: async () => {
                  const name = prompt('新しい名称', c.name);
                  if (!name?.trim() || name.trim() === c.name) return;
                  try {
                    await api.put(`${base}/${c.id}`, { name: name.trim(), sort_order: c.sort_order });
                    await reload();
                  } catch (err) { alert(err.message); }
                }}, '名称変更'),
                el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
                  if (!confirm(`「${c.name}」を削除しますか？`)) return;
                  try {
                    await api.del(`${base}/${c.id}`);
                    await reload();
                  } catch (err) { alert(err.message); }
                }}, '削除'),
              ]),
            ])
          )),
      el('div', { class: 'add-row' }, [
        addInput,
        el('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          const name = addInput.value.trim();
          if (!name) return;
          try {
            await api.post(base, { name, sort_order: categories.length + 1 });
            await reload();
          } catch (err) { alert(err.message); }
        }}, '＋ 追加'),
      ]),
    ]);
  };

  reload().catch((err) => render(wrap, el('p', { class: 'notice is-error' }, err.message)));
  return wrap;
}

// トラブル記録のカスタム項目セクション
function customFieldSection() {
  const FIELD_TYPE_LABELS = { text: '自由記述', number: '数値', select: '選択式' };
  const wrap = el('div', { class: 'card' }, []);

  const reload = async () => {
    const { fields } = await api.get('/api/troubles/fields');

    const addName = el('input', { type: 'text', placeholder: '項目名（例: 停止時間）' });
    const addType = el('select', {}, Object.entries(FIELD_TYPE_LABELS).map(([v, l]) => el('option', { value: v }, l)));
    const addOptions = el('input', { type: 'text', placeholder: '選択肢（カンマ区切り・選択式のみ）' });

    const move = async (idx, delta) => {
      const items = [...fields];
      [items[idx], items[idx + delta]] = [items[idx + delta], items[idx]];
      try {
        await persistOrder(items, (f) => `/api/troubles/fields/${f.id}`, (f, order) => ({
          name: f.name,
          input_type: f.input_type,
          options: f.options_json ? JSON.parse(f.options_json) : [],
          sort_order: order,
        }));
        await reload();
      } catch (err) { alert(err.message); }
    };

    render(wrap, [
      el('h3', { class: 'card-title' }, 'トラブル記録のカスタム項目'),
      el('p', { class: 'hint' }, 'トラブル入力フォームに追加される項目です。項目を変更・削除しても過去の記録は当時の内容で残ります。'),
      fields.length === 0
        ? el('p', { class: 'empty' }, 'カスタム項目はありません')
        : el('div', {}, fields.map((fld, idx) => {
            let optsText = '';
            try { optsText = (JSON.parse(fld.options_json) || []).join('、'); } catch { /* なし */ }
            return el('div', { class: 'master-row' }, [
              el('span', { class: 'master-name' }, [
                fld.name,
                el('span', { class: 'master-sub' }, ` ［${FIELD_TYPE_LABELS[fld.input_type] || fld.input_type}${optsText ? ': ' + optsText : ''}］`),
              ]),
              el('span', { class: 'master-actions' }, [
                el('button', { class: 'btn-icon', disabled: idx === 0, onclick: () => move(idx, -1) }, '↑'),
                el('button', { class: 'btn-icon', disabled: idx === fields.length - 1, onclick: () => move(idx, +1) }, '↓'),
                el('button', { class: 'btn btn-sm', onclick: async () => {
                  const name = prompt('項目名', fld.name);
                  if (!name?.trim()) return;
                  let options = [];
                  if (fld.input_type === 'select') {
                    const optsIn = prompt('選択肢（カンマ区切り）', optsText.replaceAll('、', ','));
                    if (optsIn == null) return;
                    options = optsIn.split(',').map((s) => s.trim()).filter(Boolean);
                  }
                  try {
                    await api.put(`/api/troubles/fields/${fld.id}`, {
                      name: name.trim(), input_type: fld.input_type, options, sort_order: fld.sort_order,
                    });
                    await reload();
                  } catch (err) { alert(err.message); }
                }}, '編集'),
                el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
                  if (!confirm(`「${fld.name}」を削除しますか？\n（過去の記録の値は残ります）`)) return;
                  try {
                    await api.del(`/api/troubles/fields/${fld.id}`);
                    await reload();
                  } catch (err) { alert(err.message); }
                }}, '削除'),
              ]),
            ]);
          })),
      el('div', { class: 'add-row' }, [addName, addType]),
      el('div', { class: 'add-row' }, [
        addOptions,
        el('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          const name = addName.value.trim();
          if (!name) { alert('項目名を入力してください。'); return; }
          const options = addOptions.value.split(',').map((s) => s.trim()).filter(Boolean);
          try {
            await api.post('/api/troubles/fields', {
              name, input_type: addType.value, options, sort_order: fields.length + 1,
            });
            await reload();
          } catch (err) { alert(err.message); }
        }}, '＋ 追加'),
      ]),
    ]);
  };

  reload().catch((err) => render(wrap, el('p', { class: 'notice is-error' }, err.message)));
  return wrap;
}

async function renderManage() {
  const { equipment } = await api.get('/api/equipment');

  const equipSel = el('select', {}, [
    el('option', { value: '' }, '— 設備を選択'),
    ...equipment.map((e) => el('option', { value: e.id }, `${e.code} ${e.name}`)),
  ]);

  render(tabContent, [
    categorySection('トラブルジャンル', '/api/troubles/categories', '使用中のジャンルは削除できません（先に該当トラブル記録のジャンルを変更してください）。'),
    categorySection('日報カテゴリ', '/api/reports/categories', '使用中のカテゴリは削除できません。'),
    customFieldSection(),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, '点検項目マスタ'),
      el('p', { class: 'hint' }, '点検項目は設備ごとに管理します。設備を選んで管理画面を開いてください。'),
      el('div', { class: 'add-row' }, [
        equipSel,
        el('button', { class: 'btn btn-sm', onclick: () => {
          if (!equipSel.value) { alert('設備を選択してください。'); return; }
          window.location.href = `/pages/inspection?masters=${equipSel.value}`;
        }}, '開く'),
      ]),
    ]),
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
              el('td', {}, maskEmail(log.changed_by)),
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
            el('td', {}, maskEmail(r.deleted_by) || '—'),
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
  report_category: '日報カテゴリ', trouble_custom_field: 'トラブルカスタム項目',
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
        el('thead', {}, [el('tr', {}, ['マスタ', 'レコードID', '変更者', '変更日時', '変更前スナップショット', '操作'].map((h) => el('th', {}, h)))]),
        el('tbody', {}, history.map((h) =>
          el('tr', {}, [
            el('td', {}, MASTER_LABELS[h.master_name] || h.master_name),
            el('td', {}, h.record_id != null ? String(h.record_id) : '—'),
            el('td', {}, maskEmail(h.changed_by)),
            el('td', {}, h.changed_at?.slice(0, 16).replace('T', ' ') || '—'),
            el('td', { style: 'font-size:11px;max-width:200px;word-break:break-all' },
              String(h.snapshot_json || '').slice(0, 120)
            ),
            el('td', {}, h.record_id != null
              ? el('button', { class: 'btn btn-sm', onclick: async () => {
                  if (!confirm('この時点の内容に復元しますか？\n（復元前の現在値も履歴に残るため、復元の取り消しもできます）')) return;
                  try {
                    await api.post('/api/admin/masters/restore', { history_id: h.id });
                    alert('復元しました。');
                    await load();
                  } catch (err) { alert(err.message); }
                }}, '復元')
              : '—'),
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
    el('p', { class: 'hint' }, 'マスタ（カテゴリ・点検項目・カスタム項目）の変更前スナップショットを確認し、その時点の内容へ復元できます。'),
    listBox,
  ]);
  await load();
}

// ---------------- バックアップ ----------------

async function renderBackup() {
  const statusEl = el('p', { class: 'notice' }, '「JSONをダウンロード」ボタンを押すと全テーブルのデータをまとめてダウンロードできます。');

  const downloadBtn = el('button', { class: 'btn btn-primary', onclick: async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = '準備中…';
    try {
      const res = await fetch('/api/admin/backup', { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `エラー ${res.status}`);
      }
      const blob = await res.blob();
      const date = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
      render(statusEl.parentElement ? statusEl : statusEl, []);
    } catch (err) {
      alert(`バックアップに失敗しました: ${err.message}`);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'JSONをダウンロード';
    }
  }}, 'JSONをダウンロード');

  render(tabContent, [
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, 'データバックアップ'),
      el('p', { class: 'hint' }, 'データベースの全テーブルをJSON形式でダウンロードします。このファイルを保存しておくことで、万一データが失われた場合の復旧に役立てられます。'),
      el('ul', { class: 'hint', style: 'margin-top:4px;padding-left:18px' }, [
        el('li', {}, '含まれるデータ: 設備台帳・点検結果・トラブル記録・業務依頼・部品在庫・保全計画・日報・ユーザー・監査ログ など全テーブル'),
        el('li', {}, '含まれないもの: R2に保存された写真・動画・PDF（ファイルのURLは含まれます）'),
        el('li', {}, 'アプリのコード・スキーマはGitHubに保存されているため、このファイルはデータのバックアップ専用です'),
      ]),
      el('div', { class: 'action-row', style: 'margin-top:16px' }, [downloadBtn]),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, 'コード・スキーマのバックアップ'),
      el('p', { class: 'hint' }, 'アプリのコードとデータベーススキーマ（table定義）はGitHubに保存されています。Cloudflare Pagesのデプロイ履歴からいつでも以前のバージョンに戻せます（ワンクリックロールバック）。'),
      el('p', { class: 'hint', style: 'margin-top:4px' }, 'D1データベースはCloudflareのTime Travel機能で過去30日間の任意の時点に復元できます。万一の際はCloudflareダッシュボードから操作してください。'),
    ]),
  ]);
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

    // 他画面から ?tab=manage 等でディープリンクできるようにする
    const wantedTab = new URLSearchParams(window.location.search).get('tab');
    if (wantedTab && TABS.some((t) => t.id === wantedTab)) activeTab = wantedTab;

    render(app, [
      el('div', { class: 'tab-bar' },
        TABS.map(({ id, label }) =>
          el('button', {
            class: `tab-btn ${id === activeTab ? 'is-active' : ''}`,
            'data-tab': id,
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
