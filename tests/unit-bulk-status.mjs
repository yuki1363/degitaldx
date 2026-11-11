// 単体テスト: 年間計画のまとめて完了（functions/api/plans/bulk-status.js）
//   実行: node --experimental-sqlite unit-bulk-status.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { onRequestPost } = await import(pathToFileURL(path.join(ROOT, 'functions/api/plans/bulk-status.js')).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 年間計画のまとめて完了 ===');

const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
function d1(db) {
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(sql).get(...norm(args)) ?? null; },
        async all() { return { results: db.prepare(sql).all(...norm(args)) }; },
        async run() { const r = db.prepare(sql).run(...norm(args)); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
      return stmt;
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const st of stmts) out.push(await st.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
const ins = db.prepare(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, annual_only, recurrence_rule, created_by) VALUES (?, 'inspection', '2026-11-01', ?, 1, ?, 'a@x')`);
const id = (t, st, rule = null) => Number(ins.run(t, st, rule).lastInsertRowid);
const a = id('A', 'pending'), b = id('B', 'pending'), c = id('C', 'done'), r = id('R', 'pending', '{"freq":"monthly","interval":1}');
db.prepare(`UPDATE maintenance_plan SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(id('D', 'pending'));
const dead = Number(db.prepare(`SELECT id FROM maintenance_plan WHERE title = 'D'`).get().id);

const call = (body, role = 'editor') => onRequestPost({
  request: new Request('http://x/api/plans/bulk-status', { method: 'POST', body: JSON.stringify(body) }),
  env: { DB: d1(db) }, data: { user: { email: 'e@x', role } },
});
const st = (n) => db.prepare('SELECT status FROM maintenance_plan WHERE id = ?').get(n).status;

let res = await call({ ids: [a, b, c, r, dead], status: 'done' });
let j = await res.json();
ok('選んだ未実施がまとめて完了になる（A・B）', res.status === 200 && st(a) === 'done' && st(b) === 'done', JSON.stringify(j));
ok('すでに完了・繰り返し予定・削除済みは変えず、skipped に数える', j.updated === 2 && j.skipped === 3 && st(r) === 'pending' && st(dead) === 'pending', JSON.stringify(j));
const audits = db.prepare(`SELECT record_id, diff_json FROM audit_log WHERE table_name = 'maintenance_plan' ORDER BY id`).all();
ok('監査ログに変更した2件ぶんだけ、変更前→後つきで残る', audits.length === 2 && audits.every((x) => { const d = JSON.parse(x.diff_json); return d.status.from === 'pending' && d.status.to === 'done' && d.bulk === true; }), JSON.stringify(audits));
res = await call({ ids: [a, b], status: 'pending' });
j = await res.json();
ok('未実施に戻せる', j.updated === 2 && st(a) === 'pending' && st(b) === 'pending', JSON.stringify(j));
res = await call({ ids: [a], status: 'overdue' });
ok('status は done / pending だけ（それ以外は400）', res.status === 400);
res = await call({ ids: [], status: 'done' });
ok('ids が空は400', res.status === 400);
res = await call({ ids: Array.from({ length: 101 }, (_, i) => i + 1), status: 'done' });
ok('101件以上は400（上限100件）', res.status === 400);
res = await call({ ids: ['x'], status: 'done' });
ok('数値でない ids は400', res.status === 400);
res = await call({ ids: [a], status: 'done' }, 'viewer');
ok('閲覧のみは403', res.status === 403, `status=${res.status}`);

console.log(`\n========== 単体（まとめて完了）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
