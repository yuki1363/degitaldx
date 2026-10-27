# CLAUDE.md — 設備保全オールインワンアプリ開発プロジェクト
## プロジェクト概要
工場の設備保全業務を現場で完結させるオールインワンWebアプリを開発する。
メンテナンス現場の生産性・稼働率向上を目的とし、点検〜修理〜在庫〜報告までを一気通貫で管理する。
参考モデル: M2X（設備保全アプリ）の機能構成。
## アーキテクチャ（Cloudflare完結構成）
データを含むすべての要素を Cloudflare の1プロジェクト内で完結させる。外部サービス（SharePoint / Power Automate 等）には依存しない。
| レイヤー | 技術 | 役割 |
|---|---|---|
| フロントエンド | Cloudflare Pages | 静的SPA配信（PWA）。GitHub push で自動デプロイ |
| API | Pages Functions（`functions/` ディレクトリ） | REST API。Workers ランタイムで動作 |
| データベース | Cloudflare D1（SQLite互換） | 全業務データ。無料枠 5GB / 読取500万行/日 / 書込10万行/日 |
| ファイル保存 | Cloudflare R2 | 写真・動画・PDF。無料枠 10GB |
| アクセス制御 | Cloudflare Access（Zero Trust） | 社内限定公開（入口認証） |

### Cloudflare 無料枠と有料化条件
**現在の構成はすべて無料枠内で動作する。ただし以下の上限を超えると自動的に課金が発生する（上限超過で止まるのではなく課金される）。**

| サービス | 無料枠 | 超過時の料金目安 |
|---|---|---|
| **Pages** | リクエスト無制限・ビルド500回/月 | ビルド超過: $5/月〜 |
| **Workers（Pages Functions）** | 10万リクエスト/日 | $0.30/100万リクエスト |
| **D1** | 5GB・読取500万行/日・書込10万行/日 | $0.001/GB・$0.001/100万行 |
| **R2** | 10GB・Class A 100万回/月・Class B 1000万回/月 | $0.015/GB（ストレージ） |
| **Access（Zero Trust）** | ユーザー50名まで無料 | 50名超: $7/ユーザー/月 |

**10名・小規模運用であれば無料枠を超えるリスクはほぼゼロ。**

課金が発生するとすれば主に R2 のストレージ（動画を大量保存した場合）。そのためアプリ側で 8GB 警告・9GB 上限ガードを実装済み（`R2_WARN_BYTES` / `R2_HARD_LIMIT_BYTES` 環境変数で変更可）。

**課金を防ぐ運用ルール:**
- Cloudflare ダッシュボード → Notifications で使用量アラートを設定しておく
- `workers.dev` パブリックURLやR2パブリックURLを公開しない（不特定多数のアクセスを防ぐ）
- Access の保護が外れた状態でURLを共有しない
### 運用前提
- **利用者**: 3名（設計上は10名程度まで余裕あり）、全員が会社メールアドレス保有。同時アクセスも少数
- **アクセス制御**: Cloudflare Access のワンタイムコード認証（会社メールの許可リスト方式）。アプリ側にログイン画面は実装しない。ログインユーザーの識別は Access が付与するヘッダー `Cf-Access-Authenticated-User-Email` を Functions 側で読み取り、`users` テーブルと突合する。環境変数 `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` を設定すると、ヘッダーの代わりに Access の署名付きJWT（`Cf-Access-Jwt-Assertion`／Cookie `CF_Authorization`）を Web Crypto で検証して email を取り出す（`functions/api/_lib/access-jwt.js`。署名鍵は `https://<チーム>/cdn-cgi/access/certs` から取得し1時間キャッシュ）。設定時はメールヘッダーと `DEV_USER_EMAIL` を無視する＝保護漏れのURL（プレビューURL等）でもヘッダー偽装でなりすませない。未設定なら従来どおりヘッダーで識別
- **利用端末**: PC / iPhone / iPad。現場はスマホ中心（スマホファーストUI必須）
- **PWA必須**: 本アプリは PWA として実装し、ネイティブアプリ同等の体験を提供する。`manifest.json`（アイコン・アプリ名・`display: standalone`・テーマカラー）と Service Worker を必ず実装。iPhone は「ホーム画面に追加」、PC は Edge/Chrome の「インストール」で配布
- **オフライン考慮**: Service Worker で静的アセットをキャッシュし、オフラインでもアプリが起動すること。入力中データは IndexedDB に一時保存し、オンライン復帰時に API へ自動同期（**送信は Web Locks（`mainte-outbox-flush`）で端末内の1タブに絞る**＝PWAの窓とブラウザのタブなど複数開いた状態で復帰しても二重登録しない。`js/offline-queue.js`）。**ページ遷移はクエリを無視してキャッシュと照合する**（`sw.js` の `ignoreSearch`。`/pages/ledger?id=` 等のクエリ付きページもオフラインで開ける）。未キャッシュ時の代替表示は `/`（`/index.html` は Pages が `/` へリダイレクトするため、リダイレクト済み応答はページ遷移に使えない）
- **ログイン切れ時の「再ログイン」ボタン**: Access セッション切れで API に届かないとき、`js/api.js` が自動で再認証へ誘導する（1回のみ・15秒ガード）。それでも届かない（メールアプリ内ブラウザ・PCのPWA窓など）かつオンラインなら、画面上部に「🔑 再ログインする」バナーを出す（`showReloginBanner`）。押すと `/cdn-cgi/access/logout?returnTo=現在のURL` へ移動して Access を再認証させる。本当のオフライン（`navigator.onLine === false`）では出さない
- **画面内通知（通知センター）**: 在庫切れ・発注アラート・入庫、点検の異常値・NG、トラブル登録、**保全計画・業務依頼の期限超過**（`plan_overdue`/`repair_overdue`）、**工事連絡書の未印刷リマインド**（`plan_print_reminder`＝工事予定の3日前までに帳票を印刷していない）を通知化（`functions/api/_lib/notify.js` の `createNotification`）。チーム共有方式（誰か1人が確認すると全員の未読が減る）。期限超過・未印刷リマインドは `functions/api/_lib/overdue-notify.js` が1時間に1回チェックし、同じ対象への重複通知はしない（`js/notifications.js`・ホームのベルアイコン）
- **プッシュ通知（Web Push）**: 上記の通知が発生するたびに、購読中の端末へブラウザ経由でも通知する（アプリを開いていなくても気づける）。RFC 8291（メッセージ暗号化）・RFC 8292（VAPID）を Web Crypto API のみで自前実装（`functions/api/_lib/webpush.js`。npm依存・ビルド工程なしの方針を維持）。通知作成の共通関数 `notifyTeam`（`functions/api/_lib/notify.js`）が `createNotification` と Web Push 送信をまとめて行う。VAPID鍵は `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`（+任意 `VAPID_SUBJECT`）環境変数で設定し、未設定の間はこの機能自体が無効になる（画面内通知は今までどおり動く）。購読は `js/notifications.js` の「🔔 プッシュ通知を有効にする」ボタンから（`POST /api/push/subscribe`／解除は `/api/push/unsubscribe`）。失効した購読（404/410応答）は自動で削除する。**送信先は有効なユーザー（`users` に存在し `deleted_at IS NULL`）の購読に限り、ユーザー削除時は購読も物理削除する**（退職者等の端末へ業務内容が届き続けないように）。**購読の endpoint は各社のプッシュサービス（fcm.googleapis.com／push.services.mozilla.com／notify.windows.com／push.apple.com）の https URL に限定**する（任意URLを登録されるとサーバーがそこへPOSTする＝SSRFのため。`isAllowedPushEndpoint`。登録時に400、送信時もスキップ）
### バージョン復元（3層の安全網）— 必須要件
「編集してアプリが動かなくなる」事故に備え、以下を必ず運用・実装する。
1. **アプリ本体**: Cloudflare Pages のデプロイ履歴から**ワンクリックで旧バージョンに即時ロールバック**できる（標準機能）。壊れたら直前のデプロイに戻すのが第一手。README にロールバック手順を記載すること
2. **データベース**: D1 の Time Travel により**過去30日間の任意時点へ復元**可能。誤削除・誤更新時の復旧手段
3. **マスタ設定**: 点検項目マスタ・カスタムフォーム定義などの設定変更は `master_history` テーブルに変更前の内容を保存し、画面から旧バージョンへ戻せるようにする
### 共通データ設計 — 監査・論理削除（全テーブル必須）
「誰が・いつ・何を」したかを全機能で追跡できるようにする。
- 全業務テーブルに共通列を持たせる: `created_by`, `created_at`, `updated_by`, `updated_at`, `deleted_by`, `deleted_at`
- **削除は論理削除**（`deleted_at` に日時を入れる）を基本とし、削除者・削除日時が後から確認できる。一覧表示では除外し、管理画面の「削除済み」タブから閲覧・復元可能
  - **例外: `users` テーブルは物理削除**（`DELETE FROM users`）。各テーブルは作成者等をメール文字列で保持しFK参照しないため過去レコードは壊れない。物理削除で同一メールの再登録も可能になる。誰を削除したかは `audit_log`（diff にメール・氏名・権限）に残す
  - **例外: `chat_messages` は送信から10日で物理削除**（短期の申し送り用途のため。📌ピン留め中は対象外・添付はR2ごと削除。削除件数と対象ID一覧を `audit_log` に記録。詳細は機能10）
