// 単体テスト: 細かい不具合の修正（不正な日付での500・LIKEのワイルドカード・監査ログのoffset・削除済み設備番号の案内）
//   実行: node --experimental-sqlite unit-small-fixes.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const util = await load('functions/api/_lib/util.js');
const fuzzy = await load('functions/api/_lib/fuzzy.js');
const audit = await load('functions/api/admin/audit/index.js');
const equip = await load('functions/api/equipment/index.js');
const equipId = await load('functions/api/equipment/[id].js');
const plans = await load('functions/api/plans/index.js');
const reports = await load('functions/api/reports/index.js');
const repairs = await load('functions/api/repairs/index.js');

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
sqlite.exec(`INSERT INTO users (email, name, role, created_by) VALUES ('admin@x','管理者','admin','t')`);
const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, norm(a)),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args), meta: {} }; },
  async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  _exec() {
    const s = sqlite.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: s.all(...args), meta: { changes: 0 } };
    const r = s.run(...args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const db = {
  prepare: (sql) => wrap(sql),
  async batch(list) {
    sqlite.exec('BEGIN');
    try { const out = list.map((s) => s._exec()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
const user = { id: 1, email: 'admin@x', name: '管理者', role: 'admin' };
const call = async (fn, url, body, params = {}) => {
  const res = await fn({ request: new Request(`http://x${url}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined), env: { DB: db }, data: { user }, params, waitUntil() {} });
  return { status: res.status, json: await res.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== 単体: 存在しない日付で例外にならない ===');
let threw = false;
try { util.jstDayStartUtc('2026-13-45'); util.jstNextDayStartUtc('2026-13-45'); util.jstDayStartUtc('2026-02-31'); } catch { threw = true; }
ok('jstDayStartUtc／jstNextDayStartUtc は存在しない日付でも例外にしない（500にならない）', !threw);
ok('正しい日付は従来どおり JST の境界に変換する', util.jstDayStartUtc('2026-10-27') === '2026-10-26T15:00:00Z' && util.jstNextDayStartUtc('2026-10-27') === '2026-10-27T15:00:00Z');
ok('isValidYmd: 実在する日付だけ true', util.isValidYmd('2026-02-28') && util.isValidYmd('2028-02-29') && !util.isValidYmd('2026-02-29') && !util.isValidYmd('2026-13-01') && !util.isValidYmd('2026-02-31') && !util.isValidYmd('abc') && !util.isValidYmd('2026-1-1') && !util.isValidYmd(null) && !util.isValidYmd(20260101));
for (const [label, fn, url] of [
  ['監査ログ', audit.onRequestGet, '/api/admin/audit?from=2026-13-45&to=2026-99-99'],
]) {
  const r = await call(fn, url);
  ok(`${label}: 期間に存在しない日付を指定しても200（500にならない）`, r.status === 200, `status=${r.status}`);
}

console.log('\n=== 単体: 監査ログの offset（小数・桁あふれ・負・文字）で500にならない ===');
for (const off of ['1.5', '1e30', '-5', 'abc', '99999999999999999999']) {
  const r = await call(audit.onRequestGet, `/api/admin/audit?offset=${off}&limit=2.5`);
  ok(`offset=${off} でも200`, r.status === 200 && Number.isInteger(r.json?.offset) && r.json.offset >= 0, `status=${r.status} offset=${r.json?.offset}`);
}

console.log('\n=== 単体: 検索語の % _ はワイルドカードではなく文字として探す ===');
ok('escapeLike は % _ \\ を退避する', util.escapeLike('100%_a\\b') === '100\\%\\_a\\\\b');
sqlite.exec(`CREATE TABLE lk (id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO lk (name) VALUES ('進捗100%'), ('進捗1000'), ('A_1号機'), ('AB1号機'), ('通常の部品');`);
const searchLk = (kw) => {
  const { clauses, binds } = fuzzy.buildKeywordClauses([kw], ['name']);
  return sqlite.prepare(`SELECT name FROM lk WHERE ${clauses.join(' AND ')} ORDER BY id`).all(...binds).map((r) => r.name);
};
ok('「%」で検索しても全件ではなく、%を含む行だけ（あいまい検索の共通部分）', JSON.stringify(searchLk('%')) === JSON.stringify(['進捗100%']), JSON.stringify(searchLk('%')));
ok('「100%」は「進捗1000」に一致しない', JSON.stringify(searchLk('100%')) === JSON.stringify(['進捗100%']));
ok('「A_1」の _ は任意の1文字ではなく文字そのもの（「AB1号機」に一致しない）', JSON.stringify(searchLk('A_1')) === JSON.stringify(['A_1号機']), JSON.stringify(searchLk('A_1')));
ok('ふつうの語は従来どおり部分一致', JSON.stringify(searchLk('部品')) === JSON.stringify(['通常の部品']));

// 設備一覧の検索・日報の記録者検索・監査ログのユーザー検索でも同じ
sqlite.exec(`INSERT INTO equipment_ledger (code, name, created_by) VALUES ('EQ-1', 'ポンプ100%', 't'), ('EQ-2', 'ポンプ1000', 't')`);
const eqList = await call(equip.onRequestGet, '/api/equipment?q=' + encodeURIComponent('100%'));
ok('設備一覧の検索: 「100%」は「ポンプ1000」に一致しない', eqList.status === 200 && eqList.json?.equipment?.length === 1 && eqList.json.equipment[0].code === 'EQ-1', JSON.stringify(eqList.json).slice(0, 120));
sqlite.exec(`INSERT INTO daily_report (reporter_id, report_date, body, reporter_name, created_by) VALUES (1, '2026-10-01', 'x', '山_田', 't'), (1, '2026-10-02', 'y', '山本田', 't')`);
const rp = await call(reports.onRequestGet, '/api/reports?reporter=' + encodeURIComponent('山_田'));
ok('日報の記録者検索: _ は任意の1文字ではない', rp.status === 200 && rp.json?.reports?.length === 1 && rp.json.reports[0].reporter_name === '山_田', JSON.stringify(rp.json).slice(0, 120));

console.log('\n=== 単体: 設備番号が重複したときの案内（削除済み設備が原因のとき） ===');
sqlite.exec(`INSERT INTO equipment_ledger (code, name, line_name, created_by, deleted_at, deleted_by) VALUES ('X-01', '旧コンベア', 'ライン', 't', '2026-01-01T00:00:00Z', 't')`);
const dup = await call(equip.onRequestPost, '/api/equipment', { code: 'X-01', name: '新コンベア' });
ok('削除済みの設備と同じ番号で登録 → 409 で「削除済みの設備」と原因を示す', dup.status === 409 && /削除済み/.test(dup.json?.error?.message || '') && /旧コンベア/.test(dup.json.error.message) && /削除済み/.test(dup.json.error.message), JSON.stringify(dup.json));
const liveDup = await call(equip.onRequestPost, '/api/equipment', { code: 'EQ-1', name: '別の設備' });
ok('使用中の設備と同じ番号 → 409 で、その設備名を示す（削除済みとは書かない）', liveDup.status === 409 && /ポンプ100%/.test(liveDup.json?.error?.message || '') && !/削除済み/.test(liveDup.json.error.message), JSON.stringify(liveDup.json));
const live = sqlite.prepare(`SELECT id FROM equipment_ledger WHERE code = 'EQ-2'`).get();
const putDup = await call(equipId.onRequestPut, `/api/equipment/${live.id}`, { code: 'X-01', name: 'ポンプ1000' }, { id: String(live.id) });
ok('設備番号を削除済みの設備の番号へ変更 → 409 で「削除済みの設備」', putDup.status === 409 && /削除済み/.test(putDup.json?.error?.message || ''), JSON.stringify(putDup.json));

console.log('\n=== 単体: 日付だけの入力は実在する日付だけ保存する ===');
const badDates = ['2026-13-45', '2026-02-31', 'abc'];
for (const d of badDates) {
  const p = await call(plans.onRequestPost, '/api/plans', { title: 'x', plan_type: 'inspection', planned_date: d });
  ok(`保全計画: 予定日「${d}」は400`, p.status === 400, `status=${p.status}`);
}
const p2 = await call(plans.onRequestPost, '/api/plans', { title: 'x', plan_type: 'inspection', planned_date: '2026-10-01', planned_end_date: '2026-10-99' });
ok('保全計画: 終了日が存在しない日付なら400', p2.status === 400);
const p3 = await call(plans.onRequestPost, '/api/plans', { title: 'x', plan_type: 'inspection', planned_date: '2026-10-01', planned_end_date: '2026-10-03' });
ok('保全計画: 正しい日付は登録できる', p3.status === 201, `status=${p3.status}`);
const r1 = await call(reports.onRequestPost, '/api/reports', { report_date: '2026-13-45', body: 'x' });
ok('日報: 存在しない日付は400', r1.status === 400);
const r2 = await call(repairs.onRequestPost, '/api/repairs', { title: 'x', due_date: '2026-02-31' });
ok('業務依頼: 存在しない対応期限は400', r2.status === 400);
const r3 = await call(repairs.onRequestPost, '/api/repairs', { title: 'x', due_date: '2026-02-28' });
ok('業務依頼: 正しい対応期限は登録できる', r3.status === 201, `status=${r3.status}`);

console.log(`\n========== 単体（細かい不具合の修正）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
