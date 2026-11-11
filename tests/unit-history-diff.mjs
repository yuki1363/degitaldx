// 単体テスト: 変更履歴の差分表示（js/history-diff.js）と、日報・ユーティリティ日報が「前→後」を記録すること
//   実行: node --experimental-sqlite unit-history-diff.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const hd = await load('js/history-diff.js');
const reportsId = await load('functions/api/reports/[id].js');
const utilId = await load('functions/api/utility-reports/[id].js');
const values = await load('functions/api/utility-reports/_values.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const parse = (diff, action = 'update') => hd.parseHistoryChanges(typeof diff === 'string' ? diff : JSON.stringify(diff), action);

console.log('\n=== 単体: 差分の解釈（3つの記録形式をそろえる） ===');
let c = parse({ status: { from: 'pending', to: 'done' }, title: { from: '旧', to: '新' } });
ok('① {項目:{from,to}} — 状態は日本語に直す', c.length === 2 && c[0].label === '状態' && c[0].from === '未実施' && c[0].to === '完了' && c[1].label === 'タイトル' && c[1].from === '旧' && c[1].to === '新', JSON.stringify(c));
c = parse({ code: { before: 'A-01', after: 'A-02' }, installed_on: { before: null, after: '2026-04-01' } });
ok('② {項目:{before,after}} — 空は「なし」・日付は YYYY/MM/DD', c.length === 2 && c[0].label === '設備番号' && c[1].from === 'なし' && c[1].to === '2026/04/01', JSON.stringify(c));
c = parse({ before: { assignee_name: 'A', has_abnormal: false, note: 'x' }, after: { assignee_name: 'B', has_abnormal: true, note: 'x' } });
ok('③ {before:{…},after:{…}} — 変わった項目だけ（note は同じなので出ない）', c.length === 2 && c[0].label === '担当者' && c[1].label === '異常' && c[1].from === 'いいえ' && c[1].to === 'はい', JSON.stringify(c));
c = parse({ occurred_at: { from: '2026-10-26T15:30:00Z', to: '2026-10-27T01:05:00Z' } });
ok('日時は JST の「YYYY/MM/DD HH:MM」で出す（UTCのまま出さない）', c[0].from === '2026/10/27 00:30' && c[0].to === '2026/10/27 10:05', JSON.stringify(c));
c = parse({ form_values_json: { from: '{"a":1}', to: '{"a":2}' }, phenomenon: { from: 'あ', to: 'い' } });
ok('帳票の入力など _json の列は中身を出さず「変更あり」（opaque）', c[0].opaque === true && c[0].from === '' && c[1].opaque === false, JSON.stringify(c));
c = parse({ status: { from: 'pending', to: 'pending' } });
ok('前後が同じ項目は出さない', c.length === 0);
const longText = 'あ'.repeat(200);
c = parse({ cause: { from: longText, to: '短い' } });
ok('長い文章は60文字で切って「…」を付ける', c[0].from.length === 61 && c[0].from.endsWith('…') && c[0].to === '短い', String(c[0].from.length));

console.log('\n=== 単体: 出さないもの ===');
ok('登録・削除・復元は変更内容を出さない（操作そのものが履歴）', parse({ title: { from: 'a', to: 'b' } }, 'create').length === 0 && parse({ deleted_at: '2026-10-27T00:00:00Z' }, 'delete').length === 0 && parse({}, 'restore').length === 0);
ok('以前の形式（新しい値だけを全項目書いたもの）・メタ情報は出さない（前の値が無い）', parse({ report_date: '2026-10-01', body: 'x', batch: true, synced_from: '3' }).length === 0);
ok('壊れた JSON・空・null でも例外にならない', parse('{broken').length === 0 && hd.parseHistoryChanges(null, 'update').length === 0 && hd.parseHistoryChanges('', 'update').length === 0 && hd.parseHistoryChanges('[1,2]', 'update').length === 0);
ok('要約: 3項目まではそのまま、超えたら「ほかN件」', hd.summarizeChanges(parse({ a1: { from: 1, to: 2 }, a2: { from: 1, to: 2 } })) === 'a1・a2を変更'
  && hd.summarizeChanges(parse({ code: { before: 1, after: 2 }, name: { before: 1, after: 2 }, location: { before: 1, after: 2 }, model: { before: 1, after: 2 } })) === '設備番号・名称・設置場所 ほか1件を変更');

console.log('\n=== 単体: ユーティリティ日報の点検項目ごとの前後 ===');
const oldV = [{ item_id: 1, name: '灯油タンク残量', unit: 'L', value: 500 }, { item_id: 2, name: 'ボイラー号機', unit: null, value: ['1号機'] }, { item_id: 3, name: '備考欄', unit: null, value: 'あ' }];
const newV = [{ item_id: 1, name: '灯油タンク残量', unit: 'L', value: 450 }, { item_id: 2, name: 'ボイラー号機', unit: null, value: ['1号機'] }, { item_id: 4, name: '温水圧力', unit: 'MPa', value: 0.3 }];
const dv = values.diffValues(oldV, newV);
ok('diffValues: 変わった項目だけ（変更・消した・追加）', dv.length === 3 && dv.find((x) => x.name === '灯油タンク残量')?.from === 500 && dv.find((x) => x.name === '灯油タンク残量')?.to === 450 && dv.find((x) => x.name === '備考欄')?.to === null && dv.find((x) => x.name === '温水圧力')?.from === null, JSON.stringify(dv));
c = parse({ changed_items: dv, attached_files: 2 });
ok('changed_items は「項目名：前 → 後（単位つき）」、写真は「n件を追加」', c.length === 4 && c[0].label === '灯油タンク残量' && c[0].from === '500 L' && c[0].to === '450 L' && c.find((x) => x.label === '備考欄').to === 'なし' && c.at(-1).to === '2件を追加', JSON.stringify(c));
ok('diffValues: 値が同じなら空・形式が壊れていても例外にならない', values.diffValues(oldV, oldV).length === 0 && values.diffValues(null, undefined).length === 0);

console.log('\n=== 単体: 日報・ユーティリティ日報の更新が「前→後」を記録する ===');
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
const db = { prepare: (sql) => wrap(sql), async batch(l) { sqlite.exec('BEGIN'); try { const o = l.map((s) => s._exec()); sqlite.exec('COMMIT'); return o; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
const user = { id: 1, email: 'admin@x', name: '管理者', role: 'admin' };
const put = async (mod, id, body) => {
  const res = await mod.onRequestPut({ request: new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), env: { DB: db }, data: { user }, params: { id: String(id) }, waitUntil() {} });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const lastDiff = (table, id) => JSON.parse(sqlite.prepare(`SELECT diff_json FROM audit_log WHERE table_name = ? AND record_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1`).get(table, id).diff_json);

sqlite.exec(`INSERT INTO daily_report (reporter_id, report_date, body, reporter_name, created_by) VALUES (1, '2026-10-01', '旧本文', '山田', 't')`);
let r = await put(reportsId, 1, { report_date: '2026-10-01', body: '新本文', reporter_name: '山田' });
let d = lastDiff('daily_report', 1);
ok('日報の更新: 変えた項目（本文）だけ前→後で記録し、変えていない項目は書かない', r.status === 200 && d.body?.from === '旧本文' && d.body?.to === '新本文' && !('report_date' in d) && !('reporter_name' in d), JSON.stringify(d));
ok('日報の更新: 画面の解釈でも「本文」の前→後になる', parse(d).length === 1 && parse(d)[0].label === '本文');

sqlite.exec(`INSERT INTO utility_item (section, name, input_type, unit, sort_order, created_by) VALUES ('灯油', '灯油タンク残量', 'number', 'L', 1, 't')`);
const item = sqlite.prepare(`SELECT id FROM utility_item WHERE name = '灯油タンク残量'`).get();
sqlite.exec(`INSERT INTO utility_report (report_date, inspected_at, reporter_name, has_abnormal, values_json, note, created_by) VALUES ('2026-10-01', '2026-10-01T00:00:00Z', '山田', 0, '${JSON.stringify([{ item_id: item.id, name: '灯油タンク残量', section: '灯油', input_type: 'number', unit: 'L', value: 500 }])}', '旧メモ', 't')`);
r = await put(utilId, 1, { report_date: '2026-10-01', reporter_name: '山田', note: '新メモ', values: { [item.id]: 450 } });
d = lastDiff('utility_report', 1);
ok('ユーティリティ日報の更新: 備考と点検項目の変更を前→後で記録（同じ日付・記録者は書かない）', r.status === 200 && d.note?.from === '旧メモ' && d.note?.to === '新メモ' && d.changed_items?.length === 1 && d.changed_items[0].from === 500 && d.changed_items[0].to === 450 && !('report_date' in d) && !('reporter_name' in d), JSON.stringify(d));

console.log(`\n========== 単体（変更履歴の差分表示）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