- すべての追加・編集・削除操作を `audit_log` テーブルに記録: `(id, table_name, record_id, action[create/update/delete/restore], changed_by, changed_at, diff_json)`
- 各レコードの詳細画面に「変更履歴」表示（誰がいつ何を変えたか）
- 操作者は Cloudflare Access のメールアドレスから自動取得（手入力させない）
### 初回セットアップ手順
1. Cloudflare アカウント（無料プラン）を作成し、**2FA を必ず設定**
2. D1 データベース作成: `wrangler d1 create mainte-db` → `wrangler.toml` の `database_id` を実IDへ書き換え → `schema.sql` を適用（※ Pages 接続より先に行う）
3. R2 バケット作成: `wrangler r2 bucket create mainte-files`（ロケーションヒント APAC）→ バインディング `FILES` を設定
4. Workers & Pages → **「Pages」タブ** → 「Gitに接続」→ 本リポジトリを選択。ビルドコマンドなし / 出力ディレクトリ `/` でデプロイ（**Worker として接続しないこと**。「Deploy command: npx wrangler deploy」が出る画面は Worker 用で、Missing entry-point エラーになる。詳細は README）
5. Zero Trust → Access → Applications → Self-hosted を追加し、対象に `アプリ名.pages.dev` を指定
6. ポリシー: Allow / 会社ドメインのメール（または利用者10名を個別登録）。認証方式は One-time PIN。セッション期間は1ヶ月。Pages の環境変数（本番・プレビュー両方）に `ACCESS_TEAM_DOMAIN`・`ACCESS_AUD`（AccessアプリのAUDタグ）を設定してJWT検証を有効にする
7. 部品在庫の初期データ移行（機能05参照）
### コーディング方針
- フロントはフレームワークレス（Vanilla JS + HTML + CSS）。ビルド工程なしでデプロイできること
- API は Pages Functions のファイルベースルーティング（例: `functions/api/equipment/[id].js`）
- DB アクセスは D1 のプリペアドステートメント必須。SQL文字列連結禁止
- 1機能 = 1モジュール（JSファイル）に分割
- スマホ縦画面（375px幅）基準のレスポンシブ
- 日本語UI。日付は `YYYY/MM/DD`、時刻は24時間表記
- ローカル開発は `wrangler pages dev`
### 開発の進め方（Claude Code が守るルール）
- **フェーズ単位・機能単位で実装する**。指示された範囲外の機能を先回りして実装しない
- 大きな実装の前に、**まず実装計画（作成ファイル一覧・手順）を提示してユーザーの確認を取る**
- **1機能が動くごとに git commit する**（コミットメッセージは日本語で「02: 点検実施の登録APIを追加」のように機能番号付き）。動かない状態でコミットしない
- 新しいテーブル・列の追加は必ず `schema.sql` に追記し、既存データを壊さないマイグレーション（ALTER TABLE）で行う
- 実装完了時は必ず以下をセルフチェックしてから完了報告する:
  1. 共通監査列（created_by 等）と `audit_log` 記録が実装されているか
  2. 削除が論理削除になっているか
  3. SQLがプリペアドステートメントか
  4. 権限チェックが Functions 側にあるか
  5. スマホ幅（375px）でレイアウトが崩れていないか
  6. E2Eテスト（`cd tests && npm test`）が全項目パスするか
