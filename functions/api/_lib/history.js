// master_history への記録 — マスタ系テーブル（点検項目・カテゴリ等）の
// 変更時に必ず呼ぶこと（バージョン復元の第3層。CLAUDE.md 参照）。
//   - 追加時: 追加直後の内容をスナップショット（その版の記録として残す）
//   - 変更・削除時: 変更前の内容をスナップショット（旧バージョンへ戻せるように）
// 復元画面は管理機能（09 / Phase 5）で実装する。

/**
 * @param {D1Database} db
 * @param {object} entry
 * @param {string}  entry.masterName マスタ名（例 'inspection_master'）
 * @param {number}  entry.recordId   対象レコードID
 * @param {object}  entry.snapshot   保存する内容（行の全列）
 * @param {string}  entry.changedBy  操作者（メールアドレス）
 */
export async function writeMasterHistory(db, { masterName, recordId, snapshot, changedBy }) {
  await db
    .prepare(
      `INSERT INTO master_history (master_name, record_id, snapshot_json, changed_by)
       VALUES (?1, ?2, ?3, ?4)`
    )
    .bind(masterName, recordId, JSON.stringify(snapshot), changedBy)
    .run();
}
