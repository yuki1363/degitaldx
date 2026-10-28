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
    // D1 の batch と同じく1トランザクションで順に実行し、途中で失敗したら全部戻す
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
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

// ---- 年間計画の会計年度（リセットで年度を進める） ----
console.log('\n=== 単体: 年間計画の会計年度（最後にリセットした年度＋1） ===');
const PLANS = pathToFileURL(path.join(ROOT, 'functions/api/plans/index.js')).href;
const RESET = pathToFileURL(path.join(ROOT, 'functions/api/plans/annual-reset.js')).href;
const { getAnnualFyState, deriveOverdue } = await import(PLANS);
const { onRequestPost: resetPost } = await import(RESET);
const realNow = Date.now;
// JST のその日の正午に時計を合わせる
const at = (ymd) => { Date.now = () => new Date(`${ymd}T03:00:00Z`).getTime(); };
const admin = { user: { email: 'admin@example.com', role: 'admin' } };
const reset = async (body = {}) => {
  const res = await resetPost({ request: new Request('http://x/api/plans/annual-reset', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), env, data: admin });
  // nowIso() は new Date()（差し替えていない本物の時計）を使うため、記録されたリセット日時を
  // 差し替えた時刻に合わせる（合わせないと、テストを実行した月によって結果が変わる）
  if (res.status === 200) {
    sqlite.prepare('UPDATE plan_reset_log SET reset_at = ? WHERE id = (SELECT MAX(id) FROM plan_reset_log)')
      .run(new Date(Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }
  return { status: res.status, json: await res.json().catch(() => null) };
};
const annual = (ym) => ({ id: 1, status: 'pending', annual_only: 1, planned_date: `2020-${ym}-01` });
sqlite.exec('DELETE FROM plan_reset_log');

try {
  // 履歴なし: 時計の年度。10〜12月のリセットは前年度を締める
  at('2026-10-27');
  let st = await getAnnualFyState(env.DB);
  ok('履歴なし・10月: 今年度は時計の年度（FY2026）', st.current === 2026, JSON.stringify(st));
  ok('履歴なし・10月: リセットで締めるのは前年度（FY2025）', st.resetTarget === 2025 && st.resetAvailable, JSON.stringify(st));
  at('2026-05-10');
  st = await getAnnualFyState(env.DB);
  ok('履歴なし・5月: 締めるのは今年度（FY2025）だが9月まではリセット不可', st.resetTarget === 2025 && !st.resetAvailable, JSON.stringify(st));
  const early = await reset();
  ok('9月より前のリセットは409', early.status === 409, JSON.stringify(early));

  // 10月にリセット → FY2025 を締め、今年度は FY2026。完了状態は戻り、監査と履歴が1トランザクションで残る
  at('2026-10-27');
  const doneId = ins(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, annual_only, created_by, created_at) VALUES ('年間A', 'inspection', '2024-05-01', 'done', 1, 't', '2026-01-01T00:00:00Z')`);
  const stale = await reset({ fiscal_year: 2026 });
  ok('締める年度と違う fiscal_year（古い画面の時計で計算）は409', stale.status === 409, JSON.stringify(stale));
  const r1 = await reset({ fiscal_year: 2025 });
  ok('10月のリセットは FY2025 を締める', r1.status === 200 && r1.json?.fiscal_year === 2025 && r1.json?.reset_count === 1, JSON.stringify(r1));
  ok('リセットで完了が未実施に戻る', sqlite.prepare('SELECT status FROM maintenance_plan WHERE id = ?').get(doneId).status === 'pending');
  const log = sqlite.prepare('SELECT plan_count FROM plan_reset_log WHERE fiscal_year = 2025').get();
  ok('リセット履歴に戻した件数が残る', log?.plan_count === 1, JSON.stringify(log));
  const aud = sqlite.prepare(`SELECT diff_json FROM audit_log WHERE record_id = 'annual_reset' ORDER BY id DESC LIMIT 1`).get();
  const diff = JSON.parse(aud?.diff_json || '{}');
  ok('監査ログに戻した予定と変更前の状態が残る', diff.fiscal_year === 2025 && diff.reset_plans?.[0]?.id === doneId && diff.reset_plans?.[0]?.from === 'done', aud?.diff_json);
  const r2 = await reset();
  ok('リセット直後のもう一度は409（始まったばかりの FY2026 を締めない）', r2.status === 409, JSON.stringify(r2));
  st = await getAnnualFyState(env.DB);
  ok('リセット後の今年度は FY2026', st.current === 2026 && st.resetTarget === 2026 && !st.resetAvailable, JSON.stringify(st));

  // 翌年10月にリセットを忘れている: 年度は進まず、FY2026 の未実施（9月分）は期限超過のまま
  at('2027-10-15');
  st = await getAnnualFyState(env.DB);
  ok('リセット忘れ: 時計が FY2027 でも今年度は FY2026 のまま', st.current === 2026 && st.resetAvailable, JSON.stringify(st));
  ok('リセット忘れ: 前年度9月の未実施は期限超過', deriveOverdue(annual('09'), { fy: st.current }).status === 'overdue');
  ok('（参考）時計の年度で判定すると9月分は超過にならない＝気づけない', deriveOverdue(annual('09')).status === 'pending');
  const r3 = await reset();
  ok('翌年10月のリセットは FY2026 を締める', r3.status === 200 && r3.json?.fiscal_year === 2026, JSON.stringify(r3));
  st = await getAnnualFyState(env.DB);
  ok('リセット後は FY2027 に進み、前年度9月の予定は超過にならない', st.current === 2027 && deriveOverdue(annual('09'), { fy: st.current }).status === 'pending', JSON.stringify(st));

  // 9月中の前倒しリセット: 翌年度へ進む（時計＋1まで）
  at('2028-09-20');
  const r4 = await reset();
  st = await getAnnualFyState(env.DB);
  ok('9月の前倒しリセットで FY2028 へ進む', r4.status === 200 && r4.json?.fiscal_year === 2027 && st.current === 2028, JSON.stringify({ r4, st }));
  ok('前倒し後は今年度の9月分も超過にならない', deriveOverdue(annual('09'), { fy: st.current }).status === 'pending');

  // 期限超過通知も同じ年度で判定する（リセット忘れの前年度分を通知、本文は年度に当てはめた予定月）
  sqlite.exec('DELETE FROM plan_reset_log');
  sqlite.exec(`INSERT INTO plan_reset_log (fiscal_year, reset_by, plan_count) VALUES (2025, 't', 0)`);
  at('2027-10-15');
  const forgotId = ins(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, annual_only, created_by, created_at) VALUES ('年間B', 'inspection', '2020-09-01', 'pending', 1, 't', '2026-01-01T00:00:00Z')`);
  await check();
  const n = sqlite.prepare(`SELECT body FROM notifications WHERE type = 'plan_overdue' AND related_id = ?`).all(forgotId);
  ok('リセット忘れの前年度分は期限超過を通知（予定月 2027-09）', n.length === 1 && n[0].body.includes('2027-09'), JSON.stringify(n));

  // 旧形式の年間計画（annual_only 列が入る前の一括登録＝audit_log の batch 署名）も月単位で判定する
  at('2026-10-15');
  const legacyId = ins(`INSERT INTO maintenance_plan (title, plan_type, planned_date, status, created_by, created_at) VALUES ('旧年間', 'inspection', '2026-10-01', 'pending', 't', '2026-01-01T00:00:00Z')`);
  sqlite.prepare(`INSERT INTO audit_log (table_name, record_id, action, changed_by, diff_json) VALUES ('maintenance_plan', ?, 'create', 't', '{"batch":true}')`).run(legacyId);
  await check();
  ok('旧形式の年間計画は当月中に期限超過を通知しない（月単位）', count('plan_overdue', legacyId) === 0, `n=${count('plan_overdue', legacyId)}`);

  // ---- 旧画面で10月以降にリセットした履歴（始まったばかりの年度が記録されている）の補正 ----
  // 旧画面は端末の時計の年度を送っていたため、2026年10月に押すと FY2026（実際は前の FY2025 を締めた）と記録していた
  const fresh = await import(`${PLANS}?legacy=1`); // 補正は1回だけ行うため、モジュールを読み直して試す
  sqlite.exec('DELETE FROM plan_reset_log');
  sqlite.exec(`DELETE FROM audit_log WHERE table_name = 'plan_reset_log'`);
  at('2026-10-28');
  sqlite.exec(`INSERT INTO plan_reset_log (fiscal_year, reset_at, reset_by, plan_count, csv_snapshot) VALUES (2026, '2026-10-05T01:00:00Z', 'admin', 3, 'csv-of-fy2025')`);
  st = await fresh.getAnnualFyState(env.DB);
  ok('旧画面で今月リセット済み: 今年度は FY2026（FY2027 に進まない）', st.current === 2026 && st.lastReset === 2025 && st.resetTarget === 2026, JSON.stringify(st));
  const fixed = sqlite.prepare('SELECT fiscal_year, csv_snapshot FROM plan_reset_log').all();
  ok('履歴の年度を1つ前（FY2025）に直す（CSVスナップショットはそのまま）', fixed.length === 1 && fixed[0].fiscal_year === 2025 && fixed[0].csv_snapshot === 'csv-of-fy2025', JSON.stringify(fixed));
  const fixAudit = sqlite.prepare(`SELECT changed_by, diff_json FROM audit_log WHERE table_name = 'plan_reset_log'`).all();
  ok('補正は監査ログに残る（誰が・何から何へ）', fixAudit.length === 1 && fixAudit[0].changed_by === 'system:legacy-fy-fix' && JSON.parse(fixAudit[0].diff_json).fiscal_year.from === 2026, JSON.stringify(fixAudit));
  st = await fresh.getAnnualFyState(env.DB);
  ok('補正は1回だけ（2回目は何も変えない）', st.current === 2026 && sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'plan_reset_log'`).get().n === 1);
  ok('補正後、10月分の未実施は超過にならず、来年度の予定も超過にならない',
    fresh.deriveOverdue(annual('10'), { fy: st.current }).status === 'pending' && fresh.deriveOverdue(annual('05'), { fy: st.current }).status === 'pending');
  // 旧画面で前年度（FY2025）を9月に正しく記録済みで、さらに今月も押した（二重）: 重複するため直せないが、年度は正しく数える
  const fresh2 = await import(`${PLANS}?legacy=2`);
  sqlite.exec('DELETE FROM plan_reset_log');
  sqlite.exec(`INSERT INTO plan_reset_log (fiscal_year, reset_at, reset_by, plan_count) VALUES (2025, '2026-09-20T01:00:00Z', 'admin', 3)`);
  sqlite.exec(`INSERT INTO plan_reset_log (fiscal_year, reset_at, reset_by, plan_count) VALUES (2026, '2026-10-05T01:00:00Z', 'admin', 0)`);
  st = await fresh2.getAnnualFyState(env.DB);
  ok('FY2025 を9月に記録済み＋10月にも押した場合: 重複は直さず、今年度は FY2026 のまま',
    st.current === 2026 && sqlite.prepare('SELECT COUNT(*) AS n FROM plan_reset_log WHERE fiscal_year = 2026').get().n === 1, JSON.stringify(st));
  // 新しい画面の記録は触らない（10月に前年度を締めた・9月の前倒し）
  const fresh3 = await import(`${PLANS}?legacy=3`);
  sqlite.exec('DELETE FROM plan_reset_log');
  sqlite.exec(`INSERT INTO plan_reset_log (fiscal_year, reset_at, reset_by, plan_count) VALUES (2025, '2026-10-05T01:00:00Z', 'admin', 3)`);
  st = await fresh3.getAnnualFyState(env.DB);
  ok('新しい画面で10月に FY2025 を締めた記録は補正しない', st.current === 2026 && sqlite.prepare('SELECT fiscal_year FROM plan_reset_log').get().fiscal_year === 2025, JSON.stringify(st));
} finally {
  Date.now = realNow;
}

console.log(`\n========== 単体（通知・年度）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