- エラー修正時は、原因の説明 → 最小限の修正、の順で行う。無関係なリファクタリングを混ぜない
- この CLAUDE.md と実装が食い違う変更を行った場合は、CLAUDE.md も同時に更新する
---
## 実装する機能一覧（全13機能）
### 01. 保全計画策定（カレンダー管理）
点検・部品交換に加えて**工事予定**も管理する。
- 予定種別: **点検 / 部品交換 / 工事 / その他**（種別ごとに色分け表示）
- カレンダー形式（月表示／週表示）で管理し、関係者全員が予定を共有
- 実行状況（完了／未実施／期限超過）をカレンダー上で色分け表示。**期限超過はAPIが自動判定**（予定日・期間予定は終了日を過ぎた未実施を overdue として返す。JST基準・DBの status は書き換えない。`deriveOverdue`）。**年間計画は月単位で判定**（毎月1日登録のため。当月は超過にせず月末までにやる扱い。日単位だと2日以降に当月分が誤超過になる）。**年間計画は毎年共通のテンプレートで planned_date の年は登録年のまま残るため、予定の「月」を今の会計年度（10月始まり9月終わり）に当てはめて判定する**（`annualMonthInCurrentFy`・`FISCAL_YEAR_START_MONTH`。年込みで比べると年度リセット直後に前年度の月が一斉に超過になり通知も一斉に出た）。10月に年度が切り替わると前年度の未実施分は超過表示から外れる（年度末に「🔁 年度リセット」でCSVに残す運用）。ホームの「年間計画 期限超過」も API の status を使い、年を比べない（`js/home-tabs.js`）
- 月次／年次などの繰り返し予定の設定（毎月第◯週、毎年◯月、◯日ごと等）
- 予定の登録・編集・削除が可能。**担当者・登録者・削除者を記録**（共通監査設計）
- **複数日にまたがる期間予定の削除は2通り**: カレンダーの日付タップ→日程シートの🗑で**その日だけ削除**（前後の日程は残る。先頭/末尾日なら開始日・終了日を詰め、途中の日なら前後で2件に分割する）／計画詳細の「🗑 全期間を削除」で**全期間を一括削除**。単日予定はどちらも同じ（`POST /api/plans/:id/delete-day`、`js/plan.js`）
- **複数日にまたがる期間予定の完了も2通り**: カレンダーの日付タップ→日程シートの✓で**その日だけ完了**（その日を完了済みの単日レコードとして切り出し、残りの日程は未完了のまま残る。先頭/末尾/途中の日いずれも delete-day と同じ分割方式）／計画詳細の「🏁 全期間を完了にする」で**全期間を一括完了**。単日予定はどちらも同じ（`POST /api/plans/:id/complete-day`、`js/plan.js`）
- 予定から点検実施画面（02）へワンタップで遷移
- **年度リセット（`POST /api/plans/annual-reset`）は管理者のみ**。監査ログに戻した予定のIDと変更前の状態（`reset_plans:[{id,from}]`）を残す
- **年間計画表のCSV取込・出力**: 行=タスク／列=12ヶ月の表形式でCSV入出力。出力は各月の完了状態（完了／未実施／期限超過）を含む。取込は同形式を `/api/plans/batch` で一括登録（`js/plan-import.js`）
- **帳票出力（工事連絡書）**: 計画詳細から、管理者が登録したExcel用紙にデータを差し込んで出力できる（Excel→PDF化の手順は後述「帳票テンプレート」）。**出力（＝印刷）した日時を記録**し（`printed_at`/`printed_by`、`POST /api/plans/:id/printed`）、計画詳細に「工事連絡書 印刷日（未印刷）」を表示する。用紙に `{{印刷日}}` タグを置けば出力日が差し込まれる。**工事予定（`plan_type='construction'`）の3日前までに未印刷なら通知**する（`plan_print_reminder`・`overdue-notify.js`。印刷すれば `printed_at` が入り対象外になる）。**担当者印の自動押印**: シーバイエス担当名（`担当`タグ）に苗字が入っていれば、用紙の担当者欄に置いた `{{担当印}}` セルへ赤シャチハタ印を自動生成して押す（専用のハンコ入力欄は不要。姓＋名なら姓だけを使う。`js/excel-fill.js`＝`担当`の値から `makeHankoPngBase64`→`embedHankos`）
**テーブル**: `maintenance_plan`（id, equipment_id, plan_type[inspection/parts/construction/other], title, planned_date, recurrence_rule, assignee_id, status, printed_at, printed_by, +共通監査列）
### 02. 点検実施（スマホ入力・報告）
- 点検項目をチェックリスト形式で表示し、スマホから簡単入力（OK/NG/数値/選択式）
- **前回値の表示**: 数値項目の入力欄に、同じ設備の直近の点検記録から「前回値（日付）と今回との差分（↑↓→）」を表示（基準内でも劣化の兆候に気づける。`buildItemInput` の第3引数 `lastInfo`、取得失敗時は表示なしで入力継続）
- 点検記録の**登録・編集・削除が可能**。担当者を選択でき、**登録者・削除者は自動記録**
- 写真・動画付きで記録・共有（R2へ保存）
- **異常値アラート**: 上下限値の範囲外入力で即座に画面警告
- 点検項目マスタの**項目追加・削除が画面からできる**（変更は `master_history` に保存し復元可能）
**テーブル**: `inspection_master`（項目定義・上下限値, +監査列）、`inspection_result`（実施記録, assignee_id, +監査列）
### 03. 業務依頼（依頼〜進捗の見える化）
- 修理に限らず保全業務への依頼全般を一元管理。「言った・言わない」問題を撲滅
- ※ UI上の名称は「業務依頼」。内部名（テーブル `repair_request` / URL `/pages/repair` / `js/repair.js`）は変更しない
- ステータス管理（受付 → 対応中 → 部品待ち → 完了）で進捗を見える化
- **優先度（高/中/低・既定は中）と対応期限（任意）**を設定可能。部品在庫05の重要度と同じ値・バッジ色を再利用。期限を過ぎて未完了（status≠完了）の依頼は一覧・詳細に「⚠期限超過」を表示（`is_overdue`、GET時の派生値。status列は書き換えない）
- コメント機能（10）と連携、設備台帳（06）と紐づけ、写真添付可能
- 依頼の登録・編集・削除と監査記録（共通設計）
**テーブル**: `repair_request`（priority, due_date, +監査列）、`repair_history`（ステータス変更履歴）
### 04. トラブル記録
- トラブルを写真や動画を添えて簡単に記録、即時共有
- **ジャンル（カテゴリ）列を必須化**: 例「電気 / 機械 / 油空圧 / 制御・PLC / 安全 / その他」。管理画面でジャンルの追加・削除が可能
- ジャンル・期間・設備での**絞り込み抽出**が一覧画面でできる（**検索するまで一覧は表示しない**＝条件を選び「🔍検索」で表示。設備台帳の「すべて見る」から設備指定で来たときだけ自動表示）
- カスタマイズ可能なトラブル記録帳票（管理者が入力項目を追加・削除できるフォームビルダー。定義変更は `master_history` で復元可能）
- 設備台帳（06）・点検結果（02）との紐づけ
- 記録の登録・編集・削除と監査記録（共通設計）
- **類似トラブル事例の表示**: 現象欄に入力すると、過去の似たトラブルを最大5件、リアルタイム表示（登録・編集フォームと詳細画面。横断検索11と同じあいまい検索＝全角半角・ひらがなカタカナのゆれを吸収）。原因・対策の参考にできる。API `GET /api/troubles/similar`、共通ロジックは `functions/api/_lib/trouble-similar.js`（`findSimilarTroubles`）。あいまい検索の中核は `functions/api/_lib/fuzzy.js` に集約し、横断検索・部品検索と共有する。取得失敗・0件・現象2文字未満のときは何も表示せず入力を止めない（点検の前回値表示と同じ流儀）
- **AIによる原因・対策の提案（任意・ボタン式）**: 登録・編集フォームの「🤖 AIに原因・対策のヒントをもらう」ボタンで、現象＋過去の類似事例をもとに Workers AI（`env.AI`）が原因・対策・確度を提案する（`POST /api/ai/suggest-trouble`、editor以上）。「反映」で原因・対策欄に流し込める（入力済みなら上書き確認）。**自動発動せずボタンを押した時だけ動く**（ニューロン無料枠を守るため。Web Pushと同じ「未構成なら機能を出さない」方式で、`env.AI` 未構成なら `/api/me` の `ai_enabled:false` を見てボタン自体を非表示にする）。過去事例テキストはプロンプト埋め込み前に150字で切り詰める（コスト・暴走防止）
- **帳票出力（トラブル報告書）**: 記録詳細から、管理者が登録したExcel用紙にデータを差し込んで出力できる（後述「帳票テンプレート」）。トラブル編集ページに「トラブル報告書（帳票）の入力」欄があり、調査対象・休止時間・休止区分(○選択)・処置・有効性の確認・特記事項・担当者印(苗字)などを入力して `form_values_json` に保存→出力時に自動差込（出力時の再入力不要。標準項目は `js/permit-fields.js` の `TROUBLE_REPORT_FIELDS`）
**テーブル**: `trouble_record`（id, equipment_id, category_id, occurred_at, phenomenon, cause, countermeasure, attachments_json, custom_fields_json, form_values_json, +監査列）、`trouble_category`（ジャンルマスタ）
### 05. 部品在庫管理（PowerAppsからのデータ移行あり）
- 使用部品を記録すると在庫に自動反映。+/−ボタンでワンタップ更新
- 発注アラート（安全在庫割れで通知）、発注 → 入庫 → 利用の一元管理
- **棚卸モード**: 一覧の「📋 棚卸」で行が「帳簿数 → 実数入力」に切り替わり、差異のある行だけ赤表示。「差異N件を一括確定」で棚卸調整（`type=adjust`・note=棚卸）として入出庫履歴に記録（editor以上。入力値はフィルタ変更をまたいで保持）
- **発注状態管理**: 発注メール作成時に「📨 発注中」バッジを付与（`parts_inventory.ordered_at/ordered_by`・API `/api/parts/:id/order`）。入庫（type=in）で自動解除。二重発注・発注漏れの防止。詳細画面から手動解除も可
- **発注メールの宛先自動入力・納期指定**: 部品マスタに登録済みの仕入先メール（`supplier_email`）を発注メール作成時の宛先へ自動セット（未登録なら空欄）。希望納期（任意）を入力すると本文に追記される（`js/parts.js` の `openOrderDialog`/`buildOrderEmail`）
- **あいまい検索・類似部品の表示**: 一覧の検索ボックス（`GET /api/parts?q=`）は横断検索11と同じあいまい検索（全角半角・ひらがなカタカナのゆれを吸収・複数語はAND・`functions/api/_lib/fuzzy.js` を共有）。**在庫検索は完全一致（全キーワードを含む＝AND）に加え、「類似の在庫」（いずれかのキーワードに一致＝OR）を別枠で表示する**（`include_similar=1` のとき `similar` 配列を返す。2語以上で検索したときだけ・完全一致で出た分は除外・最大30件。1語検索は AND と OR が同じになるため類似枠は出ない）。登録・編集フォームで部品名・型番を入力すると、型番・部品名が近い既存部品を最大5件ヒント表示し、うっかり重複登録を防ぐ（`exclude_id` で自分自身を除外。**保存は妨げない**＝型番は設計上重複可のため「重複」ではなく「類似」と表現する）
- **既存 PowerApps 部品管理アプリからのデータ移行機能**:
  - SharePoint リストを CSV エクスポート → 管理画面の「CSVインポート」で取り込み。**全置き換え（`mode=replace`）は管理者のみ**（全部品を作り直すため）、差分マージは入力可（editor）でも実行できる
  - インポート画面で CSV列 ↔ アプリ項目の**列マッピングUI**を提供（文字コードは UTF-8 / Shift_JIS 両対応）
  - 取込前にプレビュー表示、重複部品番号の検出、取込結果レポート表示
  - **差分マージ（`mode=merge`）は CSV で対応付けた列だけを更新する**（対応付けていない列はキーごと送られないので既存値を保つ。全列更新だと型番と部品名だけのマージで在庫数・場所等が0／空になった。`functions/api/parts/import.js` の `MERGE_UPDATABLE`）
  - 移行後は本アプリを正とし、PowerApps側は参照のみ → 廃止
