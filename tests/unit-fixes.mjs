// 単体テスト: 部品数量の上限・識別番号の列が使えないときの入出庫・列の自動追加の再試行・設備一覧の limit
//   schema.sql を node:sqlite に流し込み、D1 と同じ形の薄いラッパー越しに API を直接呼ぶ。
//   実行: node --experimental-sqlite unit-fixes.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { ensureColumns } = await load('functions/api/_lib/db-compat.js');
const tx = await load('functions/api/parts/[id]/transaction.js');
const eq = await load('functions/api/equipment/index.js');
const partsApi = await load('functions/api/parts/index.js');

function makeDb({ failAlter = 0 } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
    const t = st.replace(/^\s*--.*$/mg, '').trim();
    if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
  }
  let alterFailures = failAlter;
  const wrap = (sql, args = []) => ({
    bind(...a) { return wrap(sql, a.map((x) => (x === undefined ? null : x))); },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() {
      if (/^\s*(ALTER|CREATE UNIQUE INDEX)/i.test(sql) && alterFailures > 0) { alterFailures--; throw new Error('D1_ERROR: temporary failure'); }
      const r = sqlite.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec() {
      const s = sqlite.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: s.all(...args), meta: { changes: 0 } };
      const r = s.run(...args);
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    sqlite,
    prepare: (sql) => wrap(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try { const out = list.map((s) => s._exec()); sqlite.exec('COMMIT'); return out; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const req = (body) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const user = { email: 'e@example.com', role: 'editor', name: 'E' };
const post = (db, id, body) => tx.onRequestPost({ env: { DB: db }, data: { user }, params: { id: String(id) }, request: req(body), waitUntil: () => {} });

console.log('\n=== 単体: 数量の上限・列の自動追加の再試行・設備一覧の limit ===');

// --- L7: 識別番号の列が作れない環境（ensureColumns は1プロセスで成功をキャッシュするため、最初に試す） ---
{
  // 識別番号の列が作れない環境でも入出庫は止まらない
  const db = makeDb({ failAlter: 99 });
  db.sqlite.exec(`DROP INDEX IF EXISTS idx_parts_transaction_client_tx`);
  db.sqlite.exec(`ALTER TABLE parts_transaction DROP COLUMN client_tx_id`);
  db.sqlite.exec(`INSERT INTO parts_inventory (part_no, name, quantity, safety_stock, created_by) VALUES ('p1', '部品A', 10, 0, 't')`);
  const out = await post(db, 1, { type: 'out', quantity: 3, client_tx_id: 'abcdef12-3456' });
  const adj = await post(db, 1, { type: 'adjust', quantity: 20, client_tx_id: 'abcdef12-9999' });
  const q = db.sqlite.prepare('SELECT quantity q FROM parts_inventory WHERE id=1').get().q;
  const hist = db.sqlite.prepare('SELECT COUNT(*) n FROM parts_transaction').get().n;
  ok('client_tx_id 列が無く追加もできなくても、出庫・棚卸調整は記録できる', out.status === 200 && adj.status === 200 && q === 20 && hist === 2, `${out.status}/${adj.status}/${q}/${hist}`);
}

// --- L6: 数量の上限 ---
{
  const db = makeDb();
  db.sqlite.exec(`INSERT INTO parts_inventory (part_no, name, quantity, safety_stock, created_by) VALUES ('p1', '部品A', 10, 0, 't')`);
  let res = await post(db, 1, { type: 'in', quantity: 1_000_001 });
  ok('入庫の数量が100万を超えると400（在庫は変わらない）', res.status === 400 && db.sqlite.prepare('SELECT quantity q FROM parts_inventory WHERE id=1').get().q === 10);
  res = await post(db, 1, { type: 'adjust', quantity: 99_999_999 });
  ok('棚卸調整の数量が100万を超えると400', res.status === 400);
  res = await post(db, 1, { type: 'in', quantity: 1_000_000 });
  ok('ちょうど100万までは受け付ける', res.status === 200);
  const created = await partsApi.onRequestPost({ env: { DB: db }, data: { user }, request: req({ name: '部品B', quantity: 2_000_000 }) });
  ok('部品の登録で在庫数が100万を超えると400', created.status === 400);
}

// --- L7: 列の自動追加の再試行 ---
{
  const db = makeDb({ failAlter: 1 });
  const first = await ensureColumns(db, 'unit_retry', ['CREATE TABLE IF NOT EXISTS unit_t (a INTEGER)', 'ALTER TABLE parts_inventory ADD COLUMN unit_x INTEGER']);
  const second = await ensureColumns(db, 'unit_retry', ['CREATE TABLE IF NOT EXISTS unit_t (a INTEGER)', 'ALTER TABLE parts_inventory ADD COLUMN unit_x INTEGER']);
  const cols = db.sqlite.prepare('PRAGMA table_info(parts_inventory)').all().map((c) => c.name);
  ok('一時的に失敗しても、次の呼び出しで列を追加し直す', first === false && second === true && cols.includes('unit_x'), `${first}/${second}`);
  const bad = makeDb({ failAlter: 99 });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await ensureColumns(bad, 'unit_giveup', ['ALTER TABLE parts_inventory ADD COLUMN unit_y INTEGER']));
  ok('失敗し続けても再試行は3回で諦め、false を返す', results.every((r) => r === false));
}
// --- L8: 設備一覧の limit ---
{
  const db = makeDb();
  const ins = db.sqlite.prepare(`INSERT INTO equipment_ledger (code, name, created_by) VALUES (?, ?, 't')`);
  for (let i = 0; i < 350; i++) ins.run(`C-${String(i).padStart(4, '0')}`, `設備${i}`);
  const get = async (qs) => (await eq.onRequestGet({ request: new Request(`http://x/api/equipment${qs}`), env: { DB: db } })).json();
  let r = await get('');
  ok('既定は300件で truncated:true', r.equipment.length === 300 && r.truncated === true);
  r = await get('?limit=2000');
  ok('limit=2000 なら350件すべて返し truncated:false', r.equipment.length === 350 && r.truncated === false);
  r = await get('?limit=-1');
  ok('limit=-1 は無制限にならず下限1に丸める', r.equipment.length === 1);
  r = await get('?limit=999999');
  ok('limit の上限は2000', r.limit === 2000);
}

console.log(`\n========== 単体（数量上限・列再試行・設備limit）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
