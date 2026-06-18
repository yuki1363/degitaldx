-- =====================================================================
-- 設備保全オールインワンアプリ D1 スキーマ
--
-- 適用方法:
--   ローカル: npx wrangler d1 execute mainte-db --local  --file=schema.sql
--   本番:     npx wrangler d1 execute mainte-db --remote --file=schema.sql
--   ※ IF NOT EXISTS / 存在チェック付きのため、再実行しても安全（冪等）
--
-- 共通設計（CLAUDE.md 参照）:
--   - 全業務テーブルに共通監査列を持たせる:
--       created_by / created_at / updated_by / updated_at / deleted_by / deleted_at
--   - 削除は論理削除（deleted_at に日時を入れる）。物理 DELETE は行わない
--   - すべての追加・編集・削除・復元を audit_log に記録する
--   - 日時は UTC の ISO 8601（例 2026-06-12T01:23:45Z）で保存し、表示時に JST へ変換
--   - テーブル・列名はスネークケースの英語で統一
--
-- 既存環境への変更は、このファイルの末尾「マイグレーション」節に
-- ALTER TABLE 等で追記する（既存データを壊さないこと）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- users — 利用者マスタ（09 管理機能）
--   role: viewer = 閲覧のみ / editor = 入力可 / admin = 管理者
--   email は Cloudflare Access のヘッダー
--   Cf-Access-Authenticated-User-Email と突合するキー
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  group_name  TEXT,
  role        TEXT    NOT NULL DEFAULT 'viewer'
                      CHECK (role IN ('viewer', 'editor', 'admin')),
  -- 共通監査列
  created_by  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by  TEXT,
  updated_at  TEXT,
  deleted_by  TEXT,
  deleted_at  TEXT
);

-- ---------------------------------------------------------------------
-- audit_log — 監査ログ（全機能の追加・編集・削除・復元を記録）
--   diff_json には変更内容（変更前後の差分 or 登録内容）を JSON で保存
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT    NOT NULL,
  record_id   INTEGER NOT NULL,
  action      TEXT    NOT NULL
                      CHECK (action IN ('create', 'update', 'delete', 'restore')),
  changed_by  TEXT    NOT NULL,
  changed_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  diff_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_record
  ON audit_log (table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_changed_at
  ON audit_log (changed_at);

-- ---------------------------------------------------------------------
-- master_history — マスタ変更履歴（バージョン復元の第3層）
--   点検項目マスタ・カスタムフォーム定義などの変更前スナップショットを保存し、
--   管理画面（09）から旧バージョンへ復元できるようにする。
--   master_name: 対象マスタ名（例 'inspection_master', 'trouble_category'）
--   record_id  : 対象レコードID（マスタ全体のスナップショットの場合は NULL）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  master_name   TEXT    NOT NULL,
  record_id     INTEGER,
  snapshot_json TEXT    NOT NULL,
  changed_by    TEXT    NOT NULL,
  changed_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_master_history_master
  ON master_history (master_name, changed_at);

-- ---------------------------------------------------------------------
-- files — R2 保存ファイルのメタデータ（容量上限ガードの台帳を兼ねる）
--   R2 オブジェクト1件につき1行。使用量 = SUM(size_bytes)
--   論理削除してもオブジェクトは R2 に残るため、使用量には含まれ続ける
--   （R2 オブジェクトごと消す物理削除は管理画面（Phase 5）で実装予定）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key        TEXT    NOT NULL UNIQUE,
  file_name     TEXT    NOT NULL,
  content_type  TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  related_table TEXT,
  related_id    INTEGER,
  -- 共通監査列
  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by    TEXT,
  updated_at    TEXT,
  deleted_by    TEXT,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_related
  ON files (related_table, related_id);

-- ---------------------------------------------------------------------
-- storage_reports — 保存容量に関する管理者への報告
--   アップロード時に容量上限で拒否された／警告ラインを超えた場合に、
--   利用者が報告画面から送信する。管理者はホーム画面で件数を確認できる。
--   context: blocked = 上限で拒否された / warning = 警告ライン超え
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  context          TEXT    NOT NULL CHECK (context IN ('blocked', 'warning')),
  used_bytes       INTEGER NOT NULL,
  hard_limit_bytes INTEGER NOT NULL,
  message          TEXT,
  -- 共通監査列（created_by = 報告者）
  created_by       TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by       TEXT,
  updated_at       TEXT,
  deleted_by       TEXT,
  deleted_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_storage_reports_created_at
  ON storage_reports (created_at);

-- ---------------------------------------------------------------------
-- equipment_ledger — 設備台帳（06）
--   code はQRコード・ラベルに使う設備番号（一意）
--   status: active = 稼働中 / stopped = 停止中 / retired = 廃棄
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS equipment_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  location     TEXT,
  manufacturer TEXT,
  model        TEXT,
  installed_on TEXT,
  status       TEXT    NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'stopped', 'retired')),
  note         TEXT,
  -- 共通監査列
  created_by   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by   TEXT,
  updated_at   TEXT,
  deleted_by   TEXT,
  deleted_at   TEXT
);