**テーブル**: `parts_inventory`（+監査列）、`parts_transaction`（入出庫履歴）
### 06. 設備台帳
- 設備の基本情報、関連資料、トラブル・点検・修理履歴を一元管理
- **QRコード読み取り**で即座に該当設備ページへ。QR生成・ラベル印刷機能
  - **ラベル台紙は A4・40×40mm・24面（4列×6段）固定**（左右余白19mm・上下余白18.5mm・ラベル間の隙間4mm）。一括印刷（`/pages/labels`・`js/labels.js`）は24枚ごとに `.label-page`（210×297mm）へ分け、`@page { size: A4; margin: 0 }` で台紙に位置を合わせる。ラベル内はQR 27mm＋設備番号8pt＋名称6.5pt（2行まで）。台紙に縁があるため枠線は印刷しない。印刷ダイアログは「A4／倍率100%／余白なし」にする
  - **QRの誤り訂正は Q**（`ledger.js`・`labels.js`。油・汚れ・擦れ対策。H は40mm角では密度過多）。QRのURLは `window.location.origin` を埋め込むため、**ラベル印刷は必ず本番URLで行う**（プレビューURL・localhostで印刷したQRは後で開けない）
- 設備詳細から**トラブル記録・業務依頼をワンタップで新規作成**（点検開始と同様、設備を紐づけた状態でプリフィル。QRで設備を開いてすぐ記録できる）
- マニュアル・図面（PDF等）は R2 へアップロードして管理
- 設備の追加・編集・削除と監査記録（共通設計）
**テーブル**: `equipment_ledger`（+監査列）
### 07. 日報（記録・閲覧のみ）
- 日報は**記録して確認するだけ**のシンプル運用（提出・承認の概念なし。保存した時点で全員が閲覧可能）
- **カテゴリで絞り込み可能**: 日報にカテゴリを付与（例「日常点検 / 工事 / トラブル対応 / 引き継ぎ / その他」）。**カテゴリは管理画面から追加・削除可能**（`report_category` マスタ、変更は `master_history` で復元可能）
- 一覧は「日付 × 記録者 × カテゴリ」で絞り込み閲覧
- トラブル/点検/業務依頼の詳細から「日報に記録」で、本文（現象・原因等）と日付をプリフィルして日報作成画面を開ける（記録の紐づけは行わない）
- 登録・編集・削除と監査記録（共通設計）
**テーブル**: `daily_report`（id, reporter_id, report_date, category_id, body, +監査列。`linked_records_json` 列は残るが未使用＝紐づけ機能は廃止）、`report_category`（カテゴリマスタ）
### 08. ダッシュボード・レポート出力
- プリセットグラフ: トラブル件数推移、ジャンル別件数、点検実施率、設備別故障ランキング（Chart.js）
- カスタムグラフ（集計軸・期間・対象設備を選択）
- **役割分担（機能重複の解消）**: ダッシュボードは「**見る（グラフ）**」に専念する。データの絞り込み抽出→一覧表→CSV出力は**横断検索（11）に集約**した。以前あった「抽出レポート」タブは廃止し、同等のフィルタ＋CSV出力を横断検索側へ移設済み（探す＆出す=横断検索／見る=ダッシュボード）
- **例外: トラブル記録CSV**: ダッシュボード上部の「トラブル記録（期間内）📥 CSV」で、集計期間（FROM〜TO）のトラブル記録をそのままCSV出力できる（UTF-8/BOM・Shift_JIS）。列は04トラブル一覧のCSVと共通（`js/trouble-csv.js` の `TROUBLE_CSV_COLUMNS`／`exportTroubleCsv`。取得は既存 `GET /api/troubles?from=&to=` でAPI変更なし）
- **PDF出力**: 一覧・帳票はクライアント側で印刷用CSS + `window.print()` を基本とし、整形帳票が必要な箇所は jsPDF + 日本語フォント埋め込みを使用
### 09. 管理機能
- ユーザー・グループ・権限管理（閲覧のみ / 入力可 / 管理者 の3段階。承認者ロールは不要のため削除）。**ユーザー削除は物理削除**（無効化ではなく完全に削除。過去に無効化したユーザーは「再有効化」または「完全削除」が可能）
- マスタ管理画面: 点検項目・設備・部品・トラブルジャンル・ユーザーの各マスタを画面から**追加・削除可能**
- マスタ変更履歴（`master_history`）の閲覧と**旧バージョンへの復元**。電気設備点検の設定（`electrical_config`。設備種別単位で id 列が無いため `restoreElectricalConfig` で別扱い）と帳票テンプレート（更新前の定義＝入力項目 `fields_json` を含めて退避）も戻せる
- `audit_log` の閲覧画面（誰がいつ何を追加・編集・削除したかを検索）
- 削除済みデータの閲覧・復元（論理削除の復元）。対象はトラブル・業務依頼・部品・点検・日報・保全計画・設備・ユーティリティ日報・電気設備点検・帳票テンプレート（`admin/restore/index.js` の `ALLOWED_TABLES`）。**200件ずつページ送り**（`offset`。大量削除時も全件を復元できる）。ユーティリティ日報は同じ日の記録があると 409（1日1件）
- **帳票テンプレート管理**（管理者のみ）: 工事連絡書（01）・トラブル報告書（04）の指定用紙を作成。自社のExcel用紙の各セルに差込タグ（例 `{{予定日}}`）を入力して `.xlsx` をアップロード（R2・`/api/files`）。各詳細画面の「帳票出力」で、タグを実データに置換した `.xlsx` をダウンロードする（`js/excel-fill.js` が JSZip で内部XMLのタグ文字列だけ置換するため、書式・罫線・結合セル等のレイアウトは完全保持）。PDFが必要なら出力したExcelを開いて「PDFで保存／エクスポート」する（ブラウザ単体ではExcel→PDF自動変換ができないため）。管理は admin、出力は editor。API は `/api/print-templates`（GET=認証済み全員／POST・PUT・DELETE=admin）。`print_templates.image_file_id` にExcelの files.id を格納する（orientation は未使用）。差込タグは2種類: **自動タグ**（計画/トラブル記録から自動。トラブル報告書は発生年月日を `{{発生年}}{{発生月}}{{発生日}}` に分解可）と、**入力項目**（`fields_json`。出力時にフォームで入力）。入力項目の種類は 文字／複数行／日付／時刻／チェック(レ点=✓)／**○で1つ選択**（選んだ選択肢名のセル `{{故障休止}}` 等に○）／**ハンコ(赤丸印)**（苗字入力で `{{担当者印}}` セルに赤丸＋苗字の印影画像を埋め込み。`js/hanko.js`＝Canvas生成、`js/xlsx-image.js`＝xlsxにoneCellAnchorで画像追加）。**タグ確認機能**: テンプレ編集画面の「🔍 Excelのタグを確認」で、アップロード済みExcelの `{{タグ}}` を抽出し、差込対象と突合して「Excelにあるが対応項目が無いタグ（誤字）」「項目はあるがExcelにタグが無いもの（＝出力されない）」を表示（休止時間が出ない・○が付かない等のタグ名不一致を管理者が自力で発見できる。`js/excel-fill.js` の `extractTemplateTags`）
**テーブル**: `users`（email, name, group_name, role, +監査列）、`master_history`、`audit_log`、`print_templates`（name, template_type[construction_notice/trouble_report], image_file_id, orientation, fields_json, +監査列）
### 10. チャット
- グループチャットでシフト間の引き継ぎ
- ※ レコード別のコメントスレッドは運用簡素化のため**廃止**（UI・API とも削除済み。`comments` テーブルは過去データ保持のためスキーマに残置）
- 画面表示中は**5秒ポーリング**でほぼ即時表示（タブが裏に回ったら停止して無駄なリクエストを出さない）。必要なら Durable Objects + WebSocket へ拡張
- **既読数は送信者本人を数えない**（自分の投稿を自分が見ても既読は付かない。ホームの「◯人中N人既読」も送信者を除いた人数）
- **👍確認リアクション**: 既読（=見た）とは別に「了解した」をタップで表明できる（editor以上・他人の投稿のみ。誰が確認したか名前で表示）。`chat_reactions` テーブルにトグル保存し audit_log に記録。`POST /api/chat/:id`（action=react）
- **📌ピン留め**: 重要な申し送りをピン留めすると**10日自動削除の対象外**になり（メッセージを削除するとピン留めも外れる＝削除済みが永久に残らない）、画面上部のバーに常時表示（タップで該当メッセージへジャンプ・editor以上）。`chat_messages.pinned_at/pinned_by`。`PUT /api/chat/:id`（pinned=true/false）
- **既読数・👍・📌はライブ更新**: `GET /api/chat` が直近20件の meta（既読数・リアクション）と pinned 一覧を返し、5秒ポーリングでリロードなしに反映される
- **添付ファイルは本人がアップロードした未紐づけファイルのみ**（`POST /api/chat` の `file_ids`。それ以外は400）。投稿時に `attachFiles` で `related_table='chat_messages'` に紐づける。自動削除がR2から消すのも「そのメッセージに紐づくファイル」と紐づけ導入前の「投稿者本人の未紐づけファイル」だけ（他の記録のファイルIDを指定されて、そのファイルが消えるのを防ぐ）
- **メッセージは送信から10日で自動削除**（物理削除・添付はR2ごと削除しfilesをpurged扱いに、リアクションも同時削除。**📌ピン留め中は対象外**。チャットAPIのGET時に1時間に1回、waitUntilでバックグラウンド実行。DBとR2を軽く保つ）
- **投稿を記録化**: 本文のある投稿を📋ボタンから**トラブル記録／業務依頼／日報**へ昇格できる（editor以上）。10日で消える前に有益な情報を正式記録へ残す仕組み。遷移先フォームの既存URLプリフィルを流用（`/pages/trouble?new=1&phenomenon=` ／ `/pages/repair?new=1&title=&description=` ／ `/pages/report?new=1&body=`。日報は `new=1` が無いと一覧が開き本文が引き継がれない）。本文のみ引き継ぎ、写真は別途添付。**API・スキーマ変更なし**（`js/chat.js` の `buildRecordActions`）
- **申し送りテンプレート**: 定型文（【引き継ぎ】【対応中】【要確認】【完了報告】【部品発注】）をタップで入力欄へ挿入（現場スマホの入力を軽く・書き方を統一。`js/chat.js` の `HANDOFF_TEMPLATES`）
- **個人情報の入力防止**:
  - 入力欄に注意書きを常設（「氏名・電話番号・住所等の個人情報は入力しないでください」）
  - 送信時に電話番号・メールアドレス・郵便番号等のパターンを検知したら**警告ダイアログ**を表示（送信前に本人へ確認。検知はクライアント側の正規表現で実施）
