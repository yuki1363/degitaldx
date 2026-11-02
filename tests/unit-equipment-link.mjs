// 単体テスト: 設備台帳との紐づけ（functions/api/_lib/equipment-link.js・admin/link-equipment.js・設備カルテ）
//   実行: node --experimental-sqlite unit-equipment-link.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const lib = await load('functions/api/_lib/equipment-link.js');
const adminApi = await load('functions/api/admin/link-equipment.js');
const timeline = await load('functions/api/equipment/[id]/timeline.js');

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a.map((x) => (x === undefined ? null : x))),
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
const q = (sql, ...a) => sqlite.prepare(sql).get(...a);
console.log('\n=== 単体: 設備台帳との紐づけ ===');

// 台帳: A(充填機/ポンプ) 1件、B(搬送/コンベア) 2件（同名の設備が複数）、C(全角カナの名前)
sqlite.exec(`INSERT INTO equipment_ledger (code, name, line_name, equipment_name, created_by) VALUES
  ('01-01', '充填機 ポンプ', '充填機', 'ポンプ', 't'),
  ('02-01', '搬送 コンベア', '搬送', 'コンベア', 't'), ('02-02', '搬送 コンベア', '搬送', 'コンベア', 't'),
  ('03-01', 'フィルム挿入機', 'フィルム挿入機', 'モーター', 't')`);

ok('一致が1件ならその設備の id', await lib.resolveEquipmentId(db, '充填機', 'ポンプ') === 1);
ok('同名の設備が複数あれば決めない（null）', await lib.resolveEquipmentId(db, '搬送', 'コンベア') === null);
ok('台帳に無い名前・空の名前は null', await lib.resolveEquipmentId(db, '存在しない', 'x') === null && await lib.resolveEquipmentId(db, '', '') === null);
ok('半角カナ・全角英数の表記ゆれは正規化して照合する', await lib.resolveEquipmentId(db, 'ﾌｨﾙﾑ挿入機', 'ﾓｰﾀｰ') === 4);

// 登録・更新時の紐づけ
sqlite.exec(`INSERT INTO maintenance_plan (title, plan_type, planned_date, line_name, equipment_name, created_by) VALUES ('P1', 'inspection', '2026-11-01', '充填機', 'ポンプ', 't')`);
await lib.linkRowToEquipment(db, 'maintenance_plan', 1);
ok('保全計画: 名前が1件に一致すれば equipment_id が入る', q('SELECT equipment_id e FROM maintenance_plan WHERE id=1').e === 1);
sqlite.exec(`UPDATE maintenance_plan SET line_name='搬送', equipment_name='コンベア' WHERE id=1`);
await lib.linkRowToEquipment(db, 'maintenance_plan', 1);
ok('名前を変えて複数一致/不一致になったら、古い紐づけを外す（NULL）', q('SELECT equipment_id e FROM maintenance_plan WHERE id=1').e === null);
sqlite.exec(`INSERT INTO maintenance_plan (title, plan_type, planned_date, equipment_id, created_by) VALUES ('旧データ', 'inspection', '2026-11-02', 3, 't')`);
await lib.linkRowToEquipment(db, 'maintenance_plan', 2);
ok('名前が空の旧データ（equipment_id だけ）は消さない', q('SELECT equipment_id e FROM maintenance_plan WHERE id=2').e === 3);
await lib.linkRowToEquipment(db, 'users', 1);
ok('対象外のテーブルは何もしない（例外にもしない）', true);

