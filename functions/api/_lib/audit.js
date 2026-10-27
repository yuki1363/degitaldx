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

// D1 の batch（1トランザクション）に入れるための監査ログ INSERT 文。
//   writeAuditLog と同じ内容を、実行せずに prepared statement として返す。業務データの書き込みと
//   同じ batch に入れれば「データは変わったのに監査ログが無い／その逆」が起きない。
//   recordId に LAST_INSERT_ID を渡すと、同じ batch で直前に実行した INSERT の ID を記録する
//   （batch は同じ接続で順に実行されるため last_insert_rowid() が直前の INSERT を指す）。
export const LAST_INSERT_ID = Symbol('last_insert_rowid');
export function auditStatement(db, { tableName, recordId, action, changedBy, diff = null }) {
  const diffJson = diff === null ? null : JSON.stringify(diff);
  if (recordId === LAST_INSERT_ID) {
    return db.prepare(
      `INSERT INTO audit_log (table_name, record_id, action, changed_by, diff_json)
       VALUES (?1, last_insert_rowid(), ?2, ?3, ?4)`
    ).bind(tableName, action, changedBy, diffJson);
  }
  return db.prepare(
    `INSERT INTO audit_log (table_name, record_id, action, changed_by, diff_json)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(tableName, recordId, action, changedBy, diffJson);
}