**テーブル**: `chat_messages`（+監査列、pinned_at/pinned_by）、`chat_reactions`（👍確認）
### 11. 横断検索（過去データの検索・抽出）
蓄積したトラブル記録・点検履歴・修理履歴・日報をキーワードで横断検索し、過去の事例をすぐに確認できるようにする（AIは使わない通常検索）。
- 検索ボックスにキーワードを入力（例「コンプレッサ 異音」「3号機 漏れ」）すると、対象テーブルを横断して該当レコードを一覧表示
- 検索対象: トラブル記録（現象・原因・対策）/ 点検結果 / 業務依頼 / 日報本文 / 設備台帳 / 部品在庫 / 保全計画
- 絞り込みフィルタ: **期間指定 × カテゴリ/ジャンル × 設備 × データ種別**（種別チェックボックスで対象テーブルを絞れる）。カテゴリ/ジャンルは**トラブルのジャンルにのみ適用**（日報カテゴリは別マスタでIDの意味が違うため、日報には適用しない）
- 検索結果から各レコードの詳細画面へ直接ジャンプ
- **CSV出力（旧・抽出レポートの集約先）**: 検索結果（絞り込み後）を CSV でダウンロード（**UTF-8/BOM と Shift_JIS を選択可** = Excelで文字化けしない）。ダッシュボード08にあった「抽出レポート」機能はここへ集約した。設備番号列は Excel の日付変換よけに `excelText`（`="値"`）で囲む
- 実装: D1 への `LIKE` 検索を基本とする（10名規模・数万件程度なら十分高速）。複数キーワードはスペース区切りで AND 検索。将来データが増えて遅くなったら SQLite FTS5（全文検索インデックス）への移行を検討
- **あいまい検索**: キーワードを複数バリアントに展開してORで照合（全角英数→半角／ひらがな⇄カタカナ／**全角カタカナ⇄半角カタカナ**（例「フィルム」で半角登録の「ﾌｨﾙﾑ」がヒット。NFKC正規化＋全角→半角カナ変換）／末尾長音ゆれ。例「こんぷれっさ」で「コンプレッサー」がヒット）。英字の大小は LIKE が元々区別しない
- 検索対象列は担当者名・記録者名・点検項目の値（items_json）・トラブルの帳票入力（form_values_json）・カスタム項目値、および**関連設備の名称・番号**（`equipment_id` で結合した設備名でもヒットする。本文に設備名が無いトラブル/点検/業務依頼も設備名で引ける）まで含む。後付け列は無い旧DBでは基本列のみで自動再試行（searchWithFallback）
- 検索APIは `GET /api/search?q=...&from=...&to=...&category=...&equipment=...&type=...` の1エンドポイントに集約（`functions/api/search/index.js`）
- **D1 の bind 上限（1クエリ100）対策**: bind数 = 語数分のバリアント合計 × 検索列数 のため、長音付きカタカナ（1語最大6バリアント）を複数語入れると列の多い種別（トラブル10列）で上限を超えクエリが失敗していた。種別ごとに `fitKeywords`（`_lib/fuzzy.js`。余白4＝期間・設備・ジャンル用）で上限に収まる語だけを使い、入らない語はその種別でだけ条件から外す。拡張列だと語を削る必要があり基本列なら削らずに済むときは基本列を優先（入力語を捨てない）。外した語は応答の `ignored_keywords`、種別単位の失敗（基本列でも失敗）は `partial_failure` で返し、画面に注意書きを出す（1種別の障害で横断検索全体を500にしない）
### 12. 電気設備点検（別アプリ統合）
高圧受電設備/蓄電池/発電機の日常点検を記録する専用アプリ（単一HTML）を統合したもの。既存の汎用「点検実施(02)」とは別機能（設備タイプ・相測定など電気固有仕様のため）。**ベースは元リポジトリの `main` 版**（乗数 `multiplier`＝検針値×倍率〈例WHM×2400〉を報告書で計算・`qualifier`＝未満/以上の選択に対応）。
- **配信**: `electrical/index.html` を独立ページ `/electrical/` で配信（元アプリはグローバルCSS/固定ID/インライン`onclick`でページ全体を所有する前提のため、iframeやインライン化はせず**別ドキュメント**で完全隔離）。ホームのタイル `⚡ 電気設備点検` から遷移。Access は全パスを保護済み。
- **保存（D1同期ハイブリッド）**: 元アプリは localStorage 保存だが、**記録・設定は D1 に置換**してチーム共有・監査・端末紛失対応にした。`main` 版はレコード読み取り箇所が多いため、**localStorage を作業ストアにしたまま、起動時に D1→localStorage へ充填（D1が真実）し、書き込み点だけ D1 にも反映（write-through）** する方式（多数の読み取り/描画コードは無改修）。詳細は `electrical/index.html` の「サーバー同期」節（`loadServerData`／`pushRecordToServer`／`deleteRecordFromServer`／`pushConfigToServer`／`pushDefaultToServer`）。
- **既定の点検設定は実運用データ（`点検設定_20260903.json`）に合わせてある**（`DEFAULT_CONFIG`/`_BATTERY`/`_GENERATOR`。乗数・未満以上を含む）。空D1時は `getConfig` がこれをフォールバック使用。
- **下書き（autosave）・基本情報の記憶は端末ローカル(localStorage)のまま**（一時データ／この端末の入力補助）。**書き込みキューは未実装（online書き込み前提。オフライン時は充填済みlocalStorageで閲覧のみ可）**。
- **保存・削除は D1 が先**: `saveRecord`／`deleteRecord`／`deleteRecordById` は D1 への送信が成功してから localStorage を更新する。逆順だと送信失敗時に「端末でだけ保存済み」に見える記録が残り、次回オンライン起動時の `loadServerData`（D1→localStorage 充填）で黙って消えた（削除なら復活した）。失敗時は端末側・編集状態（`editingRecordId`）・下書きを変えず、そのまま押し直せる
- **JSON インポート/エクスポートは廃止**（記録・設定は D1 で自動共有されるため端末間移行が不要。UI・関数とも削除済み）。
- **前回値コピー**: 新規入力時に前回記録の値を各欄へコピーできる。多相（電圧/電流の3相等）のコピーは `onclick` 内の JSON を `&quot;` エスケープして属性破壊を防いでいる（未エスケープだと `JSON.stringify` の `"` が二重引用符 `onclick` 属性を閉じてボタンが無効化する）。
- **権限**: 記録の保存/削除=editor、**設定編集=admin**（非adminは設定タブ非表示）、閲覧=全員。点検者名は `/api/me` の氏名を既定。設定の変更は `audit_log` にも記録する
- **削除済みの記録は再保存で復活させない**（同じ client_id の POST は 409。古い画面を開いたままの端末が保存すると、他の端末で削除した記録が黙って復活していた。戻すのは管理画面の「削除済み」から）。上書き保存の監査ログには上書き前の `record_json`（`before_record_json`）を残す
- **記録の保存形式**: 元アプリの Record を `record_json` にそのまま保存（config スナップショット含む＝設定変更後も過去記録が壊れない。02 の items_json と同じ思想）。検索用に `equipment_type`/`inspected_date`/`has_abnormal`(caution/repairで1) を列に持つ。`client_id`(元アプリのDate.now() id) で冪等 upsert。
- **API**: `functions/api/electrical-inspections/`（`index.js` GET一覧`{records:{[client_id]:Record}}`/POST upsert、`[id].js` DELETE論理削除）、`functions/api/electrical-config/`（GET`{main,battery,generator,defaults}`/PUT admin・`master_history`退避）。
- **写真・動画の添付**: 入力画面の「写真・動画」カードから添付できる（editor以上）。アップロードはアプリ共通の `js/files.js`（`uploadFile`/`resizeImageFile`＝長辺1280pxへ縮小しEXIF除去・R2容量ガード）を使い、classic script のこのページへは末尾の module から `window.ElecFiles` として渡す。「保存する」で先に送信し、記録（`record_json`）に `photos:[{id,file_name,content_type}]` として持つ。サーバー側は `attachFiles` で `related_table='electrical_inspection'` に紐づけ、記録詳細・印刷にサムネイルを出す。保存後はフォームから外す（次の記録へ持ち越さない）。**添付は入力・編集画面の「🗑 削除」から削除できる**（`DELETE /api/files/:id` の論理削除。記録側の参照は「保存する」で消えるため、未保存のまま残っても壊れたサムネイルが出ないよう `onerror` で隠す）。
- **XSS対策**: 記録（`record_json`）は他の利用者が保存した値で、記録内の `config` スナップショットも含め任意の文字列が入り得る。`innerHTML` に入れる値は必ず `esc()`、`onclick` の引数は `jsArg()`（JSON化＋属性エスケープ）を通す。サーバー側も `record.id` を英数字・`_`・`-`（64文字まで）に限定し、`date` は検証済みの `YYYY-MM-DD` で保存し直す
- **スコープ外（後日）**: オフライン書き込みキュー、横断検索(11)・通知への載せ込み（`has_abnormal`が足場）。
**テーブル**: `electrical_inspection`（client_id, equipment_type[main/battery/generator], inspected_date, has_abnormal, record_json, +共通監査列）、`electrical_config`（equipment_type PK, config_json, default_json, updated_by/at）
### 13. ユーティリティ日報（工場ユーティリティ設備の日常点検）
灯油・ボイラー・空気圧縮機・各種タンク・蒸気ボイラー・ドレン・号機別運転時間を、毎日1件の日報として記録する（`/pages/utility`・`js/utility.js`）。元は PowerApps + SharePoint の構想だったが、Cloudflare 完結の方針に合わせて本アプリの機能として実装した（外部サービス非依存）。
- **項目マスタ方式**: 31項目を `utility_item` マスタで管理し、値は実施時点のスナップショットを `utility_report.values_json` に保存する（02 の items_json・12 の record_json と同じ思想＝マスタを変えても過去記録が壊れない）。マスタは管理者が画面から追加・削除でき（`/pages/utility?items=1`）、変更は `master_history` に退避して復元できる
- **項目の並び**: セクションは 灯油系統 / **温水・圧縮機** / 各種タンク / 蒸気ボイラー・ドレン の4つ。「温水・圧縮機」は**温水系（温水ポンプ号機・圧力・タンク容量・内温度）を先**に置き、その後ろに空気圧縮機（号機 → ヘッダー圧力 → **号機ごとに1組**の 総運転時間1／油面確認1／総運転時間2／… ）を並べる（現場の巡回順）。**`sort_order` はセクションごとに番号帯を分ける**（灯油1〜・温水/圧縮機10〜・各種タンク30〜・蒸気40〜）。帯が重なるとセクションが分断されるため、項目を足すときは帯の中で採番すること（画面側も同じセクション名は1枚のカードにまとめるので保険はある）。並びを変えたときは `_schema.js` の `UTILITY_MIGRATIONS` を更新する。各文は `name` で1項目に限定し、**移動元になり得る位置をすべて条件に含める**（投入済みDBにも効き、どの旧レイアウトからでも1回で最終形に揃い、再実行しても no-op。管理画面での並び替えを毎回は上書きしない）。さらに `ensureUtilityOrder` が「1000番台の項目が1件でもあれば移行SQLを実行しない」でガードする
- **画面から並び替えできる（▲▼）**: 点検項目マスタ（`/pages/utility?items=1`・admin）で、**表示グループ内の項目の入れ替え**と**グループ自体の入れ替え**が ▲▼ ボタンでできる（1タップごとに保存＝`PUT /api/utility-reports/items/reorder`。失敗したら元の並びへ戻す）。現場の巡回順が変わったときに管理者が画面だけで直せる。並び替えると全項目が **1000番台の連番**（`REORDER_BASE=1000`・`REORDER_STEP=10`）へ振り直され、初期番号（1〜45）を条件にしている `UTILITY_MIGRATIONS` と衝突しない。送られたIDの集合が現在の項目と一致しなければ 409（他の人が項目を追加・削除した後の古い画面からの保存を防ぐ）。変更前の並びは `master_history` へ全体スナップショットで退避（`trouble_category` と同じ形式。並び順は画面から並び替え直せるためレコード単位の復元対象にはしない）。項目の追加はいちばん後ろに入り、▲▼ で移動する（追加フォームの「並び順」欄は廃止）
- **数値欄は `type="text" + inputmode="decimal"`**（`type="number"` は使わない）。スピナー（上下ボタン）を誤タップして `-1` が入る・日本語入力(IME)がONだと文字が弾かれる・不正な内容だと `value` が空になり入力が黙って消える、を避けるため。全角数字「１２３」や桁区切りカンマは入力時に半角へ寄せる（`normalizeNumberText`／サーバー側 `_values.js` にも同じ保険）。スマホの数字キーパッドは `inputmode` で維持される。**02 点検実施と共有**（`js/inspection-items.js`）
- **入力方式**: 数値 / 選択式（1つ） / **複数選択**（例: 空気圧縮機の運転号機 1〜3号機をチップでトグル） / **時刻（HH:MM）** / 自由記述。入力UIは 02 点検の `buildItemInput`（`js/inspection-items.js`）を共有する（`multi`・`time` を追加。02 側のマスタは `ok_ng/number/select/text` のままなので動作は変わらない）
- **前回値の表示・異常値アラート**: 入力欄の下に前回値を表示する（`GET /api/utility-reports/latest`。取得失敗時は表示なしで入力継続）。数値項目は「前回○○（日付）＋差分（↑↓→）」、選択式・複数選択・時刻は「前回○○（日付）」。上下限を外れた数値と、`alert_options`（例 油面確認の「要補充」「異常」）を選んだ選択式はその場で警告し、サーバー側でも `has_abnormal` を算出して一覧に「⚠異常あり」を出す
- **1日1件ガード**: 同じ日の未削除レコードがあると登録APIが 409（`error.detail.existing_id`）を返し、画面は既存記録の編集へ誘導する。一覧のボタンも当日分があれば「✅ 本日入力済み（編集する）」に変わる。論理削除した日は再登録できる（`report_date` に UNIQUE 制約は付けていない）
- **CSV出力**: 一覧から期間指定でCSV出力（UTF-8/BOM・Shift_JIS を選択可）。列は項目マスタから組み立てる
- **横断検索(11)**: 種別 `utility` として `values_json`・特記事項・入力者名を検索対象にする
- **写真・動画の添付**: 入力画面の「写真・動画」カードから複数枚添付できる（editor以上）。02 点検実施と同じ流儀＝保存時に `js/files.js` の `uploadFile`（長辺1280pxへ縮小・EXIF除去・R2容量ガード）で送ってから `file_ids` を本文に載せ、サーバーは `attachFiles` で `related_table='utility_report'` に紐づける。詳細画面（`GET /api/utility-reports/:id` の `files`）と編集画面にサムネイルを表示する。送信済みのファイルは再送しないので、保存が409等で失敗して押し直しても二重登録にならない。**添付は詳細・編集画面の × から削除できる**（editor以上・`DELETE /api/files/:id` の論理削除。06 設備台帳と同じ `thumb-cell`/`thumb-del`。R2の容量を実際に空けるのは管理画面「ファイル容量」の物理削除）
- **スコープ外**: オフライン送信キュー、未入力リマインド通知
**テーブル**: `utility_item`（section, name, input_type[number/select/multi/time/text], unit, min_value, max_value, options_json, alert_options_json, sort_order, +共通監査列）、`utility_report`（report_date, inspected_at, reporter_name, has_abnormal, values_json, note, +共通監査列）
### 14. AIサポート（現場の困りごとから横断して探す）
設備が止まった瞬間に「前に同じことがあったか・部品は在庫にあるか・もう依頼が出ているか・どう直すか」を、
記録を書き始めずにその場で引ける画面（`/pages/ai-support`・`js/ai-support.js`）。
ホームの機能タイル `🤖 AIサポート`（横断検索11のとなり）から入る。
- **1行入力→4ブロック**: 例「3号機 コンプレッサ 異音」と入力して🔍探すと、
  ① 過去の似たトラブル ② 関連する部品在庫 ③ 関連する業務依頼 を各最大10件、セクションごとのカードで表示。
  ④ **🤖 対応策の案**（推定原因・推奨対策・確度）はボタンを押したときだけAIが動く
