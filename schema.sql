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
-- 初期データ: 管理者ユーザー（プレースホルダー）
--   ★ 本番へ適用する前に、'admin@example.com' を実際の管理者の
--     メールアドレスへ必ず書き換えること（プレースホルダーのまま適用しない）。
--     Cloudflare Access の許可リストにも同じメールアドレスを登録する。
--     2人目以降の利用者は管理画面（Phase 5）から登録する。
-- ---------------------------------------------------------------------
INSERT INTO users (email, name, group_name, role, created_by)
SELECT 'admin@example.com', '管理者', '保全G', 'admin', 'system'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = 'admin@example.com'
);

-- =====================================================================
-- マイグレーション（既存環境向けの変更は以下に追記する）
--   例: ALTER TABLE xxx ADD COLUMN yyy TEXT;
-- =====================================================================
