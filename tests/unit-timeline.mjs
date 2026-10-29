// 単体テスト: 設備カルテ（GET /api/equipment/:id/timeline）
//   実行: node --experimental-sqlite unit-timeline.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { onRequestGet } = await import(pathToFileURL(path.join(ROOT, 'functions/api/equipment/[id]/timeline.js')).href);

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a.map((x) => (x === undefined ? null : x))),
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
});
const db = { prepare: (sql) => wrap(sql) };
const get = async (id, qs = '') => {
  const res = await onRequestGet({ request: new Request(`http://x/api/equipment/${id}/timeline${qs}`), env: { DB: db }, params: { id: String(id) } });
  return { status: res.status, json: await res.json() };
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\n=== 単体: 設備カルテ（時系列） ===');

sqlite.exec(`INSERT INTO equipment_ledger (code, name, line_name, equipment_name, created_by) VALUES
  ('A-1', 'コンプレッサ', '空気圧縮', 'コンプレッサ', 't'), ('B-1', 'ポンプ', '給水', 'ポンプ', 't'), ('C-1', '名なし設備', NULL, NULL, 't')`);
sqlite.exec(`INSERT INTO trouble_category (name, created_by) VALUES ('機械', 't')`);
// 点検（正常・異常）、トラブル、依頼、計画、部品の使用。2件目の設備のデータも混ぜる
sqlite.exec(`
INSERT INTO inspection_result (equipment_id, items_json, assignee_id, inspected_at, has_abnormal, assignee_name, created_by) VALUES
  (1, '[]', 1, '2026-10-01T00:00:00Z', 0, '山田', 't'), (1, '[]', 1, '2026-10-05T00:00:00Z', 1, '佐藤', 't'), (2, '[]', 1, '2026-10-02T00:00:00Z', 0, '他', 't');
INSERT INTO trouble_record (equipment_id, category_id, occurred_at, phenomenon, created_by, created_at) VALUES
  (1, 1, '2026-10-03T00:00:00Z', '異音', 't', '2026-10-03T00:00:00Z'), (2, 1, '2026-10-03T00:00:00Z', '他設備の異音', 't', '2026-10-03T00:00:00Z');
INSERT INTO repair_request (equipment_id, title, status, created_by, created_at) VALUES (1, 'ベルト交換', 'open', 't', '2026-10-04T00:00:00Z');
INSERT INTO maintenance_plan (title, plan_type, planned_date, line_name, equipment_name, status, created_by) VALUES
  ('定期点検', 'inspection', '2026-10-10', '空気圧縮', 'コンプレッサ', 'pending', 't'),
  ('別設備の計画', 'inspection', '2026-10-11', '給水', 'ポンプ', 'pending', 't');
INSERT INTO parts_inventory (part_no, name, quantity, created_by) VALUES ('p1', 'Vベルト', 5, 't');
INSERT INTO parts_transaction (part_id, type, quantity, related_table, related_id, created_by, created_at) VALUES
  (1, 'out', -1, 'repair_request', 1, 't', '2026-10-04T05:00:00Z'),
  (1, 'out', -1, NULL, NULL, 't', '2026-10-06T00:00:00Z');
`);
sqlite.exec(`UPDATE inspection_result SET deleted_at = '2026-10-20T00:00:00Z' WHERE assignee_name = '山田'`);

let r = (await get(1)).json;
const kinds = r.items.map((x) => x.kind);
ok('この設備の履歴だけを新しい順に返す（他設備・削除済み・紐づかない入出庫は出ない）',
  JSON.stringify(kinds) === JSON.stringify(['plan', 'inspection', 'parts', 'repair', 'trouble']), JSON.stringify(kinds));
ok('点検の異常フラグ・担当が入る', r.items.find((x) => x.kind === 'inspection')?.extra === '1' && r.items.find((x) => x.kind === 'inspection')?.sub === '佐藤');
ok('部品は紐づいた入出庫だけ（部品IDと数量）', r.items.find((x) => x.kind === 'parts')?.rec_id === 1 && r.items.find((x) => x.kind === 'parts')?.extra === '-1');

r = (await get(1, '?types=trouble')).json;
ok('types で種別を絞れる（先頭が trouble 以外の種別でも列名が崩れない）', r.items.length === 1 && r.items[0].kind === 'trouble');
r = (await get(1, '?types=plan,parts')).json;
ok('複数種別の指定', r.items.map((x) => x.kind).join() === 'plan,parts');

r = (await get(1, '?limit=2')).json;
const next = (await get(1, '?limit=2&offset=2')).json;
const last = (await get(1, '?limit=2&offset=4')).json;
ok('limit と offset で続きを取れる（has_more）', r.items.length === 2 && r.has_more === true && next.items.length === 2 && next.has_more === true && last.items.length === 1 && last.has_more === false);
ok('ページをまたいでも重複・欠けが無い', [...r.items, ...next.items, ...last.items].map((x) => `${x.kind}${x.rec_id}`).join() === (await get(1)).json.items.map((x) => `${x.kind}${x.rec_id}`).join());
ok('limit=-1 は下限1に丸める（無制限にならない）', (await get(1, '?limit=-1')).json.items.length === 1);

r = (await get(3)).json;
ok('設備名・機器名が空の設備は、無関係な保全計画を拾わない', r.items.length === 0);
ok('存在しない設備は404、不正な types は400', (await get(999)).status === 404 && (await get(1, '?types=zzz')).status === 400);

console.log(`\n========== 単体（設備カルテ）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
