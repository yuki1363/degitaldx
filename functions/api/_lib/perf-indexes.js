// 読み取り行数を減らすための索引（性能）
//
//   D1 は「読み取った行数」で無料枠（500万行/日）が減る。索引が無いと、次のような
//   「毎日・何度も開く画面」が、使うほど（データが増えるほど）重くなっていた
//   （2年ほど使った想定の約6万件のデータで、D1自身の計測値 rows_read を測った実測）:
//     ・ホームの通知（開くたび）      約2.3万行 → 数十行
//     ・チャットのピン留め探し（5秒ごと）  約300行 → 1行
//     ・点検一覧                     9,000行 → 400行
//     ・期限超過チェックの重複確認（通知1件ごと） 約340行 → 0行
//   本番の D1 には schema.sql を毎回は流さないため、API の入口（_middleware.js）で
//   ensureColumns と同じ仕組みで自動作成する（IF NOT EXISTS・1プロセスにつき1回）。
//   新しい索引を足すときは、ここと schema.sql の末尾に同じ文を足す。
import { ensureColumns } from './db-compat.js';

export const PERF_INDEX_SQL = [
  // チャット: ピン留め中のメッセージ探し（GET /api/chat が5秒ごとに呼ぶ。以前は全メッセージを読んでいた）
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_pinned ON chat_messages (channel, pinned_at) WHERE pinned_at IS NOT NULL`,
  // 通知: 新着順の一覧（ホームを開くたびに呼ぶ）と、期限超過チェックの「同じ通知を出したか」の確認
  `CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_related ON notifications (related_table, related_id, type)`,
  // 点検一覧: 新しい順に200件（索引が無いと全件を並べ替えていた）
  `CREATE INDEX IF NOT EXISTS idx_inspection_result_inspected ON inspection_result (inspected_at)`,
  // 保全計画カレンダー: 複数日の予定を終了日で探す（単日の予定は既存の予定日の索引を使う）
  `CREATE INDEX IF NOT EXISTS idx_maintenance_plan_end ON maintenance_plan (planned_end_date) WHERE planned_end_date IS NOT NULL`,
  // 監査ログ: 「旧形式の年間計画」の判定（table_name + action で絞る。以前は表全体を読んでいた）
  `CREATE INDEX IF NOT EXISTS idx_audit_log_table_action ON audit_log (table_name, action)`,
  // 部品在庫: 「他の人が変更したか」を軽く確かめる（MAX(updated_at) を索引だけで答える）
  `CREATE INDEX IF NOT EXISTS idx_parts_inventory_updated ON parts_inventory (updated_at)`,
];

/** 索引が無ければ作る。全部作れたら true（作れなかったときは次のリクエストで再試行し、3回で諦める） */
export function ensurePerfIndexes(db) {
  return ensureColumns(db, 'perf_indexes_v1', PERF_INDEX_SQL);
}
