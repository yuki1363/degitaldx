// 単体テスト: トラブル記録一覧の担当者（記録者）での絞り込み（GET /api/troubles?reporter=）
//   schema.sql を node:sqlite のメモリDBに流し込み、D1 と同じ形の薄いラッパー越しに onRequestGet を直接呼ぶ。
//   実行: node --experimental-sqlite unit-trouble-reporter.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { onRequestGet } = await import(pathToFileURL(path.join(ROOT, 'functions/api/troubles/index.js')).href);

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
const db = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = a.map((x) => (x === undefined ? null : x)); return st; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    };
    return st;
  },
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const search = async (qs) => {
  const res = await onRequestGet({ request: new Request(`http://x/api/troubles?${qs}`), env: { DB: db } });
  return (await res.json()).troubles.map((t) => t.phenomenon);
};

console.log('\n=== 単体: トラブル一覧の担当者（記録者）絞り込み ===');
sqlite.exec(`INSERT INTO users (email, name, role, created_by) VALUES ('suzuki@example.com', '鈴木 次郎', 'editor', 't')`);
const ins = sqlite.prepare(`INSERT INTO trouble_record (occurred_at, phenomenon, reporter_name, created_by, created_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`);
ins.run('2026-01-01T00:00:00Z', 'A 記録者名あり（山田）', '山田 太郎', 'x@example.com');
ins.run('2026-01-02T00:00:00Z', 'B 記録者名あり（佐藤）', '佐藤 花子', 'x@example.com');
ins.run('2026-01-03T00:00:00Z', 'C 記録者名なし・登録ユーザー（鈴木）', null, 'suzuki@example.com');
ins.run('2026-01-04T00:00:00Z', 'D 記録者名が空文字・登録ユーザー（鈴木）', '', 'suzuki@example.com');
ins.run('2026-01-05T00:00:00Z', 'E 記録者名「100%_A」', '100%_A', 'x@example.com');
ins.run('2026-01-06T00:00:00Z', 'F 削除済み（山田）', '山田 太郎', 'x@example.com');
sqlite.exec(`UPDATE trouble_record SET deleted_at = '2026-02-01T00:00:00Z' WHERE phenomenon LIKE 'F %'`);

let r = await search('');
ok('担当者を指定しないときは全件（削除済みを除く5件）', r.length === 5, String(r.length));
r = await search('reporter=' + encodeURIComponent('山田'));
ok('名前の一部で絞れる（削除済みは出ない）', r.length === 1 && r[0].startsWith('A '), JSON.stringify(r));
r = await search('reporter=' + encodeURIComponent('太郎'));
ok('名字でも名前でも一致する', r.length === 1 && r[0].startsWith('A '), JSON.stringify(r));
r = await search('reporter=' + encodeURIComponent('鈴木'));
ok('記録者名が無い・空のときは登録ユーザーの氏名で絞れる', r.length === 2 && r.every((p) => /^[CD] /.test(p)), JSON.stringify(r));
r = await search('reporter=' + encodeURIComponent('  佐藤  '));
ok('前後の空白は無視する', r.length === 1 && r[0].startsWith('B '), JSON.stringify(r));
r = await search('reporter=' + encodeURIComponent('存在しない人'));
ok('一致が無ければ0件', r.length === 0);
r = await search('reporter=' + encodeURIComponent('%'));
ok('% はワイルドカードではなく文字として探す', r.length === 1 && r[0].startsWith('E '), JSON.stringify(r));
r = await search('reporter=' + encodeURIComponent('_'));
ok('_ もワイルドカードではなく文字として探す', r.length === 1 && r[0].startsWith('E '), JSON.stringify(r));
r = await search('reporter=' + encodeURIComponent('山田') + '&from=2026-01-02');
ok('ほかの条件（期間）と組み合わせられる', r.length === 0, JSON.stringify(r));

console.log(`\n========== 単体（トラブル一覧の担当者絞り込み）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
process.exit(fail ? 1 : 0);