- **新規APIは作っていない**。既存エンドポイントの組み合わせのみ（バックエンド・スキーマ変更ゼロ）:
  `GET /api/troubles/similar`（あいまいOR検索）／`GET /api/parts?q=&include_similar=1`（あいまいAND＋類似OR枠）／
  `GET /api/search?q=&type=repair`（あいまいAND検索）／`POST /api/ai/suggest-trouble`（editor以上）
- **①②③はAI非依存**なので `env.AI` 未構成でもページは開いて動く。AIに依存するのは④だけなので、
  **④のボタンだけ**を `ai_enabled`（`/api/me`）＋ editor で出し分ける（無効化ではなく非表示）
- **業務依頼は `/api/search` に渡すキーワードを先頭2語までに切る**。`/api/search` は検索列7列・
  キーワード最大5語で bind数 = 語数 × 列数 × バリアント数となり、長音付きカタカナ（1語で最大6バリアント）を
  3語以上入れると D1 の bind 上限100を超えていたため（実測: 3語で126・5語で210）。横断検索11側は
  `fitKeywords` で上限内に収まる語だけを使うよう修正済みだが、ここでは精度を保つため2語切りを維持する。
  さらに**AND検索が0件のときだけ先頭1語で1回だけ再検索**し、見出しに「（「◯◯」で再検索）」と出す
