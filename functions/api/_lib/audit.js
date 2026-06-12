// audit_log への記録 — 全機能の追加・編集・削除・復元で必ず呼ぶこと（共通データ設計）

/**
 * 監査ログを1件記録する。
 * @param {D1Database} db        env.DB
 * @param {object}     entry
 * @param {string}     entry.tableName 対象テーブル名（例 'equipment_ledger'）
 * @param {number}     entry.recordId  対象レコードID
 * @param {'create'|'update'|'delete'|'restore'} entry.action
 * @param {string}     entry.changedBy 操作者（Access のメールアドレス）
 * @param {object|null} [entry.diff]   変更内容（登録内容 or 変更前後の差分）
 */
export async function writeAuditLog(db, { tableName, recordId, action, changedBy, diff = null }) {
  await db
    .prepare(
      `INSERT INTO audit_log (table_name, record_id, action, changed_by, diff_json)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(tableName, recordId, action, changedBy, diff === null ? null : JSON.stringify(diff))
    .run();
}
