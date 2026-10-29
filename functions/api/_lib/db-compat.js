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
const attempts = new Map();
const MAX_ATTEMPTS = 3; // 一時障害で失敗したときの再試行回数（超えたら諦めて false を返す）

/**
 * @param {D1Database} db env.DB
 * @param {string} key 一意なキー（例: 'trouble_record'）
 * @param {string[]} alterSqls 実行する ALTER TABLE ... ADD COLUMN ... 文の配列
 * @returns {Promise<boolean>} 全部の列が使える状態か。duplicate 以外で失敗したときは false を返し、
 *   次のリクエストで再試行する（失敗を握りつぶして「済み」にすると、一時障害のあと列が無いまま
 *   二度と再試行されなかった）。MAX_ATTEMPTS 回失敗したら再試行をやめる
 */
export async function ensureColumns(db, key, alterSqls) {
  if (ensured.has(key)) return true;
  if ((attempts.get(key) || 0) >= MAX_ATTEMPTS) return false;
  let failed = false;
  for (const sql of alterSqls) {
    try { await db.prepare(sql).run(); }
    catch (err) {
      // duplicate column name（既に存在）は正常。それ以外は失敗として数える
      if (!/duplicate column/i.test(String(err?.message))) failed = true;
    }
  }
  if (failed) {
    attempts.set(key, (attempts.get(key) || 0) + 1);
    return false;
  }
  ensured.add(key);
  return true;
}
