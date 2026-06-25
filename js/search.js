// 11 横断検索 — キーワード × フィルタで全データを横断検索
//   URL: /pages/search?q=キーワード&type=trouble,repair,...&from=&to=&equipment_id=&category_id=

import { api } from '/js/api.js';
import { getCurrentUser } from '/js/auth.js';
import { el, render, formatDateTime } from '/js/util.js';
import { buildEquipSelect } from '/js/equip-picker.js';

const app = document.getElementById('app');

const TYPE_CONFIG = {
  trouble:    { label: 'トラブル',  color: '#b45309', bg: '#fef3c7' },
  repair:     { label: '業務依頼',  color: '#6b21a8', bg: '#f3e8ff' },
  report:     { label: '日報',      color: '#15803d', bg: '#dcfce7' },
  inspection: { label: '点検',      color: '#1e40af', bg: '#dbeafe' },
  equipment:  { label: '設備台帳',  color: '#0f766e', bg: '#ccfbf1' },
  parts:      { label: '部品在庫',  color: '#9a3412', bg: '#ffedd5' },
  plan:       { label: '保全計画',  color: '#0369a1', bg: '#e0f2fe' },
};

const ALL_TYPES = Object.keys(TYPE_CONFIG);

// URL パラメータを読み書き
function getParams() {
  const sp = new URLSearchParams(window.location.search);
  return {
    q:            sp.get('q') || '',
    type:         sp.get('type') || ALL_TYPES.join(','),
    from:         sp.get('from') || '',
    to:           sp.get('to') || '',
    equipment_id: sp.get('equipment_id') || '',
    category_id:  sp.get('category_id') || '',
  };
}

function setParams(values) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v) sp.set(k, v);
  const newUrl = window.location.pathname + (sp.toString() ? '?' + sp.toString() : '');
  history.replaceState(null, '', newUrl);
}

// ---------------- 検索実行 ----------------

