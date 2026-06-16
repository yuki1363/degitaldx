// GET /api/search?q=キーワード&from=YYYY-MM-DD&to=YYYY-MM-DD&type=trouble,repair,...&equipment_id=N&category_id=N
//
// 検索対象: trouble_record / inspection_result / repair_request / daily_report / equipment_ledger
// 複数キーワード: スペース区切りで AND 検索
// 実装: D1 の LIKE 検索（FTS5 への移行は将来の課題）

import { json } from '../_lib/http.js';

// キーワードを OR でまとめた LIKE 条件を生成する
// cols: 検索対象列名の配列, kw: キーワード文字列
function likeOr(cols, kw) {
  return '(' + cols.map((c) => `${c} LIKE ?`).join(' OR ') + ')';
}

// 複数キーワード（AND）を生成して WHERE 句と bind 値を返す
function buildKeywordClauses(keywords, cols) {
  if (!keywords.length) return { clauses: [], binds: [] };
  const clauses = [];
  const binds   = [];
  for (const kw of keywords) {
    clauses.push(likeOr(cols, kw));
    for (const _c of cols) binds.push(`%${kw}%`);
  }
  return { clauses, binds };
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
  const types    = typeParam ? typeParam.split(',').map((t) => t.trim()) : ['trouble', 'inspection', 'repair', 'report', 'equipment'];

  const results = [];

  // ---------- トラブル記録 ----------
  if (types.includes('trouble')) {
    const cols = ['t.phenomenon', 't.cause', 't.countermeasure'];
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

    const { results: rows } = await db.prepare(sql).bind(...binds).all();
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
    const cols = ['r.title', 'r.description'];
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

    const { results: rows } = await db.prepare(sql).bind(...binds).all();
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
    const cols = ['dr.body'];
    const { clauses, binds: kwBinds } = buildKeywordClauses(keywords, cols);
    let sql = `
      SELECT
        dr.id, dr.report_date AS date_val, dr.body,
        rc.name AS category_name,
        u.name  AS reporter_name
      FROM daily_report dr
      LEFT JOIN report_category rc ON dr.category_id = rc.id
      LEFT JOIN users            u  ON dr.reporter_id = u.id
      WHERE dr.deleted_at IS NULL
    `;
    const binds = [...kwBinds];
    if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
    if (from)       { sql += ` AND dr.report_date >= ?`; binds.push(from); }
    if (to)         { sql += ` AND dr.report_date <= ?`; binds.push(to); }
    if (categoryId) { sql += ` AND dr.category_id = ?`;  binds.push(categoryId); }
    sql += ` ORDER BY dr.report_date DESC LIMIT ${limit}`;

    const { results: rows } = await db.prepare(sql).bind(...binds).all();
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
    const cols = ['ir.note'];
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
    // キーワードなしかつ note のみ検索なので、キーワードがある場合のみ note でフィルタ
    if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
    if (from)    { sql += ` AND ir.inspected_at >= ?`; binds.push(from); }
    if (to)      { sql += ` AND ir.inspected_at <= ?`; binds.push(to + 'T23:59:59Z'); }
    if (equipId) { sql += ` AND ir.equipment_id = ?`;  binds.push(equipId); }
    // キーワードも設備も期間もなければスキップ（全件は多すぎる）
    if (!keywords.length && !from && !to && !equipId) {
      // no-op: skip
    } else {
      sql += ` ORDER BY ir.inspected_at DESC LIMIT ${limit}`;
      const { results: rows } = await db.prepare(sql).bind(...binds).all();
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
