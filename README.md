# 設備保全オールインワンアプリ

工場の設備保全業務（点検〜修理〜在庫〜報告）を現場のスマホで完結させる社内向け PWA。
Cloudflare（Pages / Functions / D1 / R2 / Access）のみで完結し、外部サービスには依存しません。

機能仕様・設計ルールは [CLAUDE.md](./CLAUDE.md) を参照してください。

## 技術構成

| レイヤー | 技術 | 役割 |
|---|---|---|
| フロントエンド | Cloudflare Pages | 静的SPA配信（PWA）。GitHub push で自動デプロイ |
| API | Pages Functions（`functions/`） | REST API。Workers ランタイムで動作 |
| データベース | Cloudflare D1（`mainte-db`） | 全業務データ |
| ファイル保存 | Cloudflare R2（`mainte-files`） | 写真・動画・PDF（非公開運用） |
| アクセス制御 | Cloudflare Access | 社内限定公開（メール許可リスト + One-time PIN） |

## 初回セットアップ

> ⚠️ **必ず「Pages」プロジェクトとして作成すること（Worker としてではなく）。**
> リポジトリ接続時に「Deploy command: `npx wrangler deploy`」と表示される画面は **Worker 用**の接続フローであり、
> そのままデプロイすると `Missing entry-point to Worker script or to assets directory` エラーで失敗する。
> 間違えて Worker として作成した場合は、そのプロジェクトを削除（該当プロジェクト → Settings → Delete）し、
> 下記の手順5で **「Pages」タブから**作り直す。

### 1. アカウント準備

Cloudflare アカウント（無料プラン）を作成し、**2FA を必ず設定**する。

### 2. D1 データベース作成（※ Pages 接続より先に行う）

ダッシュボード: 「ストレージとデータベース」→ D1 →「データベースを作成」→ 名前 `mainte-db`
（CLI の場合: `npx wrangler d1 create mainte-db`）

作成後に表示される **Database ID（UUID）** を `wrangler.toml` の `database_id` に貼り付けて
commit & push する。
**ID が仮値（`00000000-...`）のままだと Pages のデプロイが失敗する**ため、必ず先に反映すること。

### 3. R2 バケット作成

ダッシュボード: R2 →「バケットを作成」→ 名前 `mainte-files` / ロケーション: アジア太平洋（APAC）
（CLI の場合: `npx wrangler r2 bucket create mainte-files --location apac`）

### 4. スキーマ適用

`schema.sql` の初期管理者プレースホルダー（`admin@example.com`）を
**実際の管理者のメールアドレスに書き換えてから**適用する。

- CLI: `npx wrangler d1 execute mainte-db --remote --file=schema.sql`
- ダッシュボード: D1 → `mainte-db` →「コンソール」に `schema.sql` の内容を貼り付けて実行

### 5. Pages プロジェクト作成（Git 連携）

1. Workers & Pages →「作成」→ **「Pages」タブ** →「Git に接続」
2. 本リポジトリを選択
3. ビルド設定: フレームワークプリセット「なし」/ ビルドコマンド: **空欄** / ビルド出力ディレクトリ: `/`
   （Pages にデプロイコマンドの入力欄はない。`functions/` ディレクトリは自動で API として認識される）
4. 「保存してデプロイ」

デプロイ後、プロジェクトの Settings → Bindings（旧 Functions タブ）で
D1（`DB` → `mainte-db`）と R2（`FILES` → `mainte-files`）が紐づいていることを確認する
（`wrangler.toml` から自動反映される。されていない場合は手動で追加する）。

※ 本番ブランチはリポジトリのデフォルトブランチが使われる（Settings → Builds で変更可能）。

### 6. Access（社内限定公開）— 運用開始前に必須

Zero Trust → Access → Applications →「Self-hosted」を追加する。

- 対象ドメイン: `<プロジェクト名>.pages.dev`（**プレビューURL `*.<プロジェクト名>.pages.dev` も保護対象に含めること**）
- ポリシー: Allow / 会社ドメインのメール（または利用者10名を個別登録）
- 認証方式: One-time PIN / セッション期間: 1ヶ月

**Access の設定が完了するまでアプリの URL を共有しないこと**（下記セキュリティ運用メモ参照）。

### 7. 動作確認

アプリの URL を開く → Access のワンタイムコード認証 → ホーム画面右上に
管理者の名前と「管理者」バッジが表示されれば、D1・Access 連携まで正常。
以降の利用者登録は管理画面（Phase 5 で実装）から行う。

## ローカル開発

