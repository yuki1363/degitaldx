// 単体テスト: 二重登録の防止（client_request_id。functions/api/_lib/request-dedupe.js と各登録API）
//   「登録できたのに返事が届かず、送信待ちから再送された」場面を再現し、同じ記録が2件できないことを確かめる。
//   実行: node --experimental-sqlite unit-dedupe.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const troubles = await load('functions/api/troubles/index.js');
const inspections = await load('functions/api/inspections/index.js');
const repairs = await load('functions/api/repairs/index.js');
const reports = await load('functions/api/reports/index.js');
const utility = await load('functions/api/utility-reports/index.js');

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, norm(a)),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
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

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const count = (table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

sqlite.exec(`INSERT INTO users (email, name, role, created_by) VALUES ('ed@x', '入力者', 'editor', 't')`);
const userRow = sqlite.prepare(`SELECT id, email, name, role FROM users WHERE email = 'ed@x'`).get();
sqlite.exec(`INSERT INTO equipment_ledger (code, name, created_by) VALUES ('01-01', 'ポンプ', 't')`);
sqlite.exec(`INSERT INTO inspection_master (equipment_id, name, input_type, sort_order, created_by) VALUES (1, '外観', 'ok_ng', 1, 't')`);
const call = (mod, body, key) => mod.onRequestPost({
  env: { DB: db }, data: { user: userRow }, waitUntil: () => {},
  request: new Request('http://x/api', { method: 'POST', body: JSON.stringify(key === undefined ? body : { ...body, client_request_id: key }) }),
});
const j = async (res) => ({ status: res.status, body: await res.json() });

const KINDS = {
  trouble_record: [troubles, { occurred_at: '2026-11-01T01:00:00Z', phenomenon: '異音' }],
  inspection_result: [inspections, { equipment_id: 1, inspected_at: '2026-11-01T01:00:00Z', items: [{ master_id: 1, value: 'ok' }] }],
  repair_request: [repairs, { title: '修理依頼' }],
  daily_report: [reports, { report_date: '2026-11-01', body: '日報' }],
  utility_report: [utility, { report_date: '2026-11-01', values: {} }],
};

console.log('\n=== 単体: 二重登録の防止（同じ識別番号は1件だけ） ===');
let n = 0;
for (const [table, [mod, body]] of Object.entries(KINDS)) {
  const key = `unit-key-${table.replace(/_/g, '-')}-0001`;
  const a = await j(await call(mod, body, key));
  const b = await j(await call(mod, body, key)); // 返事が届かず再送された
  ok(`${table}: 1回目は登録（201）`, a.status === 201 && Number.isInteger(a.body.id), JSON.stringify(a));
  ok(`${table}: 同じ番号の再送は作らず、最初の記録のIDを返す（duplicate:true）`, b.status === 200 && b.body.duplicate === true && b.body.id === a.body.id, JSON.stringify(b));
  ok(`${table}: 記録は1件だけ`, count(table) === 1, `n=${count(table)}`);
  const rec = sqlite.prepare(`SELECT kind, record_id FROM request_dedupe WHERE client_request_id = ?`).get(key);
  ok(`${table}: 番号の表に、この記録のIDで残る`, rec?.kind === table && rec.record_id === a.body.id, JSON.stringify(rec));
  n++;
}
// 監査ログの記録IDがずれない（番号を挟んでも、監査ログは登録した記録のIDを指す）
const tId = sqlite.prepare(`SELECT id FROM trouble_record`).get().id;
const tAudit = sqlite.prepare(`SELECT record_id FROM audit_log WHERE table_name = 'trouble_record' AND action = 'create'`).all();
ok('トラブル: 監査ログの record_id が登録した記録のIDと一致する（識別番号の行のIDにずれない）', tAudit.length === 1 && tAudit[0].record_id === tId, JSON.stringify({ tId, tAudit }));
ok('点検: 再送されても通知・異常判定の応答を返す（has_abnormal）', typeof (await j(await call(inspections, KINDS.inspection_result[1], 'unit-key-inspection-result-0001'))).body.has_abnormal === 'boolean');

console.log('\n=== 単体: 番号なし・不正な番号・別の種類 ===');
const before = count('repair_request');
await call(repairs, { title: 'A' }); await call(repairs, { title: 'A' });
ok('番号が付いていない呼び出しは従来どおり（同じ内容でも別々に登録される）', count('repair_request') === before + 2);
const bad = await j(await call(repairs, { title: 'B' }, 'x'));
ok('番号の形式が不正なら 400', bad.status === 400 && /client_request_id/.test(bad.body.error.message), JSON.stringify(bad));
const mixed = await j(await call(repairs, { title: 'C' }, 'unit-key-trouble-record-0001'));
ok('別の種類の記録に使った番号は 409（画面のバグを黙って通さない）', mixed.status === 409, JSON.stringify(mixed));

console.log('\n=== 単体: 同時に2回届いた場合（確認のすき間をすり抜けても2件にならない） ===');
{
  // 他のリクエストが先に登録を終えているが、このリクエストの「登録済みか」の確認はまだ空だった、という状況を作る
  const existing = await j(await call(KINDS.repair_request[0], { title: '先に登録' }, 'unit-key-race-0001'));
  let hidden = true;
  const raceDb = {
    ...db,
    prepare: (sql) => {
      if (hidden && /FROM request_dedupe WHERE client_request_id/.test(sql)) {
        hidden = false;
        return { bind: () => ({ first: async () => null }) };
      }
      return db.prepare(sql);
    },
  };
  const nBefore = count('repair_request');
  const res = await j(await repairs.onRequestPost({
    env: { DB: raceDb }, data: { user: userRow }, waitUntil: () => {},
    request: new Request('http://x/api', { method: 'POST', body: JSON.stringify({ title: '後から届いた同じ登録', client_request_id: 'unit-key-race-0001' }) }),
  }));
  ok('確認をすり抜けても、登録は丸ごと取り消され、先の記録のIDを返す', res.status === 200 && res.body.duplicate === true && res.body.id === existing.body.id, JSON.stringify(res));
  ok('記録は増えない（途中まで登録された行が残らない）', count('repair_request') === nBefore);
  const orphan = sqlite.prepare(`SELECT COUNT(*) AS n FROM repair_history WHERE request_id NOT IN (SELECT id FROM repair_request)`).get().n;
  ok('履歴だけが残る、といった中途半端な状態にならない', orphan === 0);
}

console.log('\n=== 単体: ユーティリティ日報は1日1件ガードより先に番号を見る ===');
{
  const first = await j(await call(utility, { report_date: '2026-11-05', values: {} }, 'unit-key-util-day-0001'));
  const retry = await j(await call(utility, { report_date: '2026-11-05', values: {} }, 'unit-key-util-day-0001'));
  ok('再送は「すでに登録されています(409)」ではなく、成功（duplicate:true）として返る', first.status === 201 && retry.status === 200 && retry.body.duplicate === true && retry.body.id === first.body.id, JSON.stringify({ first, retry }));
  const other = await j(await call(utility, { report_date: '2026-11-05', values: {} }, 'unit-key-util-day-0002'));
  ok('別の番号で同じ日を登録しようとすると、従来どおり 409（1日1件）', other.status === 409, JSON.stringify(other));
  const k = sqlite.prepare(`SELECT COUNT(*) AS n FROM request_dedupe WHERE client_request_id = 'unit-key-util-day-0002'`).get().n;
  ok('409 になった登録の番号は記録されない（あとで正しく登録し直せる）', k === 0);
}

console.log(`\n========== 単体（二重登録の防止）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