- **部品はAND検索が0件のとき、類似（いずれかの語に一致）を畳まずに「関連しそうな部品在庫」として展開**する。
  「コンプレッサ 異音」のように現象の語を混ぜるとANDは必ず0件になり、「0件」表示で関係のある部品が隠れるため
- 在庫バッジ（`在庫0` / `要発注` / `📨 発注中`）は 05 部品在庫と同じクラス・同じ判定
- 各セクションの「すべて見る（横断検索）›」は `/pages/search?q=…&type=trouble|parts|repair` へ
  （部品一覧は `q` パラメータを受け付けないため3種とも横断検索へ寄せる）
- AI結果の下から「この内容でトラブルを記録する ›」「業務依頼を出す ›」で既存フォームへプリフィル遷移
  （機能10のチャット→記録化と同じ既存URLプリフィルの流用）
**テーブル**: なし（既存テーブルの読み取りのみ。新規レコードを作らないため監査列・論理削除の対象外）
---
## ディレクトリ構成
```
/
├── index.html              # ホーム（機能タイル・通知ベル・容量警告）
├── manifest.json / sw.js   # PWA（Service Worker）
├── _headers                # 静的ファイルのセキュリティヘッダー（CSP 等）
├── icons/                  # PWAアイコン（scripts/make-icons.mjs で生成）
├── electrical/index.html   # 12 電気設備点検（独立ドキュメント）
├── pages/                  # 各機能のHTML（plan / plan-annual / inspection / inspection-batch /
│                           #   inspection-report / repair / trouble / parts / ledger / labels / report /
│                           #   utility / dashboard / admin / chat / search / ai-support / notifications）
├── css/style.css
├── js/
│   ├── api.js auth.js nav.js util.js home-tabs.js   # 共通（fetch・権限・ナビ・DOMヘルパ）
│   ├── offline-queue.js draft.js                    # オフライン送信キュー・入力下書き
│   ├── files.js admin-files.js                      # R2アップロード（縮小・EXIF除去）・容量管理
│   ├── csv.js trouble-csv.js                        # CSV出力（インジェクション対策）
│   ├── excel-fill.js xlsx-image.js hanko.js permit-fields.js print-templates.js  # 帳票（Excel差込・印影）
│   ├── equip-picker.js equip-names.js qr-scan.js    # 設備選択・QR読取
│   ├── plan.js plan-annual.js plan-import.js plan-summary.js plan-inspection-link.js  # 01
│   ├── inspection.js inspection-items.js inspection-batch.js inspection-report.js     # 02
│   ├── repair.js           # 03 業務依頼
│   ├── trouble.js          # 04 トラブル記録
│   ├── parts.js            # 05 部品在庫（CSVインポート）
│   ├── ledger.js labels.js # 06 設備台帳・QRラベル
│   ├── report.js           # 07 日報
│   ├── dashboard.js        # 08 グラフ
│   ├── admin.js            # 09 管理機能・監査ログ・復元
│   ├── chat.js notifications.js  # 10 チャット・通知センター／Web Push購読
│   ├── search.js           # 11 横断検索
│   ├── utility.js          # 13 ユーティリティ日報
│   ├── ai-support.js ai-assistant.js  # 14 AIサポート・AI提案UI
│   └── vendor/             # 同梱ライブラリ（CSPで外部CDN禁止のため）
├── functions/api/
│   ├── _middleware.js      # 認証・未捕捉エラーのJSON化・セキュリティヘッダー
│   ├── _lib/               # access-jwt / auth / audit / history / fuzzy / trouble-similar /
│   │                       #   notify / overdue-notify / webpush / storage / ai-models / ai-context 等
│   ├── [[path]].js         # 未定義APIの404
│   ├── me.js
│   ├── equipment/ equipment-names/ inspections/ plans/ troubles/ repairs/ reports/
│   ├── parts/              # CRUD + import.js（CSV取込）・import-from-equipment.js
│   ├── utility-reports/    # 13（items/ = 項目マスタ）
│   ├── electrical-inspections/ electrical-config/  # 12
│   ├── chat/ notifications/ push/                  # 10・通知・Web Push
│   ├── search/index.js     # 11 横断検索
│   ├── stats/              # 集計
│   ├── files/              # R2アップロード/取得
│   ├── print-templates/    # 帳票テンプレート
│   ├── ai/                 # Workers AI（suggest-trouble / analyze-trouble / read-meter / extract-equipment / parse-search / parse-trouble-pdf / chat）
│   ├── users/
│   └── admin/              # audit/ restore/ masters/ users/ backup.js usage.js normalize.js
├── tests/                  # E2Eテスト（実ブラウザ検証。cd tests && npm test）
├── docs/                   # 現場向け使い方ガイド
├── schema.sql              # D1テーブル定義
└── wrangler.toml           # D1/R2/Secretバインディング
```
## 実装フェーズ（優先順位）
| フェーズ | 内容 | 機能番号 |
|---|---|---|
| Phase 0 | 基盤構築: D1スキーマ（共通監査列・audit_log・論理削除）/ Functions雛形 / Access設定 / PWA基盤 | - |
| Phase 1 | 設備台帳 + 点検実施（マスタ編集・異常値アラート含む） | 06, 02 |
| Phase 2 | 保全計画（工事予定含む）+ トラブル記録（ジャンル抽出） | 01, 04 |
| Phase 3 | 業務依頼 + 部品在庫（PowerAppsデータのCSV移行） | 03, 05 |
| Phase 4 | 日報（カテゴリ絞り込み）+ ダッシュボード/抽出レポート/CSV・PDF出力 | 07, 08 |
| Phase 5 | 管理機能（監査ログ閲覧・復元）+ チャット/コメント | 09, 10 |
| Phase 6 | 横断検索（キーワード検索） | 11 |
## 共通の技術的注意事項
- **SQLインジェクション対策**: D1 へのクエリは必ずプリペアドステートメント。SQL文字列連結禁止
- **一覧APIの `limit` は下限1・上限ありで丸める**（`Math.min(Math.max(1, Math.trunc(Number(v)) || 既定), 上限)`。`limit=-1` が `LIMIT -1`＝無制限になり、全件読み取りで D1 の読み取り枠を消費されるのを防ぐ）
- **権限チェックはサーバー側（Functions）で必ず実施**。フロントの出し分けはUX目的のみ
- **複数の書き込みを伴う処理は D1 の batch（1トランザクション）で行う**（途中で失敗しても一部だけ残らない）。監査ログも同じ batch に入れる（`functions/api/_lib/audit.js` の `auditStatement`。INSERT 直後の監査は `recordId: LAST_INSERT_ID`＝`last_insert_rowid()`）。対象: 予定の一括登録（`plans/batch.js`）・1日削除/1日完了（`plans/[id]/delete-day.js`・`complete-day.js`。未マイグレーション列は `runPlanBatch` が外して batch ごと再試行）・点検まとめ入力（`inspections/batch.js`）・設備番号の振り直し（`equipment/renumber.js`）・部品の入出庫と履歴（`parts/[id]/transaction.js`。在庫不足時は `WHERE changes() = 1` で履歴も作らない。棚卸調整の増減は書き込む瞬間の在庫から計算）
- **期間予定の分割（1日削除・1日完了）は同時操作を 409 で止める**（batch の先頭を `guardedPlanUpdate`＝読んだ時点の日程・状態のままのときだけ元の予定を書き換える条件付き UPDATE にし、後続の INSERT・監査は `ifPrevChanged`（`WHERE changes() = 1`）で連鎖させる。競合した側は何も作らない。2回押しで完了済みの単日レコードが2件できるのを防ぐ。updated_at は秒精度で同じ秒の2回押しを区別できないため使わない）。分割した予定には工事連絡書の印刷日（`printed_at`/`printed_by`）も引き継ぐ
- **削除は論理削除 + audit_log 記録が全機能で必須**（共通データ設計の章を参照）
### AI機能（Workers AI）の出し分け
- テキスト系AI（トラブルの原因・対策提案など）は `env.AI` 未構成なら `/api/me` の `ai_enabled:false` でボタンを出さない
- 14 AIサポートの「🤖 対応策の案をもらう」も同じ方式で出し分ける（`ai_enabled` ＋ editor 以上）。同ページのトラブル・部品・業務依頼の検索はAIを使わないので、AI未構成でも画面は開いて動く
- **画像を読むAI（計器の📷自動読み取り＝`/api/ai/read-meter`・設備銘板の自動読み取り＝`/api/ai/extract-equipment`）は既定で非表示**。既定モデル `@cf/meta/llama-3.2-11b-vision-instruct` は Cloudflare アカウントでの**ライセンス同意が必要**で、未同意だと実行時に `5016: … you must submit the prompt 'agree'` で失敗し、現場の入力画面に英文のライセンス文がそのまま出てしまうため（実際に発生）。表示するには Cloudflare ダッシュボード → Pages → 設定 → 環境変数に **`AI_VISION_ENABLED=1`** を設定する（`/api/me` の `ai_vision_enabled`／`js/auth.js` の `getAiVisionEnabled()`／`js/inspection-items.js`・`js/ledger.js`。再デプロイ不要）
- ライセンス同意が不要なモデルに変えたい場合は `AI_VISION_MODEL` を設定する（`functions/api/_lib/ai-models.js`）

