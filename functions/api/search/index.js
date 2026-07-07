// GET /api/search?q=キーワード&from=YYYY-MM-DD&to=YYYY-MM-DD&type=trouble,repair,...&equipment_id=N&category_id=N
//
// 検索対象: trouble_record / inspection_result / repair_request / daily_report / equipment_ledger
// 複数キーワード: スペース区切りで AND 検索
// 実装: D1 の LIKE 検索（FTS5 への移行は将来の課題）

import { json } from '../_lib/http.js';

// ---- あいまい検索: キーワードの表記ゆれを吸収するバリアントを生成する ----
//   ・全角英数 → 半角（例「ＡＢＣ１２３」→「ABC123」。英字の大小は LIKE が元々区別しない）
//   ・ひらがな ⇄ カタカナ（例「こんぷれっさ」でカタカナの「コンプレッサ」がヒット）
//   ・末尾の長音ゆれ（例「コンプレッサー」で「コンプレッサ」もヒット。逆方向は部分一致で元々当たる）
//   D1(SQLite) には日本語正規化関数が無いため、クエリ側を複数形に展開して LIKE の OR で当てる。
const toHalfWidth = (s) => s
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');
const hiraToKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

function keywordVariants(kw) {
  const half = toHalfWidth(kw);
  const set = new Set([kw, half, hiraToKata(half), kataToHira(half)]);
  for (const v of [...set]) {
    if (v.length > 2 && (v.endsWith('ー') || v.endsWith('ｰ'))) set.add(v.slice(0, -1));
  }
  return [...set].slice(0, 6); // バリアント数の上限（bind数の暴発防止）
}

// 1キーワードぶんの LIKE 条件（全列 × 全バリアントの OR）
function likeOr(cols, variantCount) {
  const parts = [];
  for (const c of cols) for (let i = 0; i < variantCount; i++) parts.push(`${c} LIKE ?`);
  return '(' + parts.join(' OR ') + ')';
}

// 複数キーワード（AND）を生成して WHERE 句と bind 値を返す
function buildKeywordClauses(keywords, cols) {
  if (!keywords.length) return { clauses: [], binds: [] };
  const clauses = [];
  const binds   = [];
  for (const kw of keywords) {
    const variants = keywordVariants(kw);
    clauses.push(likeOr(cols, variants.length));
    for (const _c of cols) for (const v of variants) binds.push(`%${v}%`);
  }
  return { clauses, binds };
}


