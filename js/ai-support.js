// 14 AIサポート — 現場の困りごとを1行入力すると
//   ① 過去の似たトラブル ② 関連する部品在庫 ③ 関連する業務依頼 ④ AIの対応策
// をまとめて出す。設備が止まった瞬間に、記録を書き始めなくても
// 「前に同じことがあったか・部品は在庫にあるか・もう依頼が出ているか」を引けるようにする。
//
//   新規APIは作らず、既存のエンドポイントを組み合わせるだけ:
//     GET  /api/troubles/similar?phenomenon=&limit=10  （あいまい OR 検索・全員）
//     GET  /api/parts?q=&include_similar=1             （あいまい AND ＋ 類似 OR 枠・全員）
//     GET  /api/search?q=&type=repair&limit=10         （あいまい AND 検索・全員）
//     POST /api/ai/suggest-trouble { phenomenon }      （Workers AI・editor以上）
//
//   ①②③は AI を使わないので、env.AI 未構成（/api/me の ai_enabled:false）でも動く。
//   AI に依存するのは④だけなので、④のボタンだけを出し分ける（ページ全体は常に使える）。

import { api } from '/js/api.js';
import { el, render, formatDate } from '/js/util.js';
import { getCurrentUser, hasRole, getAiEnabled } from '/js/auth.js';

const app = document.getElementById('app');

/** 各セクションの表示上限（専用ページなので一覧性を優先して10件） */
const MAX_ROWS = 10;

// 業務依頼の検索に渡すキーワードの上限。
//   /api/search は検索列が7列・キーワード最大5語で、bind数 = 語数 × 列数 × バリアント数。
//   長音付きカタカナは1語で6バリアントまで増えるため、3語以上で D1 の bind 上限100を超える
//   （実測: 「コンプレッサー フィルター モーター」で126）。2語なら最悪でも84で収まる。
//   ※ /api/search 側の根本修正は横断検索(11)全体の挙動に関わるため別件。ここでは入力を絞って回避する。
const REPAIR_MAX_KEYWORDS = 2;

const tokensOf = (q) => q.split(/\s+/).filter(Boolean);

// ─── 検索（AI不要） ──────────────────────────────────────────────────────

function fetchTroubles(q) {
  return api.get(`/api/troubles/similar?phenomenon=${encodeURIComponent(q)}&limit=${MAX_ROWS}`)
    .then((r) => r.similar || [])
    .catch(() => null);            // null = 取得失敗（0件と区別してセクションを出さない）
}

function fetchParts(q) {
  return api.get(`/api/parts?q=${encodeURIComponent(q)}&include_similar=1`)
    .then((r) => ({ parts: r.parts || [], similar: r.similar || [] }))
    .catch(() => null);
}

// 業務依頼は /api/search（AND検索）。0件になりやすいので、そのときだけ先頭1語で1回だけ引き直す。
async function fetchRepairs(q) {
  const searchRepairs = (kw) =>
    api.get(`/api/search?q=${encodeURIComponent(kw)}&type=repair&limit=${MAX_ROWS}`)
      .then((r) => r.results || []);
  const tokens = tokensOf(q);
  const primary = tokens.slice(0, REPAIR_MAX_KEYWORDS).join(' ');
  try {
    const rows = await searchRepairs(primary);
    if (rows.length > 0 || tokens.length < 2) return { rows, retriedWith: null };
    // AND で0件 → 先頭1語で再検索（再現率を取り戻す。0件時のみなので通常は増えない）
    const retry = await searchRepairs(tokens[0]);
    return { rows: retry, retriedWith: retry.length ? tokens[0] : null };
  } catch {
    return null;
  }
}

// ─── 行の描画 ────────────────────────────────────────────────────────────

// 「すべて見る」は横断検索(11)へ。部品一覧(/pages/parts)は q パラメータを受け付けないため3種とも横断検索。
function seeAllLink(q, type) {
  return el('a', {
    class: 'home-activity-more', style: 'display:inline-block;margin-top:8px',
    href: `/pages/search?q=${encodeURIComponent(q)}&type=${type}`,
  }, 'すべて見る（横断検索）›');
}

function troubleRow(t) {
  return el('a', { class: 'home-activity-item', href: `/pages/trouble?id=${t.id}` }, [
    el('span', { class: 'home-activity-time' }, formatDate(t.occurred_at)),
    t.category_name ? el('span', { class: 'cat-badge' }, t.category_name) : null,
    el('span', { class: 'home-activity-text' }, t.phenomenon || '(現象の記載なし)'),
  ]);
}