### セキュリティ必須事項（画像・ファイル保存含む）
- **R2 バケットは非公開で運用**。`r2.dev` パブリックURL機能は絶対に有効化しない
- 画像・ファイルの取得は必ず Functions 経由（`/api/files/*`）とし、Access の保護下に置く。R2 直リンク禁止
- ファイル取得 API でログインユーザーの権限チェック後に R2 オブジェクトを返す
- アップロード時に Content-Type / 拡張子 / サイズ上限（画像10MB・動画100MB・PDF20MB目安）を Functions 側で検証
- **R2 容量上限ガード**: アップロードAPIは `files` テーブルで使用量を集計し、警告 8GB / 上限 9GB（環境変数 `R2_WARN_BYTES` / `R2_HARD_LIMIT_BYTES` で変更可）。上限超過は HTTP 507 で拒否し、**無料枠 10GB を超えて課金が発生しない**ようにする。論理削除（`deleted_at`）されたファイルも R2 に残る間は使用量に含める。容量を実際に空けるには**物理削除**（管理画面「ファイル容量」タブ → admin が個別に実行）で R2 オブジェクトを削除し `purged_at` を記録する。物理削除済みは使用量集計から除外される（復元不可）。API は `DELETE /api/files/:id?physical=1`（admin）、一覧は `GET /api/files`（admin）
- **容量の管理者報告**: 上限拒否・警告時にアップロード側の報告画面（`js/files.js` のダイアログ）から管理者へ報告できる（`storage_reports` テーブル）。管理者はホーム画面で使用量警告と報告件数を確認できる
- **セキュリティヘッダー**: 静的ファイルはルートの `_headers`（CSP・nosniff・X-Frame-Options・Referrer-Policy・Permissions-Policy）、API 応答は `functions/api/_middleware.js` の `withSecurityHeaders`（nosniff 等）で付ける。CSP は `connect-src 'self'` 等で外部への通信・読み込みを禁止している（ライブラリは `js/vendor/` に同梱）。**外部CDN・外部APIをブラウザから使う機能を足すときは `_headers` の CSP へ追記する**こと（E2E がテスト全体の CSP 違反を検出する）。インラインの `<script type="module">` と電気設備点検の `onclick` のため `script-src 'unsafe-inline'` は残している
- **Cloudflare アカウントの 2FA 必須**（運用開始前）
- 写真は Canvas リサイズ経由で EXIF（GPS等）を自動除去
- 現場周知: 写真への人の顔・社外秘文書の写り込み禁止、チャットへの個人情報入力禁止
### その他
- 写真はアップロード前に Canvas でリサイズ（長辺1280px、JPEG品質0.7目安）
- **保存・更新ボタンは処理中に無効化する**（遅い回線での2回タップによる二重登録・在庫の二重反映を防ぐ。業務依頼・日報・部品の入出庫・点検・トラブル・ユーティリティ）。写真は送信済みのIDを覚えておき、保存が失敗して押し直しても再アップロードしない
- 一括処理が一部失敗したときは、失敗した分の入力を残す（例: 棚卸の一括確定は失敗した行の実数入力を残して棚卸モードを続ける）
- CSV入出力は UTF-8 / Shift_JIS 両対応（Excel互換のため出力デフォルトは BOM付きUTF-8 か Shift_JIS を選択可に）
- CSV出力は必ず `js/csv.js` の `buildCsvText`/`escCsv` を通す（CSVインジェクション対策＝`=`/`+`/`-`/`@`/タブ/CR で始まる値は先頭に `'` を付けて Excel に数式として実行させない。数値・単独の「-」・`excelText()` の `="…"` は対象外）
- QR読み取りは `jsQR`、QR生成は `qrcode.js`、PDF生成は印刷用CSS + 必要に応じ jsPDF（日本語フォント埋め込み）
- カレンダーは自作 or `FullCalendar`（CDN）。軽量性優先なら自作
- 日時は UTC の ISO 8601 で保存し、表示時に JST へ変換
- **期間指定・日付の切り出し・「今日」はすべて JST で扱う**（JST 0:00〜8:59 の記録が前日・前月にずれるのを防ぐ）
  - API: 日時列（occurred_at / inspected_at / created_at / changed_at）の期間絞り込みは `functions/api/_lib/util.js` の `jstDayStartUtc`（>=）／`jstNextDayStartUtc`（< 翌日0:00 JST）で境界を変換する。`T00:00:00Z`／`T23:59:59Z` を付けて比べない。月集計は `strftime('%Y-%m', 列, '+9 hours')`。応答で日付だけを返すときは `toJstDate`。日付だけの列（report_date / planned_date）は変換不要
  - 画面: `js/util.js` の `toJstDateStr`（ISO→JSTの 'YYYY-MM-DD'）・`jstTodayStr`（JSTの今日）を使う。`toISOString().slice(0, 10)` や端末依存の `toLocaleDateString('sv-SE')` で日付を作らない。表示は `formatDate`／`formatDateTime`
- テーブル・列名はスネークケースの英語で統一
