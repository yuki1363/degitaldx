// 単体テスト: 年度リセット（functions/api/plans/annual-reset.js）
//   plan_reset_log が無い古いDBで「no such table: plan_reset_log」になって、リセットできなかった不具合の再発防止。
//   schema.sql を node:sqlite のメモリDBに流し、plan_reset_log を消した状態でリセットを呼ぶ。
//   実行: node --experimental-sqlite unit-annual-reset.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { onRequestPost } = await import(pathToFileURL(path.join(ROOT, 'functions/api/plans/annual-reset.js')).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 年度リセット（履歴の表が無い古いDB） ===');

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
db.exec('DROP TABLE plan_reset_log'); // この表を足す前に作られたDB
db.prepare(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, annual_only, created_by) VALUES ('E2E年間A', 'inspection', '2025-10-01', 'done', 1, 'a@x')`).run();
db.prepare(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, annual_only, created_by) VALUES ('E2E年間B', 'inspection', '2025-11-01', 'done', 1, 'a@x')`).run();

const realNow = Date.now;
Date.now = () => new Date('2026-11-11T03:00:00Z').getTime(); // 2026年11月＝リセットで締めるのは FY2025
const call = (body) => onRequestPost({
  request: new Request('http://x/api/plans/annual-reset', { method: 'POST', body: JSON.stringify(body) }),
  env: { DB: d1(db) }, data: { user: { email: 'admin@x', role: 'admin' } },
});
try {
  const res = await call({ fiscal_year: 2025, csv_snapshot: 'a,b\n1,2' });
  const j = await res.json().catch(() => ({}));
  ok('履歴の表が無くてもリセットできる（200）', res.status === 200 && j.ok === true && j.fiscal_year === 2025, `${res.status} ${JSON.stringify(j)}`);
  ok('完了だった2件が未実施に戻る', j.reset_count === 2 && db.prepare(`SELECT COUNT(*) n FROM maintenance_plan WHERE status = 'pending'`).get().n === 2, JSON.stringify(j));
  const log = db.prepare('SELECT fiscal_year, plan_count, csv_snapshot FROM plan_reset_log').all();
  ok('履歴（FY2025・件数・CSV）が記録される', log.length === 1 && log[0].fiscal_year === 2025 && log[0].plan_count === 2 && log[0].csv_snapshot === 'a,b\n1,2', JSON.stringify(log));
  const res2 = await call({ fiscal_year: 2025 });
  ok('同じ年度をもう一度は409（二重実行しない）', res2.status === 409, `status=${res2.status}`);
  const audit = db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE table_name = 'maintenance_plan' AND record_id = 'annual_reset'`).get().n;
  ok('監査ログに1回ぶんだけ残る', audit === 1, `n=${audit}`);
} finally { Date.now = realNow; }

console.log(`\n========== 単体（年度リセット）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