// 部品: 列が無い環境でも自動で追加して紐づける
sqlite.exec(`DROP INDEX IF EXISTS idx_parts_inventory_equipment`);
sqlite.exec(`ALTER TABLE parts_inventory DROP COLUMN equipment_id`);
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by) VALUES ('p1', 'ベアリング', '充填機', 'ポンプ', 1, 't')`);
await lib.linkRowToEquipment(db, 'parts_inventory', 1);
ok('部品: equipment_id 列が無くても追加して紐づける', q('SELECT equipment_id e FROM parts_inventory WHERE id=1').e === 1);

// 一括紐づけ
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by) VALUES
  ('p2', 'Vベルト', '充填機', 'ポンプ', 1, 't'), ('p3', 'ベルト', '搬送', 'コンベア', 1, 't'), ('p4', '謎の部品', '知らない設備', '機器', 1, 't'),
  ('p5', '半角', 'ﾌｨﾙﾑ挿入機', 'ﾓｰﾀｰ', 1, 't')`);
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by, deleted_at) VALUES ('p6', '削除済み', '充填機', 'ポンプ', 1, 't', '2026-01-01T00:00:00Z')`);
sqlite.exec(`UPDATE maintenance_plan SET line_name='充填機', equipment_name='ポンプ', equipment_id=NULL WHERE id=1`);
const updBefore = q('SELECT updated_at u FROM parts_inventory WHERE id=2').u;
let r = await lib.backfillEquipmentLinks(db, { dryRun: true });
ok('確認（dry_run）は数えるだけで、何も書かない',
  r.dry_run === true && q('SELECT equipment_id e FROM parts_inventory WHERE id=2').e === null && r.tables.parts_inventory.linked >= 2, JSON.stringify(r.tables));
ok('同名が複数・台帳に無いものは別に数え、候補・組を返す',
  r.tables.parts_inventory.ambiguous === 1 && r.tables.parts_inventory.unmatched === 1
  && r.ambiguous.some((p) => p.equipment_name === 'コンベア' && p.candidates.length === 2) && r.unmatched.some((p) => p.line_name === '知らない設備'), JSON.stringify([r.ambiguous, r.unmatched]));
r = await lib.backfillEquipmentLinks(db, { dryRun: false, userEmail: 'admin@x' });
const p2 = q('SELECT equipment_id e, updated_at u FROM parts_inventory WHERE id=2');
ok('実行すると1件一致の行だけ紐づく（表記ゆれ含む）。複数一致・一致なしは NULL のまま',
  p2.e === 1 && q('SELECT equipment_id e FROM parts_inventory WHERE id=5').e === 4 && q('SELECT equipment_id e FROM parts_inventory WHERE id=3').e === null && q('SELECT equipment_id e FROM parts_inventory WHERE id=4').e === null);
ok('updated_at は変えない（編集中画面の同時編集ガードを壊さない）', p2.u === updBefore);
ok('削除済みの行は触らない', q('SELECT equipment_id e FROM parts_inventory WHERE part_no=\'p6\'').e === null);
ok('実行内容を監査ログに残す（件数と対象ID）', (() => { const a = q(`SELECT changed_by c, diff_json d FROM audit_log WHERE table_name='equipment_ledger' ORDER BY id DESC LIMIT 1`); return a?.c === 'admin@x' && /equipment_link_backfill/.test(a.d) && /linked_ids/.test(a.d); })());
r = await lib.backfillEquipmentLinks(db, { dryRun: true });
ok('もう一度確認すると、紐づけ済みは対象外（0件）', r.tables.parts_inventory.linked === 0 && r.tables.maintenance_plan.linked === 0);

// 管理 API
const call = async (role, body) => (await adminApi.onRequestPost({ request: new Request('http://x/api/admin/link-equipment', { method: 'POST', body: JSON.stringify(body) }), env: { DB: db }, data: { user: { email: 'a@x', role } } }));
ok('管理API: admin 以外は403', (await call('editor', {})).status === 403 && (await call('viewer', {})).status === 403);
ok('管理API: dry_run を省略すると確認のみ（書き込まない）', (await (await call('admin', {})).json()).dry_run === true);

// 対象の絞り込み（部品のみ）
ok('管理API: tables に不正な値だけだと400', (await call('admin', { tables: ['users'] })).status === 400);
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by) VALUES ('t1', '絞り込み部品', '充填機', 'ポンプ', 1, 't')`);
sqlite.exec(`INSERT INTO maintenance_plan (title, plan_type, planned_date, line_name, equipment_name, created_by) VALUES ('絞り込み計画', 'inspection', '2026-11-20', '充填機', 'ポンプ', 't')`);
const only = await (await call('admin', { dry_run: true, tables: ['parts_inventory'] })).json();
ok('部品のみで確認すると、計画は集計に出ない', Object.keys(only.tables).join() === 'parts_inventory' && only.tables.parts_inventory.linked >= 1, JSON.stringify(only.tables));
await (await call('admin', { dry_run: false, tables: ['parts_inventory'] })).json();
ok('部品のみで実行すると、部品だけ紐づき計画は NULL のまま',
  q(`SELECT equipment_id e FROM parts_inventory WHERE part_no='t1'`).e === 1 && q(`SELECT equipment_id e FROM maintenance_plan WHERE title='絞り込み計画'`).e === null);