// 在庫バッジ。js/parts.js の一覧・詳細と同じクラス・同じ判定にそろえる
//   （parts.js 側はモジュール内インラインで export されていないため、ここに同じ物を持つ）
function stockBadges(p) {
  const qty = Number(p.quantity) || 0;
  const safety = Number(p.safety_stock) || 0;
  return [
    el('span', { class: 'home-activity-time' }, `在庫 ${qty}`),
    qty === 0
      ? el('span', { class: 'abn-badge is-abn' }, '在庫0')
      : (qty < safety ? el('span', { class: 'abn-badge is-abn' }, '要発注') : null),
    p.ordered_at
      ? el('span', { class: 'status-badge', style: 'background:#dbeafe;color:#1e40af' }, '📨 発注中')
      : null,
  ].filter(Boolean);
}

function partRow(p) {
  const name = [p.name, p.model_no].filter(Boolean).join(' / ');
  return el('a', { class: 'home-activity-item', href: `/pages/parts?id=${p.id}` }, [
    el('span', { class: 'home-activity-text' }, name || '(名称なし)'),
    ...stockBadges(p),
  ]);
}

// 業務依頼。/api/search が url とステータス日本語(snippet)をそのまま返すので整形不要
function repairRow(r) {
  const done = r.snippet === '完了';
  return el('a', { class: 'home-activity-item', href: r.url }, [
    el('span', { class: 'home-activity-time' }, r.date ? formatDate(r.date) : ''),
    el('span', {
      class: 'status-badge',
      style: done ? 'background:#dcfce7;color:#15803d' : 'background:#dbeafe;color:#1e40af',
    }, r.snippet || ''),
    el('span', { class: 'home-activity-text' }, r.title),
  ]);
}

// ─── セクション（1セクション = 1カード） ─────────────────────────────────

const sectionCard = (title, children) =>
  el('div', { class: 'card' }, [el('h2', { class: 'card-title' }, title), ...children]);

function troubleSection(rows, q) {
  if (!rows || rows.length === 0) return null;
  return sectionCard(`⚠️ 過去の似たトラブル（${rows.length}件）`, [
    ...rows.map(troubleRow),
    seeAllLink(q, 'trouble'),
  ]);
}

function partSection(data, q) {
  if (!data || (data.parts.length === 0 && data.similar.length === 0)) return null;
  const exact = data.parts.slice(0, MAX_ROWS);
  const similar = data.similar.slice(0, MAX_ROWS);

  // 全キーワードを含む部品（AND）が1件も無いとき。
  //   「コンプレッサ 異音」のように現象の語を含めて検索すると AND では必ず0件になるため、
  //   「0件」とだけ出して類似を畳むと、実際に関係のある部品が隠れて見つけられない。
  //   この場合は類似（いずれかの語に一致）を最初から開いて主役として出す。
  if (exact.length === 0) {
    return sectionCard(`📦 関連しそうな部品在庫（${similar.length}件）`, [
      ...similar.map(partRow),
      el('p', { class: 'hint' }, '※ いずれかのキーワードに一致した部品です。'),
      seeAllLink(q, 'parts'),
    ]);
  }

  // AND で見つかったものが主役。類似（OR）はそれを埋もれさせないよう折りたたむ
  const children = [...exact.map(partRow)];
  if (similar.length > 0) {
    const box = el('div', {});
    let open = false;
    const toggle = el('button', {
      class: 'home-activity-more', type: 'button',
      style: 'display:inline-block;margin-top:6px;background:none;border:none;padding:0;cursor:pointer',
      onclick: () => {
        open = !open;
        toggle.textContent = `${open ? '▾' : '▸'} 類似の在庫 ${data.similar.length}件`;
        render(box, open ? similar.map(partRow) : []);
      },
    }, `▸ 類似の在庫 ${data.similar.length}件`);
    children.push(toggle, box);
  }
  children.push(seeAllLink(q, 'parts'));
  return sectionCard(`📦 関連する部品在庫（${exact.length}件）`, children);
}

function repairSection(data, q) {
  if (!data || data.rows.length === 0) return null;
  const note = data.retriedWith ? `（「${data.retriedWith}」で再検索）` : '';
  return sectionCard(`🔧 関連する業務依頼（${data.rows.length}件）${note}`, [
    ...data.rows.map(repairRow),
    seeAllLink(q, 'repair'),
  ]);
}

// ─── AI: 対応策の案 ──────────────────────────────────────────────────────
//   トラブル記録(04)の「🤖 AIに原因・対策のヒントをもらう」と同じ作法:
//   ボタンを押したときだけ実行し、実行中は disabled + ラベル差し替え、finally で復帰する。

const CONFIDENCE = { high: ['高', 'imp-high'], medium: ['中', 'imp-mid'], low: ['低', 'imp-low'] };

function infoLine(label, value) {
  return el('p', { class: 'ai-sup-line' }, [
    el('span', { class: 'ai-sup-label' }, label),
    el('span', {}, value),
  ]);
}

