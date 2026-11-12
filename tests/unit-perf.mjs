// 単体テスト: 読み取り行数を減らす仕組み（索引の自動作成・部品の版・カレンダーの検索範囲・通知の遅延集計）
//   実行: node --experimental-sqlite unit-perf.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { PERF_INDEX_SQL, ensurePerfIndexes } = await load('functions/api/_lib/perf-indexes.js');
const { partsListVersion, partsDetailVersion } = await load('functions/api/_lib/parts-version.js');
const partsList = await load('functions/api/parts/index.js');
const partsOne = await load('functions/api/parts/[id].js');
const partsTx = await load('functions/api/parts/[id]/transaction.js');
const plansApi = await load('functions/api/plans/index.js');
const notifApi = await load('functions/api/notifications/index.js');

const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const sqlite = new DatabaseSync(':memory:');
const applySchema = (db, skipPerf = false) => {
  for (const st of schema.split(/;\s*(?:\n|$)/)) {
    const t = st.replace(/^\s*--.*$/mg, '').trim();
    if (!t) continue;
    if (skipPerf && /^CREATE INDEX IF NOT EXISTS (idx_chat_messages_pinned|idx_notifications_created|idx_notifications_related|idx_inspection_result_inspected|idx_maintenance_plan_end|idx_audit_log_table_action|idx_parts_inventory_updated)\b/.test(t)) continue;
    try { db.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
};
applySchema(sqlite);

const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
function d1(raw) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, norm(a)),
    async first() { return raw.prepare(sql).get(...args) ?? null; },
    async all() { return { results: raw.prepare(sql).all(...args) }; },
    async run() { const r = raw.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    _exec() {
      const s = raw.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: s.all(...args), meta: { changes: 0 } };
      const r = s.run(...args);
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => wrap(sql),
    async batch(list) {
      raw.exec('BEGIN');
      try { const out = list.map((s) => s._exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}
const db = d1(sqlite);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const user = (role = 'editor') => ({ email: `${role}@x`, role });

console.log('\n=== 単体: 性能索引（自動作成） ===');
{
  const old = new DatabaseSync(':memory:'); // 索引が無い古いDB
  applySchema(old, true);
  const names = (r) => r.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((x) => x.name);
  const before = names(old);
  ok('古いDBには性能索引がまだ無い', !before.includes('idx_notifications_created') && !before.includes('idx_audit_log_table_action'));
  const res = await ensurePerfIndexes(d1(old));
  const after = names(old);
  ok('ensurePerfIndexes が全部の索引を作る（API の入口で1回）', res === true && PERF_INDEX_SQL.every((s) => after.includes(/idx_\w+/.exec(s)[0])), after.filter((n) => /pinned|created|related|inspected|_end|table_action|updated/.test(n)).join(','));
  ok('もう一度呼んでも失敗しない（IF NOT EXISTS）', (await ensurePerfIndexes(d1(old))) === true);
  ok('schema.sql の末尾にも同じ索引がある（新規DB用）', PERF_INDEX_SQL.every((s) => schema.includes(s.replace(/^\s+|\s+$/g, ''))));
}

console.log('\n=== 単体: 部品の「版」（変わったときだけ取り直すため） ===');
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, quantity, safety_stock, created_by, created_at, updated_at) VALUES ('p1', 'ベアリング', 10, 2, 't', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'), ('p2', 'ベルト', 5, 2, 't', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
const v0 = await partsListVersion(db);
ok('何も変わらなければ版は同じ', (await partsListVersion(db)) === v0);
const tx = (id, body) => partsTx.onRequestPost({ env: { DB: db }, data: { user: user() }, params: { id: String(id) }, request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), waitUntil: () => {} });
await tx(1, { type: 'out', quantity: 1, client_tx_id: 'perf-tx-0001' });
const v1 = await partsListVersion(db);
ok('入出庫があると版が変わる', v1 !== v0, `${v0} → ${v1}`);
// 同じ秒に2回入出庫しても、入出庫の最新IDが変わるので見逃さない
await tx(1, { type: 'out', quantity: 1, client_tx_id: 'perf-tx-0002' });
ok('同じ秒の2回目の入出庫でも版が変わる（更新日時は秒精度のため、履歴の最新IDでも見る）', (await partsListVersion(db)) !== v1);
const v2 = await partsListVersion(db);
// 実際の編集は updated_at に「いま」を入れる（＝それまでの最大より新しい）。テストでも同じにする
const later = (min) => new Date(Date.now() + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
sqlite.exec(`UPDATE parts_inventory SET name = 'ベアリング改', updated_at = '${later(1)}' WHERE id = 2`);
ok('部品の編集で版が変わる', (await partsListVersion(db)) !== v2);
const v3 = await partsListVersion(db);
sqlite.exec(`UPDATE parts_inventory SET deleted_at = '${later(2)}', updated_at = '${later(2)}' WHERE id = 2`);
ok('部品の削除で版が変わる', (await partsListVersion(db)) !== v3);
const d0 = await partsDetailVersion(db, 1);
ok('詳細の版は、その部品に変更が無ければ同じ', (await partsDetailVersion(db, 1)) === d0);
await tx(1, { type: 'in', quantity: 3, client_tx_id: 'perf-tx-0003' });
ok('その部品の入庫で詳細の版が変わる', (await partsDetailVersion(db, 1)) !== d0);
const dOther = await partsDetailVersion(db, 2);
await tx(1, { type: 'in', quantity: 1, client_tx_id: 'perf-tx-0004' });
ok('別の部品の入出庫では、この部品の詳細の版は変わらない', (await partsDetailVersion(db, 2)) === dOther);
const listRes = await (await partsList.onRequestGet({ env: { DB: db }, request: new Request('http://x/api/parts?version=1') })).json();
ok('GET /api/parts?version=1 は版だけを返す（一覧は読まない）', typeof listRes.version === 'string' && listRes.parts === undefined);
const fullRes = await (await partsList.onRequestGet({ env: { DB: db }, request: new Request('http://x/api/parts') })).json();
ok('通常の一覧にも版が付く（一覧を読む前の版）', Array.isArray(fullRes.parts) && fullRes.version === (await partsListVersion(db)));
const oneRes = await (await partsOne.onRequestGet({ env: { DB: db }, params: { id: '1' }, request: new Request('http://x/api/parts/1?version=1') })).json();
ok('GET /api/parts/:id?version=1 も版だけを返す', typeof oneRes.version === 'string' && oneRes.part === undefined);

console.log('\n=== 単体: カレンダーの検索（旧クエリと同じ結果で、索引を使う） ===');
{
  const dayStr = (n) => new Date(Date.UTC(2025, 0, 1) + n * 864e5).toISOString().slice(0, 10);
  const ins = sqlite.prepare(`INSERT INTO maintenance_plan (title, plan_type, planned_date, planned_end_date, status, created_by, deleted_at) VALUES (?, 'inspection', ?, ?, 'pending', 't', ?)`);
  let seed = 4242; const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let i = 0; i < 3000; i++) {
    const s = rnd(900); const kind = rnd(4);
    ins.run(`p${i}`, dayStr(s), kind === 0 ? dayStr(s + rnd(20)) : kind === 1 ? null : kind === 2 ? '' : dayStr(s), rnd(15) === 0 ? '2026-01-01T00:00:00Z' : null);
  }
  const oldQ = `SELECT id FROM maintenance_plan p WHERE p.deleted_at IS NULL AND p.planned_date < ? AND COALESCE(p.planned_end_date, p.planned_date) >= ? ORDER BY p.planned_date ASC, p.id ASC`;
  let bad = 0; let checked = 0;
  for (let k = 0; k < 120; k++) {
    const a = dayStr(rnd(1000) - 50); const b = dayStr(rnd(1000) - 50 + 1);
    const lo = a < b ? a : b; const hi = a < b ? b : a;
    const want = sqlite.prepare(oldQ).all(hi, lo).map((r) => r.id).join(',');
    const res = await (await plansApi.onRequestGet({ env: { DB: db }, request: new Request(`http://x/api/plans?from=${lo}&to=${hi}`) })).json();
    // 年間計画専用・日付未定はカレンダーに出さない（API の従来の絞り込み）。このデータには無いので件数は一致する
    const got = res.plans.map((p) => p.id).join(',');
    checked++; if (want !== got) bad++;
  }
  ok(`ランダムな期間 ${checked} 通りで、旧クエリと同じ予定が同じ順で返る（単日・複数日・終了日が空・削除済みを含む）`, bad === 0, `不一致 ${bad}`);
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT * FROM (SELECT p.* FROM maintenance_plan p WHERE p.deleted_at IS NULL AND p.planned_end_date IS NULL AND p.planned_date >= ?1 AND p.planned_date < ?2 UNION ALL SELECT p.* FROM maintenance_plan p WHERE p.deleted_at IS NULL AND p.planned_end_date IS NOT NULL AND p.planned_end_date >= ?1 AND +p.planned_date < ?2) ORDER BY planned_date ASC, id ASC`).all('2026-10-01', '2026-11-01').map((r) => r.detail).join(' | ');
  ok('単日は予定日の索引を、複数日は終了日の索引を使う（表を全部読まない）', /idx_maintenance_plan_date \(planned_date>\? AND planned_date<\?\)/.test(plan) && /idx_maintenance_plan_end/.test(plan), plan);
}

console.log('\n=== 単体: 通知の選択肢（facets）は頼まれたときだけ集計する ===');
{
  sqlite.exec(`INSERT INTO notifications (type, level, title, created_by) VALUES ('trouble', 'info', 'a', 'x@x'), ('trouble', 'info', 'b', 'y@x')`);
  const call = async (qs) => (await (await notifApi.onRequestGet({ request: new Request(`http://x/api/notifications${qs}`), env: { DB: db }, waitUntil: () => {} })).json());
  const home = await call('?limit=8');
  ok('ホームのベル（facets 指定なし）は選択肢を集計しない', home.facets === undefined && home.notifications.length >= 2 && home.unread_count >= 2);
  const page = await call('?limit=50&facets=1');
  const emails = (page.facets?.assignees || []).map((a) => a.email);
  ok('通知画面（facets=1）は月・担当者の選択肢を返す', Array.isArray(page.facets?.months) && page.facets.months.length >= 1 && emails.includes('x@x') && emails.includes('y@x'), JSON.stringify(page.facets));
}

console.log(`\n========== 単体（読み取り節約）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