async function doSearch(params, resultsBox) {
  render(resultsBox, el('p', { class: 'loading' }, '検索中…'));
  try {
    const sp = new URLSearchParams();
    if (params.q)            sp.set('q', params.q);
    if (params.type)         sp.set('type', params.type);
    if (params.from)         sp.set('from', params.from);
    if (params.to)           sp.set('to', params.to);
    if (params.equipment_id) sp.set('equipment_id', params.equipment_id);
    if (params.category_id)  sp.set('category_id', params.category_id);

    const { results, count, keywords } = await api.get(`/api/search?${sp}`);

    if (count === 0) {
      render(resultsBox, el('p', { class: 'empty' }, params.q
        ? `「${params.q}」に一致するデータは見つかりませんでした。`
        : '条件に一致するデータがありません。'
      ));
      return;
    }

    // テキストをエスケープしてからキーワードをハイライトする
    const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
    const highlight = (text, kws) => {
      const escaped = escapeHtml(text);
      if (!kws.length) return escaped;
      let result = escaped;
      for (const kw of kws) {
        result = result.replace(
          new RegExp(escapeHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          (m) => `<mark>${m}</mark>`
        );
      }
      return result;
    };

    render(resultsBox, [
      el('p', { style: 'font-size:13px;color:#64748b;margin:4px 0 12px' },
        `${count}件ヒット${keywords.length ? '（キーワード: ' + keywords.join('、') + '）' : ''}`
      ),
      el('div', { class: 'search-results' },
        results.map((r) => {
          const cfg = TYPE_CONFIG[r.type] || {};
          const titleEl = el('span', {});
          titleEl.innerHTML = highlight(r.title, keywords);
          const snippetEl = r.snippet ? el('div', { class: 'search-snippet' }) : null;
          if (snippetEl) snippetEl.innerHTML = highlight(r.snippet, keywords);

          return el('a', { class: 'search-result-item', href: r.url }, [
            el('div', { class: 'search-result-meta' }, [
              el('span', { class: 'type-badge', style: `background:${cfg.bg};color:${cfg.color}` }, cfg.label || r.type),
              r.date ? el('span', { class: 'search-date' }, r.date) : null,
              r.category_name ? el('span', { class: 'cat-badge' }, r.category_name) : null,
            ]),
            el('div', { class: 'search-result-title' }, [titleEl]),
            r.equipment_name
              ? el('div', { class: 'search-equipment' }, `🏭 ${r.equipment_name}`)
              : null,
            snippetEl,
          ]);
        })
      ),
    ]);
  } catch (err) {
    render(resultsBox, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
}

// ---------------- 画面構築 ----------------

async function renderSearch() {
  const [{ equipment }, { categories }] = await Promise.all([
    api.get('/api/equipment'),
    api.get('/api/troubles/categories'),
  ]);

  const params = getParams();
  let debounceTimer = null;

  const resultsBox = el('div', {}, []);

  // 検索ボックス
  const searchInput = el('input', {
    type: 'search',
    class: 'search-input',
    placeholder: '例: コンプレッサ 異音　　（スペース区切りで AND 検索）',
    value: params.q,
    autofocus: true,
  });

  const triggerSearch = () => {
    const current = buildCurrentParams();
    setParams(current);
    doSearch(current, resultsBox).catch(() => {});
  };

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(triggerSearch, 400);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(debounceTimer); triggerSearch(); }
  });

  // 種別チェックボックス
  const typeChecks = ALL_TYPES.map((type) => {
    const cfg = TYPE_CONFIG[type];
    const isChecked = params.type.includes(type);
    const cb = el('input', { type: 'checkbox', id: `type-${type}`, checked: isChecked, onchange: triggerSearch });
    return el('label', {
      class: 'type-check',
      for: `type-${type}`,
      style: `background:${cfg.bg};color:${cfg.color}`,
    }, [cb, ` ${cfg.label}`]);
  });

  // 期間・設備・カテゴリフィルタ
  const fromIn = el('input', { type: 'date', value: params.from, onchange: triggerSearch });
  const toIn   = el('input', { type: 'date', value: params.to,   onchange: triggerSearch });

  const equipSel = buildEquipSelect(equipment, {
    value: params.equipment_id || '',
    allLabel: '全設備',
    onchange: triggerSearch,
  });

  const catSel = el('select', { onchange: triggerSearch }, [
    el('option', { value: '' }, 'ジャンル指定なし'),
    ...categories.map((c) => el('option', { value: c.id, selected: params.category_id === String(c.id) }, c.name)),
  ]);

  const buildCurrentParams = () => ({
    q:            searchInput.value.trim(),
    type:         ALL_TYPES.filter((t) => document.getElementById(`type-${t}`)?.checked).join(','),
    from:         fromIn.value,
    to:           toIn.value,
    equipment_id: equipSel.value,
    category_id:  catSel.value,
  });

  render(app, [
    el('div', { class: 'search-box-wrap' }, [
      searchInput,
    ]),
    el('div', { class: 'filter-bar', style: 'margin-top:8px' }, typeChecks),
    el('div', { class: 'filter-bar' }, [
      el('label', { class: 'filter-label' }, ['FROM ', fromIn]),
      el('label', { class: 'filter-label' }, ['TO ', toIn]),
    ]),
    el('div', { class: 'filter-bar' }, [equipSel, catSel]),
    resultsBox,
  ]);

  // 初期検索（URLにqパラメータがあれば実行）
  if (params.q || params.from || params.to || params.equipment_id) {
    await doSearch(params, resultsBox);
  } else {
    render(resultsBox, el('p', { class: 'empty', style: 'text-align:center;margin-top:40px' },
      '検索キーワードを入力してください。\nスペース区切りで複数キーワードの AND 検索ができます。'
    ));
  }
}

// ---------------- 起動 ----------------

(async () => {
  try {
    await getCurrentUser();
    await renderSearch();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