// 拡張列（後付けのALTER列を含む）で検索し、列が無い旧DBでは基本列のみで再試行する。
//   run(cols) は rows 配列を返す関数。検索全体を止めないための保険。
//   拡張列で失敗したら基本列で再試行する。基本列は常に存在する列なので、それでも失敗する
//   なら本物の障害としてそのまま投げる（＝onRequestGet が500にする）。base が成功すれば
//   結果が返るので、未マイグレーション環境でも検索が丸ごと落ちない。
//   ※ D1 のエラーは詳細が err.cause 側に入ることがあり、err.message だけを「no such column」で
//     判定すると本番でフォールバックが効かず検索全体が失敗した（設備名でヒットしない不具合）。
//     基本列は安全に実行できるため、エラー種別で絞らず必ず再試行する方が堅牢。
async function searchWithFallback(run, extendedCols, baseCols) {
  try {
    return await run(extendedCols);
  } catch (err) {
    console.warn('search: 拡張列で失敗したため基本列で再試行します:', String((err && err.message) || err));
    return await run(baseCols);
  }
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const sp  = new URL(request.url).searchParams;

  const q           = (sp.get('q') || '').trim();
  const from        = sp.get('from');
  const to          = sp.get('to');
  const equipId     = sp.get('equipment_id');
  const categoryId  = sp.get('category_id');
  const typeParam   = sp.get('type');        // comma-separated
  const limit       = Math.min(Number(sp.get('limit')) || 50, 200);

  const keywords = q ? q.split(/\s+/).filter(Boolean).slice(0, 5) : [];
  const types    = typeParam ? typeParam.split(',').map((t) => t.trim()) : ['trouble', 'inspection', 'repair', 'report', 'equipment', 'parts', 'plan'];

  const results = [];

  // ---------- トラブル記録 ----------
  if (types.includes('trouble')) {
    // 拡張列: 記録者名・帳票入力（処置・トラブル名等のJSON）・カスタム項目値も検索対象にする
    const run = async (cols) => {
      const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
      let sql = `
        SELECT
          t.id, t.occurred_at AS date_val, t.phenomenon AS title,
          t.cause, t.countermeasure,
          tc.name AS category_name,
          e.name  AS equipment_name, e.code AS equipment_code
        FROM trouble_record t
        LEFT JOIN trouble_category tc ON t.category_id = tc.id
        LEFT JOIN equipment_ledger  e  ON t.equipment_id = e.id
        WHERE t.deleted_at IS NULL
      `;
      const binds = [...kwBinds];
      if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
      if (from)       { sql += ` AND t.occurred_at >= ?`; binds.push(from); }
      if (to)         { sql += ` AND t.occurred_at <= ?`; binds.push(to + 'T23:59:59Z'); }
      if (equipId)    { sql += ` AND t.equipment_id = ?`; binds.push(equipId); }
      if (categoryId) { sql += ` AND t.category_id = ?`;  binds.push(categoryId); }
      sql += ` ORDER BY t.occurred_at DESC LIMIT ${limit}`;
      return (await db.prepare(sql).bind(...binds).all()).results;
    };
    const rows = await searchWithFallback(
      run,
      ['t.phenomenon', 't.cause', 't.countermeasure', 't.reporter_name', 't.form_values_json', 't.custom_fields_json', 'e.name', 'e.code', 'e.line_name', 'e.equipment_name'],
      ['t.phenomenon', 't.cause', 't.countermeasure', 'e.name', 'e.code', 'e.line_name', 'e.equipment_name']
    );
    for (const r of rows ?? []) {
      results.push({
        type:           'trouble',
        id:             r.id,
        date:           r.date_val?.slice(0, 10),
        title:          r.title,
        snippet:        [r.cause, r.countermeasure].filter(Boolean).join(' / ').slice(0, 80),
        category_name:  r.category_name,
        equipment_name: r.equipment_name ? `${r.equipment_code} ${r.equipment_name}` : null,
        url:            `/pages/trouble?id=${r.id}`,
      });
    }
  }

  // ---------- 業務依頼 ----------
  if (types.includes('repair')) {
    // 拡張列: 担当者名も検索対象にする
    const run = async (cols) => {
      const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
      let sql = `
        SELECT
          r.id, r.created_at AS date_val, r.title, r.status,
          e.name AS equipment_name, e.code AS equipment_code
        FROM repair_request r
        LEFT JOIN equipment_ledger e ON r.equipment_id = e.id
        WHERE r.deleted_at IS NULL
      `;
      const binds = [...kwBinds];
      if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
      if (from)    { sql += ` AND r.created_at >= ?`; binds.push(from); }
      if (to)      { sql += ` AND r.created_at <= ?`; binds.push(to + 'T23:59:59Z'); }
      if (equipId) { sql += ` AND r.equipment_id = ?`; binds.push(equipId); }
      sql += ` ORDER BY r.created_at DESC LIMIT ${limit}`;
      return (await db.prepare(sql).bind(...binds).all()).results;
    };
    const rows = await searchWithFallback(run,
      ['r.title', 'r.description', 'r.assignee_name', 'e.name', 'e.code', 'e.line_name', 'e.equipment_name'],
      ['r.title', 'r.description', 'e.name', 'e.code', 'e.line_name', 'e.equipment_name']);
    const STATUS = { open: '受付', in_progress: '対応中', waiting_parts: '部品待ち', done: '完了' };
    for (const r of rows ?? []) {
      results.push({
        type:           'repair',
        id:             r.id,
        date:           r.date_val?.slice(0, 10),
        title:          r.title,
        snippet:        STATUS[r.status] || r.status,
        category_name:  null,
        equipment_name: r.equipment_name ? `${r.equipment_code} ${r.equipment_name}` : null,
        url:            `/pages/repair?id=${r.id}`,
      });
    }
  }

  // ---------- 日報 ----------
  if (types.includes('report')) {
    // 拡張列: 入力者名（自由入力）も検索対象にする
    const run = async (cols) => {
      const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
      let sql = `
        SELECT
          dr.id, dr.report_date AS date_val, dr.body,
          rc.name AS category_name,
          COALESCE(dr.reporter_name, u.name) AS reporter_name
        FROM daily_report dr
        LEFT JOIN report_category rc ON dr.category_id = rc.id
        LEFT JOIN users            u  ON dr.reporter_id = u.id
        WHERE dr.deleted_at IS NULL
      `;
      const binds = [...kwBinds];
      if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
      if (from)       { sql += ` AND dr.report_date >= ?`; binds.push(from); }
      if (to)         { sql += ` AND dr.report_date <= ?`; binds.push(to); }
      // category_id はトラブルのジャンルID（検索画面のセレクタはトラブルジャンル）。
      // 日報カテゴリは別マスタで同じIDでも意味が違うため、日報には適用しない
      sql += ` ORDER BY dr.report_date DESC LIMIT ${limit}`;
      return (await db.prepare(sql).bind(...binds).all()).results;
    };
    const rows = await searchWithFallback(run, ['dr.body', 'dr.reporter_name'], ['dr.body']);
    for (const r of rows ?? []) {
      results.push({
        type:           'report',
        id:             r.id,
        date:           r.date_val,
        title:          r.body.slice(0, 60),
        snippet:        r.reporter_name || '',
        category_name:  r.category_name,
        equipment_name: null,
        url:            `/pages/report?id=${r.id}`,
      });
    }
  }

  // ---------- 点検結果 ----------
  if (types.includes('inspection')) {
    // 拡張列: 点検項目の値（items_json・自由記述など）と担当者名も検索対象にする
    const run = async (cols) => {
      const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
      let sql = `
        SELECT
          ir.id, ir.inspected_at AS date_val, ir.has_abnormal,
          ir.note,
          e.name AS equipment_name, e.code AS equipment_code
        FROM inspection_result ir
        LEFT JOIN equipment_ledger e ON ir.equipment_id = e.id
        WHERE ir.deleted_at IS NULL
      `;
      const binds = [...kwBinds];
      if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
      if (from)    { sql += ` AND ir.inspected_at >= ?`; binds.push(from); }
      if (to)      { sql += ` AND ir.inspected_at <= ?`; binds.push(to + 'T23:59:59Z'); }
      if (equipId) { sql += ` AND ir.equipment_id = ?`;  binds.push(equipId); }
      sql += ` ORDER BY ir.inspected_at DESC LIMIT ${limit}`;
      return (await db.prepare(sql).bind(...binds).all()).results;
    };
    // キーワードも設備も期間もなければスキップ（全件は多すぎる）
    if (!keywords.length && !from && !to && !equipId) {
      // no-op: skip
    } else {
      const rows = await searchWithFallback(run,
        ['ir.note', 'ir.items_json', 'ir.assignee_name', 'e.name', 'e.code', 'e.line_name', 'e.equipment_name'],
        ['ir.note', 'e.name', 'e.code', 'e.line_name', 'e.equipment_name']);
      for (const r of rows ?? []) {
        results.push({
          type:           'inspection',
          id:             r.id,
          date:           r.date_val?.slice(0, 10),
          title:          `${r.equipment_name || ''}の点検${r.has_abnormal ? '（異常あり）' : ''}`,
          snippet:        r.note?.slice(0, 80) || '',
          category_name:  null,
          equipment_name: r.equipment_name ? `${r.equipment_code} ${r.equipment_name}` : null,
          url:            `/pages/inspection?id=${r.id}`,
        });
      }
    }
  }

  // ---------- 設備台帳 ----------
  if (types.includes('equipment')) {
    const cols = ['name', 'code', 'manufacturer', 'model', 'note'];
    const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
    let sql = `
      SELECT id, code, name, location, manufacturer, model, status
      FROM equipment_ledger
      WHERE deleted_at IS NULL
    `;
    const binds = [...kwBinds];
    if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
    if (!keywords.length && !equipId) {
      // キーワードなし・設備IDなしは全件になるのでスキップ
    } else {
      if (equipId) { sql += ` AND id = ?`; binds.push(equipId); }
      sql += ` ORDER BY code LIMIT ${limit}`;
      const { results: rows } = await db.prepare(sql).bind(...binds).all();
      const STATUS = { active: '稼働中', stopped: '停止中', retired: '廃棄' };
      for (const r of rows ?? []) {
        results.push({
          type:           'equipment',
          id:             r.id,
          date:           null,
          title:          `${r.code} ${r.name}`,
          snippet:        [r.location, r.manufacturer, STATUS[r.status]].filter(Boolean).join(' / '),
          category_name:  null,
          equipment_name: null,
          url:            `/pages/ledger?id=${r.id}`,
        });
      }
    }
  }

  // ---------- 部品在庫 ----------
  if (types.includes('parts')) {
    const cols = ['name', 'model_no', 'line_name', 'equipment_name', 'location', 'supplier', 'note'];
    const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
    // 全件は多すぎるため、キーワードがあるときだけ検索する
    if (keywords.length) {
      let sql = `
        SELECT id, name, model_no, line_name, equipment_name, location, quantity, safety_stock
        FROM parts_inventory
        WHERE deleted_at IS NULL
      `;
      const binds = [...kwBinds];
      if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
      sql += ` ORDER BY name LIMIT ${limit}`;
      const { results: rows } = await db.prepare(sql).bind(...binds).all();
      for (const r of rows ?? []) {
        const equip = [r.line_name, r.equipment_name].filter(Boolean).join(' / ');
        results.push({
          type:           'parts',
          id:             r.id,
          date:           null,
          title:          r.model_no ? `${r.model_no}（${r.name}）` : r.name,
          snippet:        [equip, r.location, `在庫${r.quantity}/必要${r.safety_stock}`].filter(Boolean).join(' / '),
          category_name:  r.quantity < r.safety_stock ? '要発注' : null,
          equipment_name: null,
          url:            `/pages/parts?id=${r.id}`,
        });
      }
    }
  }

  // ---------- 保全計画 ----------
  if (types.includes('plan')) {
    const PLAN_TYPE = { inspection: '点検', parts: '部品交換', construction: '工事', other: 'その他' };
    // 拡張列: 担当者・点検者も検索対象にする
    const run = async (cols) => {
      const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
      let sql = `
        SELECT id, title, plan_type, planned_date, line_name, equipment_name, note, status
        FROM maintenance_plan
        WHERE deleted_at IS NULL
      `;
      const binds = [...kwBinds];
      if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
      if (from) { sql += ` AND planned_date >= ?`; binds.push(from); }
      if (to)   { sql += ` AND planned_date <= ?`; binds.push(to); }
      sql += ` ORDER BY planned_date DESC LIMIT ${limit}`;
      return (await db.prepare(sql).bind(...binds).all()).results;
    };
    // キーワードも期間もなければ全件になるのでスキップ
    if (keywords.length || from || to) {
      const rows = await searchWithFallback(run,
        ['title', 'note', 'line_name', 'equipment_name', 'assignee_name', 'inspector_name'],
        ['title', 'note', 'line_name', 'equipment_name']);
      for (const r of rows ?? []) {
        const equip = [r.line_name, r.equipment_name].filter(Boolean).join(' / ');
        results.push({
          type:           'plan',
          id:             r.id,
          date:           r.planned_date?.slice(0, 10),
          title:          r.title,
          snippet:        [PLAN_TYPE[r.plan_type] || r.plan_type, equip, r.note].filter(Boolean).join(' / ').slice(0, 80),
          category_name:  null,
          equipment_name: null,
          url:            `/pages/plan?id=${r.id}`,
        });
      }
    }
  }

  // 日付降順でソート（date が null/空のもの＝設備等は末尾へ）。
  // 0 を返さない比較関数は非推移的になり順序が不安定になるため、3値で比較する。
  results.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da === db) return 0;
    if (!da) return 1;   // a が日付なし → 後ろ
    if (!db) return -1;  // b が日付なし → 後ろ
    return da < db ? 1 : -1; // 新しい日付を先頭に
  });

  return json({ results, count: results.length, keywords });
}
