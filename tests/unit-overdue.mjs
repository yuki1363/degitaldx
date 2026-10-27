// 単体テスト: 期限超過・未印刷の通知（functions/api/_lib/overdue-notify.js）
//   1時間に1回しか動かないチェックのため E2E では2回目を起こせない。ここでは schema.sql を
//   node:sqlite のメモリDBに流し込み、D1 と同じ形の薄いラッパー越しにチェックを直接2回呼ぶ。
//   実行: node --experimental-sqlite unit-overdue.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = pathToFileURL(path.join(ROOT, 'functions/api/_lib/overdue-notify.js')).href;

// ---- D1 互換の薄いラッパー（prepare().bind().first()/all()/run()） ----
const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
function d1(db) {
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(sql).get(...norm(args)) ?? null; },
        async all() { return { results: db.prepare(sql).all(...norm(args)) }; },
        async run() {
          const r = db.prepare(sql).run(...norm(args));
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        },
      };
      return stmt;
    },
  };
}

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) sqlite.exec(t);
}
const env = { DB: d1(sqlite) };

// チェックは1時間に1回（モジュール内の lastCheckAt）のため、毎回モジュールを読み直して実行する
let run = 0;
const check = async () => (await import(`${MODULE}?run=${++run}`)).checkOverdueAndNotify(env);
const count = (type, id) => sqlite.prepare(
  'SELECT COUNT(*) AS n FROM notifications WHERE type = ? AND related_id = ? AND deleted_at IS NULL'
).get(type, id).n;
const ackAll = () => sqlite.exec(`UPDATE notifications SET acknowledged_at = '2026-01-01T00:00:00Z', acknowledged_by = 'x'`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== 単体: 期限超過・未印刷の通知（確認後に出続けない） ===');
const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);
const ins = (sql, ...a) => Number(sqlite.prepare(sql).run(...a).lastInsertRowid);

const repairId = ins(`INSERT INTO repair_request (title, status, due_date, created_by, created_at) VALUES ('依頼A', 'open', ?, 't', '2026-01-01T00:00:00Z')`, addDays(jstToday, -3));
const planId = ins(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, created_by, created_at) VALUES ('計画A', 'inspection', ?, 'pending', 't', '2026-01-01T00:00:00Z')`, addDays(jstToday, -3));
const recurId = ins(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, recurrence_rule, created_by, created_at) VALUES ('毎週点検', 'inspection', ?, 'pending', '{"freq":"weekly","interval":1}', 't', '2026-01-01T00:00:00Z')`, addDays(jstToday, -30));
const printId = ins(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, created_by, created_at) VALUES ('工事A', 'construction', ?, 'pending', 't', '2026-01-01T00:00:00Z')`, addDays(jstToday, 2));

await check();
ok('期限超過の業務依頼に通知が1件出る', count('repair_overdue', repairId) === 1);
ok('期限超過の予定に通知が1件出る', count('plan_overdue', planId) === 1);
ok('繰り返し予定には開始日基準の期限超過通知を出さない', count('plan_overdue', recurId) === 0);
ok('工事連絡書の未印刷リマインドが1件出る', count('plan_print_reminder', printId) === 1);

ackAll(); // 誰かが「確認」した
await check();
ok('確認した後の次のチェックで、同じ期限の通知を作り直さない（業務依頼）', count('repair_overdue', repairId) === 1, `n=${count('repair_overdue', repairId)}`);
ok('確認した後の次のチェックで、同じ期限の通知を作り直さない（予定）', count('plan_overdue', planId) === 1, `n=${count('plan_overdue', planId)}`);
ok('未印刷リマインドも同じ日のうちは作り直さない', count('plan_print_reminder', printId) === 1, `n=${count('plan_print_reminder', printId)}`);

// 期限を変えて再び超過したら、新しい期限として通知する
sqlite.prepare('UPDATE repair_request SET due_date = ? WHERE id = ?').run(addDays(jstToday, -1), repairId);
await check();
ok('期限が変わって再び超過したら新しく通知する', count('repair_overdue', repairId) === 2, `n=${count('repair_overdue', repairId)}`);

console.log(`\n========== 単体（通知）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