function aiResultCard(s, q) {
  const conf = CONFIDENCE[s.confidence] || ['—', 'imp-low'];
  const hasAny = s.cause || s.countermeasure;
  return el('div', { class: 'ai-sup-box' }, [
    el('div', { class: 'card-title-row', style: 'margin-bottom:6px' }, [
      el('h4', { style: 'margin:0;font-size:13px;color:#374151' }, '🤖 AIの対応策'),
      el('span', { class: `imp-badge ${conf[1]}` }, `確度: ${conf[0]}`),
    ]),
    s.cause ? infoLine('推定原因', s.cause) : null,
    s.countermeasure ? infoLine('推奨対策', s.countermeasure) : null,
    hasAny ? null : el('p', { class: 'hint' }, 'AIから有効な提案が得られませんでした。'),
    // 記録・依頼への導線（既存フォームのURLプリフィルを流用。API・スキーマ変更なし）
    el('div', { class: 'action-row', style: 'margin-top:8px' }, [
      el('a', {
        class: 'btn btn-sm',
        href: `/pages/trouble?new=1&phenomenon=${encodeURIComponent(q)}`,
      }, 'この内容でトラブルを記録する ›'),
      el('a', {
        class: 'btn btn-sm',
        href: `/pages/repair?new=1&title=${encodeURIComponent(q)}`
          + `&description=${encodeURIComponent(s.countermeasure || '')}`,
      }, '業務依頼を出す ›'),
    ]),
    el('p', { class: 'hint', style: 'margin-top:6px' }, '※ AIの提案です。現場で確認してください。'),
  ]);
}

function aiSection(q) {
  const outBox = el('div', {});
  const btn = el('button', {
    class: 'btn btn-sm', type: 'button',
    onclick: async () => {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '🤖 AIが考え中…';
      render(outBox, el('p', { class: 'loading' }, 'AIが過去事例をもとに考えています…'));
      try {
        const { suggestion } = await api.post('/api/ai/suggest-trouble', { phenomenon: q });
        render(outBox, aiResultCard(suggestion || {}, q));
      } catch (err) {
        render(outBox, el('p', { class: 'notice is-error' }, err.message || 'AIの処理に失敗しました。'));
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    },
  }, '🤖 対応策の案をもらう');
  return el('div', { class: 'card' }, [
    el('div', { class: 'action-row', style: 'margin:0' }, [btn]),
    outBox,
  ]);
}

// ─── メイン ──────────────────────────────────────────────────────────────

async function renderAiSupport() {
  const user = await getCurrentUser();
  const canAskAi = getAiEnabled() && hasRole(user, 'editor');

  const resultBox = el('div', {});

  const input = el('input', {
    type: 'search',
    class: 'search-input',
    placeholder: '例: 3号機 コンプレッサ 異音',
    'aria-label': '困りごとの検索',
    autofocus: true,
  });

  const runSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    searchBtn.disabled = true;
    render(resultBox, el('p', { class: 'loading' }, '探しています…'));
    // 3本を並列に。個々に catch 済みなので1つ失敗しても残りは表示する
    const [troubles, parts, repairs] = await Promise.all([
      fetchTroubles(q), fetchParts(q), fetchRepairs(q),
    ]);
    searchBtn.disabled = false;

    const sections = [
      troubleSection(troubles, q),
      partSection(parts, q),
      repairSection(repairs, q),
    ].filter(Boolean);

    if (sections.length === 0) {
      sections.push(el('div', { class: 'card' }, [
        el('p', { class: 'home-tab-empty' }, '該当する記録・部品・依頼は見つかりませんでした。'),
        el('a', {
          class: 'home-activity-more', style: 'display:inline-block',
          href: `/pages/search?q=${encodeURIComponent(q)}`,
        }, '横断検索で探す ›'),
      ]));
    }

    // 1文字だけだと過去トラブル検索（2文字以上が条件）が動かないことを伝える
    if (q.length < 2) {
      sections.push(el('p', { class: 'hint' }, '※ 過去のトラブル検索は2文字以上で動きます。'));
    }
    if (canAskAi) sections.push(aiSection(q));

    render(resultBox, sections);
  };

  const searchBtn = el('button', {
    class: 'btn btn-primary', type: 'button', onclick: () => runSearch(),
  }, '🔍 探す');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  render(app, [
    el('div', { class: 'card' }, [
      el('div', { class: 'ai-sup-bar' }, [input, searchBtn]),
      el('p', { class: 'hint', style: 'margin:8px 0 0' },
        '困りごとを1行入力すると、過去のトラブル・部品在庫・業務依頼をまとめて探します。'),
    ]),
    resultBox,
  ]);
}

// ---------------- 起動 ----------------

(async () => {
  try {
    await renderAiSupport();
  } catch (err) {
    render(app, el('p', { class: 'notice is-error' }, err.message || String(err)));
  }
})();
