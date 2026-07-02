// スキーマ後付け列の「自己修復マイグレーション」共通ヘルパ
//
//   schema.sql に ALTER TABLE を追記しても、本番 D1 への適用を忘れると
//   「保存したつもりが列が無くて保存されていない」事故が起きる（form_values_json で実際に発生）。
//   これを防ぐため、後付け列を使う API の入口で ensureColumns() を呼び、
//   列が無ければその場で自動追加する。
//
//   - 既に列がある場合の "duplicate column name" エラーは握りつぶす（正常系）
//   - 同じ key は1プロセス（Workers インスタンス）内で1回だけ実行する
//   - 新しい列を追加するときは、schema.sql への追記と合わせてここの呼び出し元に
//     ALTER 文を1行足すだけでよい

const ensured = new Set();

/**
 * @param {D1Database} db env.DB
 * @param {string} key 一意なキー（例: 'trouble_record'）
 * @param {string[]} alterSqls 実行する ALTER TABLE ... ADD COLUMN ... 文の配列
 */
export async function ensureColumns(db, key, alterSqls) {
  if (ensured.has(key)) return;
  for (const sql of alterSqls) {
    try { await db.prepare(sql).run(); }
    catch { /* duplicate column name（既に存在）等は無視 */ }
  }
  ensured.add(key);
}
