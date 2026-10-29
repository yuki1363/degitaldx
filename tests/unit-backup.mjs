// 単体テスト: バックアップ（functions/api/admin/backup.js）
//   id 列の無いテーブル（electrical_config）や、後から増えたテーブルが漏れずに入ることを確認する。
//   実行: node --experimental-sqlite unit-backup.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { onRequestGet, TABLES } = await import(pathToFileURL(path.join(ROOT, 'functions/api/admin/backup.js')).href);

const sqlite = new DatabaseSync(':memory:');
const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
for (const st of schema.split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a),
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
});
const db = { prepare: (sql) => wrap(sql) };

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: バックアップの対象テーブル ===');

// 電気設備点検の設定は id 列が無い（equipment_type が主キー）
sqlite.exec(`INSERT INTO electrical_config (equipment_type, config_json) VALUES ('main', '{"x":1}')`);
sqlite.exec(`INSERT INTO print_templates (name, template_type, created_by) VALUES ('工事連絡書', 'construction_notice', 't')`);
sqlite.exec(`INSERT INTO electrical_inspection (client_id, equipment_type, inspected_date, record_json, created_by) VALUES ('1', 'main', '2026-10-01', '{}', 't')`);

const call = (q = '') => onRequestGet({ request: new Request(`http://x/api/admin/backup${q}`), env: { DB: db }, data: { user: { email: 'a@x', role: 'admin' } } });
const json = await (await call()).json();
ok('id 列の無い electrical_config も JSON に入る', Array.isArray(json.tables.electrical_config) && json.tables.electrical_config.length === 1);
ok('帳票テンプレート・電気設備点検も入る', json.tables.print_templates?.length === 1 && json.tables.electrical_inspection?.length === 1);
const missing = TABLES.filter((t) => !Array.isArray(json.tables[t]));
ok('対象テーブルがすべて取得できる（null が無い）', missing.length === 0, missing.join(','));

// schema.sql の全テーブルが、バックアップ対象か意図的な除外のどちらかになっている（新しいテーブルの入れ忘れ防止）
const EXCLUDED = new Set(['push_subscriptions']);
const all = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const notCovered = all.filter((t) => !TABLES.includes(t) && !EXCLUDED.has(t));
ok('schema.sql の全テーブルがバックアップ対象（または意図的な除外）', notCovered.length === 0, notCovered.join(','));

const sql = await (await call('?format=sql')).text();
ok('SQLダンプに electrical_config の INSERT が入る', /INSERT INTO "electrical_config"/.test(sql));
const viewer = await onRequestGet({ request: new Request('http://x/api/admin/backup'), env: { DB: db }, data: { user: { email: 'v@x', role: 'editor' } } });
ok('admin 以外は403', viewer.status === 403);

console.log(`\n========== 単体（バックアップ）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