// 設備カルテ: ID で紐づいた計画は、名前が違っても・空でも拾う
sqlite.exec(`INSERT INTO maintenance_plan (title, plan_type, planned_date, line_name, equipment_name, equipment_id, created_by) VALUES ('名前違いの計画', 'inspection', '2026-11-05', '旧名称', '旧機器', 4, 't')`);
sqlite.exec(`INSERT INTO maintenance_plan (title, plan_type, planned_date, equipment_id, created_by) VALUES ('名前なしの計画', 'inspection', '2026-11-06', 4, 't')`);
const tl = async (id) => (await (await timeline.onRequestGet({ request: new Request(`http://x/api/equipment/${id}/timeline?types=plan`), env: { DB: db }, params: { id: String(id) } })).json()).items;
const titles = (await tl(4)).map((x) => x.title);
ok('設備カルテ: equipment_id で紐づいた計画は、名前が違っても・名前が空でも拾う', titles.includes('名前違いの計画') && titles.includes('名前なしの計画'), titles.join());
ok('設備カルテ: 他の設備の計画は拾わない', !(await tl(1)).some((x) => x.title === '名前違いの計画'));

// 台帳に追加・名称変更したら、同じ名前の部品・計画を自動で紐づける
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by) VALUES ('n1', '後から台帳に載る部品', '新設備', '新機器', 1, 't')`);
sqlite.exec(`INSERT INTO maintenance_plan (title, plan_type, planned_date, line_name, equipment_name, created_by) VALUES ('後から台帳に載る計画', 'inspection', '2026-12-01', '新設備', '新機器', 't')`);
const nPart = q(`SELECT id FROM parts_inventory WHERE part_no='n1'`).id;
const nPlan = q(`SELECT id FROM maintenance_plan WHERE title='後から台帳に載る計画'`).id;
await lib.autoLinkAfterLedgerChange(db, 'u@x');
ok('台帳に無い間は紐づかない（自動処理を呼んでも NULL のまま）', q('SELECT equipment_id e FROM parts_inventory WHERE id=?', nPart).e === null);
const newEq = Number(sqlite.prepare(`INSERT INTO equipment_ledger (code, name, line_name, equipment_name, created_by) VALUES ('09-01', '新設備 新機器', '新設備', '新機器', 't')`).run().lastInsertRowid);
const auto = await lib.autoLinkAfterLedgerChange(db, 'u@x');
ok('台帳に追加すると、同じ名前の部品・計画が自動で紐づく', q('SELECT equipment_id e FROM parts_inventory WHERE id=?', nPart).e === newEq && q('SELECT equipment_id e FROM maintenance_plan WHERE id=?', nPlan).e === newEq && auto.tables.parts_inventory.linked >= 1, JSON.stringify(auto?.tables));
ok('自動の紐づけは監査ログに source 付きで残る', /"source":"ledger_change"/.test(q(`SELECT diff_json d FROM audit_log WHERE table_name='equipment_ledger' ORDER BY id DESC LIMIT 1`).d));
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by) VALUES ('n2', '同名が増えた後の部品', '新設備', '新機器', 1, 't')`);
sqlite.exec(`INSERT INTO equipment_ledger (code, name, line_name, equipment_name, created_by) VALUES ('09-02', '新設備 新機器（2台目）', '新設備', '新機器', 't')`);
await lib.autoLinkAfterLedgerChange(db, 'u@x');
ok('同じ名前の設備が2件になると、まだ紐づいていない部品は決めない。紐づけ済みはそのまま',
  q(`SELECT equipment_id e FROM parts_inventory WHERE part_no='n2'`).e === null && q('SELECT equipment_id e FROM parts_inventory WHERE id=?', nPart).e === newEq);
sqlite.exec(`INSERT INTO parts_inventory (part_no, name, line_name, equipment_name, quantity, created_by) VALUES ('n3', '名称変更後に合う部品', '改名後の設備', '改名後の機器', 1, 't')`);
sqlite.exec(`UPDATE equipment_ledger SET line_name='改名後の設備', equipment_name='改名後の機器' WHERE code='09-02'`);
await lib.autoLinkAfterLedgerChange(db, 'u@x');
ok('台帳の名称を変えると、新しい名前に一致する部品が紐づく', q(`SELECT equipment_id e FROM parts_inventory WHERE part_no='n3'`).e === q(`SELECT id FROM equipment_ledger WHERE code='09-02'`).id);
ok('自動処理が失敗しても例外にしない（台帳の保存を失敗させない）', (await lib.autoLinkAfterLedgerChange({ prepare() { throw new Error('db down'); } }, 'u@x')) === null);

console.log(`\n========== 単体（設備台帳との紐づけ）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
