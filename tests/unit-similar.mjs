// 単体テスト: 類似トラブル検索（functions/api/_lib/trouble-similar.js）
//   E2E では作れない件数（200件超）で、全部の語に一致する古い記録が上位に出ることを確認する。
//   schema.sql を node:sqlite のメモリDBに流し込み、D1 と同じ形の薄いラッパー越しに直接呼ぶ。
//   実行: node --experimental-sqlite unit-similar.mjs（npm test から呼ばれる）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { findSimilarTroubles } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_lib/trouble-similar.js')).href);

const sqlite = new DatabaseSync(':memory:');
for (const st of fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').split(/;\s*(?:\n|$)/)) {
  const t = st.replace(/^\s*--.*$/mg, '').trim();
  if (t) { try { sqlite.exec(t); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
}
let lastBindCount = 0;
const db = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = a.map((x) => (x === undefined ? null : x)); lastBindCount = args.length; return st; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    };
    return st;
  },
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== 単体: 類似トラブル検索（一致した語の多い順・件数が多くても取りこぼさない） ===');
sqlite.exec(`INSERT INTO equipment_ledger (code, name, created_by) VALUES ('E-1', 'テスト空圧機', 't'), ('E-2', 'テストポンプ', 't')`);
const ins = sqlite.prepare(`INSERT INTO trouble_record (occurred_at, phenomenon, cause, equipment_id, created_by, created_at) VALUES (?, ?, ?, ?, 't', '2026-01-01T00:00:00Z')`);
const oldBoth = Number(ins.run('2020-01-01T00:00:00Z', 'コンプレッサ 異音 ベアリング（全部の語に一致する古い記録）', null, null).lastInsertRowid);
for (let i = 0; i < 250; i++) ins.run(`2026-0${1 + (i % 9)}-10T00:00:00Z`, `モーター 異音 その${i}（異音だけに一致する新しい記録）`, null, null);

let r = await findSimilarTroubles(db, 'コンプレッサ 異音', { limit: 10 });
ok('異音だけに一致する新しい記録が250件あっても、両方の語に一致する古い記録が先頭に出る', r[0]?.id === oldBoth && r.length === 10, JSON.stringify(r.slice(0, 2).map((x) => x.phenomenon.slice(0, 14))));
ok('件数は limit で止まる（最大20）', (await findSimilarTroubles(db, '異音', { limit: 999 })).length === 20);

// 同じ点数なら、同じ設備を先に
const sameEqId = Number(ins.run('2019-01-01T00:00:00Z', '空圧機の圧力低下 新規', null, 1).lastInsertRowid);
const otherEqId = Number(ins.run('2025-01-01T00:00:00Z', '空圧機の圧力低下 別設備', null, 2).lastInsertRowid);
r = await findSimilarTroubles(db, '圧力低下', { limit: 5, equipmentId: 1 });
ok('点数が同じなら、同じ設備の事例を新しい事例より先に出す', r[0]?.id === sameEqId && r[1]?.id === otherEqId, JSON.stringify(r.map((x) => x.id)));

// 自分自身は出さない・削除済みは出さない
r = await findSimilarTroubles(db, '圧力低下', { limit: 5, excludeId: sameEqId });
ok('excludeId の記録は出ない', !r.some((x) => x.id === sameEqId) && r.some((x) => x.id === otherEqId));
sqlite.prepare(`UPDATE trouble_record SET deleted_at = '2026-02-01T00:00:00Z' WHERE id = ?`).run(otherEqId);
r = await findSimilarTroubles(db, '圧力低下', { limit: 5 });
ok('削除済みの記録は出ない', !r.some((x) => x.id === otherEqId));

// 設備名・設備番号でも見つかる（現象に設備名を書いていない記録）
const byEq = Number(ins.run('2026-03-01T00:00:00Z', '圧が上がらない', null, 2).lastInsertRowid);
ok('設備名で見つかる', (await findSimilarTroubles(db, 'テストポンプ')).some((x) => x.id === byEq));
ok('設備番号で見つかる', (await findSimilarTroubles(db, 'E-2')).some((x) => x.id === byEq));

// あいまい: ひらがな・全角英数
ok('ひらがなで入力してもカタカナの記録が見つかる', (await findSimilarTroubles(db, 'こんぷれっさ')).some((x) => x.id === oldBoth));

// 応答に検索用の内部列を含めない
r = await findSimilarTroubles(db, 'コンプレッサ 異音', { limit: 3 });
ok('応答に hay / score / same_eq を含めない', r.every((x) => !('hay' in x) && !('score' in x) && !('same_eq' in x)), JSON.stringify(Object.keys(r[0] || {})));

// D1 の bind 上限（100）: 長音付きカタカナを5語入れても収まる
await findSimilarTroubles(db, 'コンプレッサー モーター フィルター ヒーター ポンプー', { limit: 20, equipmentId: 1, excludeId: 999 });
ok('長音付きカタカナ5語＋設備＋除外でも、bind が D1 の上限（100）に収まる', lastBindCount <= 100 && lastBindCount > 0, `bind=${lastBindCount}`);

// 1文字・空は検索しない
ok('1文字は空配列（ノイズ防止）', (await findSimilarTroubles(db, 'あ')).length === 0 && (await findSimilarTroubles(db, '  ')).length === 0);

console.log(`\n========== 単体（類似トラブル）: ${pass} 件成功 / ${fail} 件失敗 ==========`);
if (fail > 0) process.exit(1);