```sh
# wrangler は npx で都度実行（インストール不要）
cp .dev.vars.example .dev.vars       # ローカルのログインユーザーを設定
npx wrangler d1 execute mainte-db --local --file=schema.sql   # ローカルD1にスキーマ適用
npx wrangler pages dev .             # http://localhost:8788 で起動
```

- ローカルでは Cloudflare Access が無いため、`.dev.vars` の `DEV_USER_EMAIL` のユーザーとしてログインした扱いになる
- ローカル D1 のデータは `.wrangler/`（git管理外）に保存される

## バージョン復元（3層の安全網）

「編集してアプリが動かなくなった」「データを誤って消した」ときの復旧手段です。

### 1. アプリ本体のロールバック（第一手）

デプロイで画面が壊れたら、まず直前のデプロイに戻します（ワンクリック・即時）。

1. Cloudflare ダッシュボード → Workers & Pages → 本プロジェクト
2. 「Deployments（デプロイ）」タブで正常だった頃のデプロイを探す
3. そのデプロイの「…」メニュー → **「Rollback to this deployment（このデプロイにロールバック）」**
4. 数秒で本番URLが旧バージョンに切り替わる（git の履歴はそのまま。原因修正後に再デプロイすれば解除される）

### 2. データベースの復元（D1 Time Travel）

誤削除・誤更新は、過去30日間の任意時点へ復元できます。

```sh
# 現在の復元ポイント（ブックマーク）を確認
npx wrangler d1 time-travel info mainte-db

# 指定時刻の状態へ復元（UNIXタイムスタンプ or ブックマークID）
npx wrangler d1 time-travel restore mainte-db --timestamp=<unix-timestamp>
```

※ 復元はデータベース全体に効くため、実行前に `time-travel info` で現時点のブックマークを控えておくこと。
なお通常の「誤って削除した1件を戻す」は、アプリの論理削除復元機能（管理画面・Phase 5）を先に使う。

### 3. マスタ設定の復元（master_history）

点検項目マスタやカスタムフォーム定義などの設定変更は、変更前の内容が
`master_history` テーブルに自動保存され、管理画面（Phase 5）から旧バージョンへ戻せます。

## セキュリティ運用メモ

- **Cloudflare Access を必ず有効にしてから運用する。** API はAccess が付与するヘッダー
  `Cf-Access-Authenticated-User-Email` でユーザーを識別するため、Access の保護が無い状態で
  公開するとヘッダー偽装によるなりすましが可能になる（プレビューURLも保護対象に含める）
- `DEV_USER_EMAIL` はローカル開発専用。**本番環境の環境変数には絶対に設定しない**
- R2 バケットは非公開で運用し、`r2.dev` パブリックURLは有効化しない（ファイルは Functions 経由で配信）
- Cloudflare アカウントの 2FA 必須

## ディレクトリ構成（現状）

```
/
├── index.html              # ホーム（機能メニュー）
├── manifest.json           # PWAマニフェスト
├── sw.js                   # Service Worker（静的キャッシュ・オフライン起動）
├── icons/                  # PWAアイコン（scripts/make-icons.mjs で生成）
├── css/style.css           # 共通スタイル（スマホ375px基準）
├── js/
│   ├── api.js              # fetchラッパー
│   └── auth.js             # ログインユーザー情報・権限判定
├── functions/api/          # Pages Functions（REST API）
│   ├── _middleware.js      # 共通: Access認証・エラーハンドリング
│   ├── _lib/               # 共通モジュール（auth/audit/http/util）
│   └── me.js               # GET /api/me — ログインユーザー情報
├── scripts/make-icons.mjs  # アイコン生成（依存なし）
├── schema.sql              # D1テーブル定義（冪等・マイグレーションは末尾に追記）
├── wrangler.toml           # D1/R2バインディング
└── CLAUDE.md               # 機能仕様・設計ルール
```

## 開発状況

| フェーズ | 内容 | 状態 |
|---|---|---|
| Phase 0 | 基盤構築（D1スキーマ / Functions雛形 / PWA基盤 / Access設定手順） | ✅ 完了 |
| Phase 1 | 設備台帳（06）+ 点検実施（02） | 未着手 |
| Phase 2 | 保全計画（01）+ トラブル記録（04） | 未着手 |
| Phase 3 | 修理依頼（03）+ 部品在庫・CSV移行（05） | 未着手 |
| Phase 4 | 日報（07）+ ダッシュボード/レポート出力（08） | 未着手 |
| Phase 5 | 管理機能（09）+ チャット/コメント（10） | 未着手 |
| Phase 6 | 横断検索（11） | 未着手 |