-- ---------------------------------------------------------------------
-- inspection_master — 点検項目マスタ（02）
--   input_type: ok_ng = OK/NG / number = 数値 / select = 選択式 / text = 自由記述
--   number の min_value / max_value が異常値アラートの上下限
--   変更時は master_history に変更前スナップショットを保存する
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspection_master (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment_ledger (id),
  name         TEXT    NOT NULL,
  input_type   TEXT    NOT NULL DEFAULT 'ok_ng'
                       CHECK (input_type IN ('ok_ng', 'number', 'select', 'text')),
  unit         TEXT,
  min_value    REAL,
  max_value    REAL,
  options_json TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- 共通監査列
  created_by   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by   TEXT,
  updated_at   TEXT,
  deleted_by   TEXT,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_inspection_master_equipment
  ON inspection_master (equipment_id, sort_order);

-- ---------------------------------------------------------------------
-- inspection_result — 点検実施記録（02）
--   items_json: 実施時点の項目スナップショット
--     [{ master_id, name, input_type, unit, min_value, max_value, value, abnormal }]
--   （マスタを後から変更しても過去の記録は当時の内容で残る）
--   has_abnormal: 異常値（基準範囲外 or NG）を含むか（一覧の色分け用）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspection_result (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment_ledger (id),
  assignee_id  INTEGER NOT NULL REFERENCES users (id),
  inspected_at TEXT    NOT NULL,
  items_json   TEXT    NOT NULL,
  has_abnormal INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  -- 共通監査列
  created_by   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by   TEXT,
  updated_at   TEXT,
  deleted_by   TEXT,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_inspection_result_equipment
  ON inspection_result (equipment_id, inspected_at);

-- ---------------------------------------------------------------------
-- 初期データ: 管理者ユーザー（プレースホルダー）
--   ★ 本番へ適用する前に、'admin@example.com' を実際の管理者の
--     メールアドレスへ必ず書き換えること（プレースホルダーのまま適用しない）。
--     Cloudflare Access の許可リストにも同じメールアドレスを登録する。
--     2人目以降の利用者は管理画面（Phase 5）から登録する。
--   ※ users テーブルが空のときだけ投入される（運用中のDBに schema.sql を
--     再実行しても余計なユーザーが追加されない）
-- ---------------------------------------------------------------------
INSERT INTO users (email, name, group_name, role, created_by)
SELECT 'admin@example.com', '管理者', '保全G', 'admin', 'system'
WHERE NOT EXISTS (
  SELECT 1 FROM users
);

-- ---------------------------------------------------------------------
-- maintenance_plan — 保全計画（01）
--   plan_type: inspection=点検 / parts=部品交換 / construction=工事 / other=その他
--   status: pending=未実施 / done=完了 / overdue=期限超過
--   recurrence_rule: 繰り返しルール（例 'monthly', 'yearly', 'every:7'）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_plan (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id     INTEGER REFERENCES equipment_ledger (id),
  plan_type        TEXT    NOT NULL DEFAULT 'inspection'
                           CHECK (plan_type IN ('inspection', 'parts', 'construction', 'other')),
  title            TEXT    NOT NULL,
  planned_date     TEXT    NOT NULL,
  recurrence_rule  TEXT,
  assignee_id      INTEGER REFERENCES users (id),
  status           TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'done', 'overdue')),
  note             TEXT,
  -- 共通監査列
  created_by       TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by       TEXT,
  updated_at       TEXT,
  deleted_by       TEXT,
  deleted_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_plan_date
  ON maintenance_plan (planned_date, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_plan_equipment
  ON maintenance_plan (equipment_id);

-- ---------------------------------------------------------------------
-- trouble_category — トラブルジャンルマスタ（04）
--   変更時は master_history にスナップショットを保存する
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trouble_category (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- 共通監査列
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by  TEXT,
  updated_at  TEXT,
  deleted_by  TEXT,
  deleted_at  TEXT
);

-- ---------------------------------------------------------------------
-- trouble_record — トラブル記録（04）
--   phenomenon: 現象（必須）
--   cause / countermeasure: 原因・対策（任意）
--   custom_fields_json: 管理者が追加したカスタム項目の値 JSON
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trouble_record (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id       INTEGER REFERENCES equipment_ledger (id),
  category_id        INTEGER REFERENCES trouble_category (id),
  occurred_at        TEXT    NOT NULL,
  phenomenon         TEXT    NOT NULL,
  cause              TEXT,
  countermeasure     TEXT,
  custom_fields_json TEXT,
  -- 共通監査列
  created_by         TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by         TEXT,
  updated_at         TEXT,
  deleted_by         TEXT,
  deleted_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_trouble_record_occurred
  ON trouble_record (occurred_at);
CREATE INDEX IF NOT EXISTS idx_trouble_record_equipment
  ON trouble_record (equipment_id);
CREATE INDEX IF NOT EXISTS idx_trouble_record_category
  ON trouble_record (category_id);

-- 初期トラブルジャンル
INSERT INTO trouble_category (name, sort_order, created_by)
SELECT '電気', 1, 'system' WHERE NOT EXISTS (SELECT 1 FROM trouble_category WHERE name = '電気');
INSERT INTO trouble_category (name, sort_order, created_by)
SELECT '機械', 2, 'system' WHERE NOT EXISTS (SELECT 1 FROM trouble_category WHERE name = '機械');
INSERT INTO trouble_category (name, sort_order, created_by)
SELECT '油空圧', 3, 'system' WHERE NOT EXISTS (SELECT 1 FROM trouble_category WHERE name = '油空圧');
INSERT INTO trouble_category (name, sort_order, created_by)
SELECT '制御・PLC', 4, 'system' WHERE NOT EXISTS (SELECT 1 FROM trouble_category WHERE name = '制御・PLC');
INSERT INTO trouble_category (name, sort_order, created_by)
SELECT '安全', 5, 'system' WHERE NOT EXISTS (SELECT 1 FROM trouble_category WHERE name = '安全');
INSERT INTO trouble_category (name, sort_order, created_by)
SELECT 'その他', 6, 'system' WHERE NOT EXISTS (SELECT 1 FROM trouble_category WHERE name = 'その他');

-- ---------------------------------------------------------------------
-- repair_request — 修理依頼（03）
--   status: open=受付 / in_progress=対応中 / waiting_parts=部品待ち / done=完了
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repair_request (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER REFERENCES equipment_ledger (id),
  title        TEXT    NOT NULL,
  description  TEXT,
  status       TEXT    NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'in_progress', 'waiting_parts', 'done')),
  assignee_id  INTEGER REFERENCES users (id),
  -- 共通監査列
  created_by   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by   TEXT,
  updated_at   TEXT,
  deleted_by   TEXT,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_repair_request_status
  ON repair_request (status, created_at);
CREATE INDEX IF NOT EXISTS idx_repair_request_equipment
  ON repair_request (equipment_id);

-- ---------------------------------------------------------------------
-- repair_history — 修理依頼ステータス変更履歴（03）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repair_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES repair_request (id),
  old_status TEXT,
  new_status TEXT    NOT NULL,
  comment    TEXT,
  changed_by TEXT    NOT NULL,
  changed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_repair_history_request
  ON repair_history (request_id, changed_at);

-- ---------------------------------------------------------------------
-- parts_inventory — 部品在庫（05）
--   part_no は部品番号（一意）
--   safety_stock: 安全在庫数（これを下回るとアラート）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parts_inventory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  part_no      TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  spec         TEXT,
  unit         TEXT    NOT NULL DEFAULT '個',
  quantity     INTEGER NOT NULL DEFAULT 0,
  safety_stock INTEGER NOT NULL DEFAULT 0,
  location     TEXT,
  supplier     TEXT,
  note         TEXT,
  -- 共通監査列
  created_by   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by   TEXT,
  updated_at   TEXT,
  deleted_by   TEXT,
  deleted_at   TEXT
);

-- ---------------------------------------------------------------------
-- parts_transaction — 部品入出庫履歴（05）
--   type: in=入庫 / out=出庫 / adjust=棚卸調整
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parts_transaction (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id    INTEGER NOT NULL REFERENCES parts_inventory (id),
  type       TEXT    NOT NULL CHECK (type IN ('in', 'out', 'adjust')),
  quantity   INTEGER NOT NULL,
  note       TEXT,
  created_by TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_transaction_part
  ON parts_transaction (part_id, created_at);

-- ---------------------------------------------------------------------
-- report_category — 日報カテゴリマスタ（07）
--   変更時は master_history にスナップショットを保存する
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_category (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- 共通監査列
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by  TEXT,
  updated_at  TEXT,
  deleted_by  TEXT,
  deleted_at  TEXT
);

-- ---------------------------------------------------------------------
-- daily_report — 日報（07）
--   report_date: YYYY-MM-DD
--   linked_records_json: [{ type: 'trouble'|'inspection'|'repair', id: N }]
--   記録した時点で全員が閲覧可能（提出・承認の概念なし）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_report (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id         INTEGER NOT NULL REFERENCES users (id),
  report_date         TEXT    NOT NULL,
  category_id         INTEGER REFERENCES report_category (id),
  body                TEXT    NOT NULL,
  linked_records_json TEXT,
  -- 共通監査列
  created_by          TEXT    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by          TEXT,
  updated_at          TEXT,
  deleted_by          TEXT,
  deleted_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_report_date
  ON daily_report (report_date, reporter_id);
CREATE INDEX IF NOT EXISTS idx_daily_report_category
  ON daily_report (category_id);

-- 初期日報カテゴリ
INSERT INTO report_category (name, sort_order, created_by)
SELECT '日常点検', 1, 'system' WHERE NOT EXISTS (SELECT 1 FROM report_category WHERE name = '日常点検');
INSERT INTO report_category (name, sort_order, created_by)
SELECT '工事', 2, 'system' WHERE NOT EXISTS (SELECT 1 FROM report_category WHERE name = '工事');
INSERT INTO report_category (name, sort_order, created_by)
SELECT 'トラブル対応', 3, 'system' WHERE NOT EXISTS (SELECT 1 FROM report_category WHERE name = 'トラブル対応');
INSERT INTO report_category (name, sort_order, created_by)
SELECT '引き継ぎ', 4, 'system' WHERE NOT EXISTS (SELECT 1 FROM report_category WHERE name = '引き継ぎ');
INSERT INTO report_category (name, sort_order, created_by)
SELECT 'その他', 5, 'system' WHERE NOT EXISTS (SELECT 1 FROM report_category WHERE name = 'その他');

-- ---------------------------------------------------------------------
-- comments — 各レコードへのコメントスレッド（10）
--   related_table: 'trouble_record' / 'inspection_result' / 'repair_request' / 'daily_report'
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  related_table TEXT    NOT NULL,
  related_id    INTEGER NOT NULL,
  body          TEXT    NOT NULL,
  -- 共通監査列
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by    TEXT,
  updated_at    TEXT,
  deleted_by    TEXT,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_related
  ON comments (related_table, related_id, created_at);

-- ---------------------------------------------------------------------
-- chat_messages — グループチャット（シフト引き継ぎ等）（10）
--   channel: 将来の複数チャンネル拡張用。現状は 'general' 固定
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT    NOT NULL DEFAULT 'general',
  body        TEXT    NOT NULL,
  -- 共通監査列
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by  TEXT,
  updated_at  TEXT,
  deleted_by  TEXT,
  deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel
  ON chat_messages (channel, created_at);

-- ---------------------------------------------------------------------
-- trouble_custom_field — トラブル記録のカスタム項目定義（04 フォームビルダー）
--   管理画面（09）から項目の追加・編集・削除が可能。
--   値は trouble_record.custom_fields_json に
--   [{ field_id, name, value }] 形式で保存（項目を後から変更しても過去の記録は残る）。
--   変更時は master_history にスナップショットを保存する
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trouble_custom_field (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  input_type   TEXT    NOT NULL DEFAULT 'text'
                       CHECK (input_type IN ('text', 'number', 'select')),
  options_json TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- 共通監査列
  created_by   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by   TEXT,
  updated_at   TEXT,
  deleted_by   TEXT,
  deleted_at   TEXT
);

-- =====================================================================
-- マイグレーション（既存環境向けの変更は以下に追記する）
--   例: ALTER TABLE xxx ADD COLUMN yyy TEXT;
-- =====================================================================

-- ---------------------------------------------------------------------
-- notifications — 通知センター（最近の動き・アラート）
--   発生イベント: parts_zero=部品在庫0 / inspection_abnormal=点検の異常値・NG /
--                 trouble=トラブル記録の新規登録
--   level: info / warning / alert（表示の色分け）
--   既読はチーム共有方式: 誰か1人が確認すると全員の未読数が減る。
--     acknowledged_by / acknowledged_at に確認者・確認日時を記録する。
--   link_url: クリック時に遷移する該当レコードの画面URL
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL,
  level           TEXT    NOT NULL DEFAULT 'info'
                          CHECK (level IN ('info', 'warning', 'alert')),
  title           TEXT    NOT NULL,
  body            TEXT,
  related_table   TEXT,
  related_id      INTEGER,
  link_url        TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  -- 共通監査列
  created_by      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by      TEXT,
  updated_at      TEXT,
  deleted_by      TEXT,
  deleted_at      TEXT
);

-- 未読（未確認）の集計と新着順表示に使うインデックス
CREATE INDEX IF NOT EXISTS idx_notifications_unack
  ON notifications (acknowledged_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_type
  ON notifications (type, created_at);

-- ---------------------------------------------------------------------
-- parts_inventory の項目見直し（05 部品在庫）
--   表示項目: ライン名 / 機器名 / 部品名 / 型番(model_no) / 在庫場所(location) /
--             必要数(safety_stock) / 在庫数(quantity) / 重要度(importance) /
--             仕入れ先(supplier) / 備考(note)
--   ・ライン/機器ごとに同じ型番を別行で持てるよう、型番は新列 model_no で管理する
--     （重複可）。内部の一意キー part_no は残し、新規行はアプリ側で自動採番する
--     （画面には出さない内部キー）。テーブルを作り直さないので外部キー
--     （parts_transaction → parts_inventory）にも影響せず、再実行しても安全。
--   ・発注メール用の supplier_email も追加する
--   ・旧列 spec(仕様) / unit(単位) は列だけ残す（画面では非表示）
--
--   ※ ALTER は初回のみ。適用済みのDBで再実行すると「duplicate column name」
--     エラーになるが、移行は完了済みなので無視してよい（必要なら適用済みの
--     ALTER 行をコメントアウトして再実行する）。
-- ---------------------------------------------------------------------
ALTER TABLE parts_inventory ADD COLUMN model_no TEXT;        -- 型番（重複可）
ALTER TABLE parts_inventory ADD COLUMN line_name TEXT;       -- ライン名
ALTER TABLE parts_inventory ADD COLUMN equipment_name TEXT;  -- 機器名
ALTER TABLE parts_inventory ADD COLUMN importance TEXT;      -- 重要度（高/中/低）
-- 既存の部品番号(part_no)を型番(model_no)として引き継ぐ（未設定の行のみ・冪等）
UPDATE parts_inventory SET model_no = part_no WHERE model_no IS NULL;
-- 発注メール宛先（前回機能で追加済みの場合は duplicate column エラーを無視）
ALTER TABLE parts_inventory ADD COLUMN supplier_email TEXT;

-- 保全計画（01）: 期間指定・設備名/担当者の自由入力化（繰り返しは廃止）
--   planned_end_date が NULL の予定は「1日のみ」。設定があれば planned_date〜planned_end_date の期間。
--   equipment_name は在庫の設備名(line_name)を参照しつつ自由入力。assignee_name は登録者を自動入力。
ALTER TABLE maintenance_plan ADD COLUMN planned_end_date TEXT;  -- 終了日（NULL=1日のみ）
ALTER TABLE maintenance_plan ADD COLUMN equipment_name TEXT;    -- 機器名（自由入力＋在庫機器名の候補）
ALTER TABLE maintenance_plan ADD COLUMN assignee_name TEXT;     -- 担当者名（自由入力）
ALTER TABLE maintenance_plan ADD COLUMN line_name TEXT;         -- 設備名（自由入力＋在庫設備名の候補。機器名はこの設備で絞り込み）

-- 設備台帳（06）: 在庫と共有する設備名・機器名を追加。
--   設備名(line_name)・機器名(equipment_name)の候補は在庫＋設備台帳から横断的に集める（/api/equipment-names）。
ALTER TABLE equipment_ledger ADD COLUMN line_name TEXT;       -- 設備名（在庫・台帳で共有）
ALTER TABLE equipment_ledger ADD COLUMN equipment_name TEXT;  -- 機器名（在庫・台帳で共有）
-- 既存データの設備名・担当者名を旧FKから引き継ぐ（未設定の行のみ・冪等）
UPDATE maintenance_plan
   SET equipment_name = (SELECT name FROM equipment_ledger WHERE id = maintenance_plan.equipment_id)
 WHERE equipment_name IS NULL AND equipment_id IS NOT NULL;
UPDATE maintenance_plan
   SET assignee_name = (SELECT name FROM users WHERE id = maintenance_plan.assignee_id)
 WHERE assignee_name IS NULL AND assignee_id IS NOT NULL;

-- 点検実施（02）・業務依頼（03）: 担当者を自由入力（assignee_name）に変更。
--   旧担当者FK(assignee_id)の列は残す（点検は NOT NULL のため登録者IDで埋める）。
--   表示・入力は assignee_name（自由入力）に一本化する。
ALTER TABLE inspection_result ADD COLUMN assignee_name TEXT;  -- 担当者名（自由入力）
ALTER TABLE repair_request    ADD COLUMN assignee_name TEXT;  -- 担当者名（自由入力）
-- 既存データの担当者名を旧FKから引き継ぐ（未設定の行のみ・冪等）
UPDATE inspection_result
   SET assignee_name = (SELECT name FROM users WHERE id = inspection_result.assignee_id)
 WHERE assignee_name IS NULL AND assignee_id IS NOT NULL;
UPDATE repair_request
   SET assignee_name = (SELECT name FROM users WHERE id = repair_request.assignee_id)
 WHERE assignee_name IS NULL AND assignee_id IS NOT NULL;

-- 設備台帳（06）: 製造番号・製造年月を追加
ALTER TABLE equipment_ledger ADD COLUMN serial_no TEXT;        -- 製造番号
ALTER TABLE equipment_ledger ADD COLUMN manufactured_on TEXT;  -- 製造年月（YYYY-MM）

-- 部品在庫（05）: 入出庫を業務依頼・トラブル対応に紐づける
--   使用部品を業務依頼から記録 → 在庫自動減算 ＋ どの依頼で使ったかを残す
ALTER TABLE parts_transaction ADD COLUMN related_table TEXT;   -- 'repair_request' / 'trouble_record'
ALTER TABLE parts_transaction ADD COLUMN related_id INTEGER;   -- 紐づく依頼・トラブルのID
CREATE INDEX IF NOT EXISTS idx_parts_transaction_related
  ON parts_transaction (related_table, related_id);

-- 日報（07）: 入力者を自由入力にする（reporter_id は NOT NULL 制約のため
--   ログインユーザーIDで埋め続け、表示・入力・検索は reporter_name に一本化）
ALTER TABLE daily_report ADD COLUMN reporter_name TEXT;        -- 入力者名（自由入力）
UPDATE daily_report
   SET reporter_name = (SELECT name FROM users WHERE id = daily_report.reporter_id)
 WHERE reporter_name IS NULL AND reporter_id IS NOT NULL;

-- 業務依頼（03）: 起票元レコード（トラブル/点検）への相互リンク
--   トラブル・点検異常から業務依頼を作成したとき、どの記録から作られたかを残す。
--   これにより 依頼→元記録 / 元記録→依頼 の双方向に辿れる。
ALTER TABLE repair_request ADD COLUMN source_table TEXT;   -- 'trouble_record' / 'inspection_result'
ALTER TABLE repair_request ADD COLUMN source_id INTEGER;   -- 起票元レコードのID
CREATE INDEX IF NOT EXISTS idx_repair_request_source
  ON repair_request (source_table, source_id);

-- トラブル記録（04）: 記録者を自由入力にする
--   従来は created_by（メール）→ users.name 解決で「記録者」を表示していたが、
--   実際に対応・記録した人を自由入力できるようにする。
--   表示は reporter_name（自由入力）を優先し、未設定の旧データは users.name で補う。
ALTER TABLE trouble_record ADD COLUMN reporter_name TEXT;  -- 記録者名（自由入力）

-- 保全計画（01）: 年間計画表の「実施月未定」枠
--   実施月を決めずに登録したタスク用のフラグ。1=未定（年間計画表の「未定」列に表示）。
--   未定の予定はプレースホルダとして planned_date に当年1/1を入れるが、カレンダー／
--   月クエリでは除外する（include_unscheduled=1 のときだけ返す）。月へ割り当てると 0 に戻す。
ALTER TABLE maintenance_plan ADD COLUMN unscheduled INTEGER;  -- 1=実施月未定

-- 保全計画（01）: 点検者を担当者と分けて持つ
--   assignee_name=担当者（責任者）, inspector_name=点検者（実施者）。年間計画表で別々に入力・表示する。
ALTER TABLE maintenance_plan ADD COLUMN inspector_name TEXT;  -- 点検者名（自由入力。担当者とは別）

-- 保全計画（01）: 年間計画表専用フラグ
--   annual_only=1 の予定はカレンダーには表示せず、年間計画表のみに表示する。
--   カレンダーは手動で日程を登録する運用とし、年間計画と分離する。
ALTER TABLE maintenance_plan ADD COLUMN annual_only INTEGER;  -- 1=年間計画表専用（カレンダーに表示しない）

-- 旧データ救済（任意）: annual_only 導入前に年間計画表から登録した予定を
-- 年間計画表専用に移行する。一括登録は「各月1日・繰り返しなし・終了日なし」で
-- 作成されるため、その特徴を持つ予定を annual_only=1 にする。
-- ※ 実行するとこれらはカレンダーから消え、年間計画表のみに表示される。
--   1日付の手動カレンダー予定も対象になりうる点に注意（不要なら個別に外す）。
UPDATE maintenance_plan
   SET annual_only = 1
 WHERE annual_only IS NULL
   AND deleted_at IS NULL
   AND recurrence_rule IS NULL
   AND planned_end_date IS NULL
   AND substr(planned_date, 9, 2) = '01';

-- 通知（notifications）: 古いスキーマで作成されたDBに acknowledged カラムが
-- 存在しない場合のマイグレーション。SQLite 3.37+ の IF NOT EXISTS を使用。
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acknowledged_at TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_by      TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at      TEXT;

-- ---------------------------------------------------------------------
-- print_templates — 帳票テンプレート（工事連絡書・トラブル報告書）
--   既存のExcel用紙を画像化してアップロードし（image_file_id = files.id）、
--   その上にデータ差込欄を位置指定（fields_json の x/y は画像に対する%）で
--   重ねて印刷する。テンプレ管理は管理者、印刷は editor（保全計画・トラブル詳細）。
--   template_type: construction_notice=工事連絡書 / trouble_report=トラブル報告書
--   orientation:   portrait=縦 / landscape=横（印刷時の用紙向き）
--   fields_json 要素例:
--     { id, kind:'data'|'date'|'manual'|'fixed', source, text, x, y, font_size, align }
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  template_type TEXT    NOT NULL
                        CHECK (template_type IN ('construction_notice', 'trouble_report')),
  image_file_id INTEGER,                              -- 背景用紙画像（files.id）。/api/files/{id} で取得
  orientation   TEXT    NOT NULL DEFAULT 'portrait',  -- 'portrait' | 'landscape'
  fields_json   TEXT    NOT NULL DEFAULT '[]',
  -- 共通監査列
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by    TEXT,
  updated_at    TEXT,
  deleted_by    TEXT,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_print_templates_type
  ON print_templates (template_type, deleted_at);
