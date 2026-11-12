# E2Eテスト

実ブラウザ（Chromium）でアプリの主要機能を自動検証します。
アプリの変更後は、このテストを実行して全項目パスすることを確認してください。

## 実行方法（1コマンド）

前提: **Node.js 22 以上**（wrangler 4.x の要件。古いと起動しません）

```bash
cd tests
npm install        # 初回のみ（playwright / wrangler / eslint を取得）
npx playwright install chromium   # 初回のみ（ブラウザが未導入の環境）
npm test
```

- 本番・開発データには触れません（テスト専用のローカルDB `.wrangler/e2e-state` を毎回作り直します）
- `wrangler.toml` の `[ai]` はテスト中だけ自動で外し、終了時に必ず復元します
- `npm test` は先頭で ESLint を実行します（エラーがあるとテストへ進みません）。コードを直したら `npm run lint` だけを先に回すと早く気づけます
- GitHub へ push すると同じテストが GitHub Actions でも自動実行されます（`.github/workflows/e2e.yml`）

## カバー範囲

| # | 内容 |
|---|---|
| 1 | 全17ページがJSエラーなく表示される |
| 2 | トラブル記録の登録 → 一覧自動表示 → 編集 |
| 3 | 同時編集の競合ガード（他人が先に更新→409） |
| 4 | 下書き自動保存 → 復元バナー → 復元 |
| 5 | オフライン送信キュー（圏外で保存 → 復帰で自動送信） |
| 6 | 部品の発注中バッジ → 入庫で自動解除 |
| 7 | 保全計画: 期間予定が週表示の全日に表示される |
| 8 | ダッシュボードのカスタムグラフ描画 |
| 9 | チャットの投稿・取得・既読更新 |
| 10 | オフラインでもアプリが起動する（SWプリキャッシュ） |
| 単体 | Access JWT 検証（`access-jwt.mjs`。偽造・期限切れ・別の鍵・aud/iss違い・ヘッダーだけの偽装を拒否。ブラウザ不要で最初に実行） |
| 静的検査 | **ESLint**（`npm run lint`。`npm test` の先頭でも実行）。未定義変数・重複キー・到達しないコード等のエラーを検出（警告＝未使用変数は許容）。設定は `eslint.config.mjs` |
| 単体 | 二重登録の防止（`unit-dedupe.mjs`）・部品CSV取込（`unit-parts-import.mjs`）・DB読み取り行数の節約（`unit-perf.mjs`）・バックアップ（`unit-backup.mjs`）・細かい不具合（`unit-small-fixes.mjs`＝不正な日付・offset・LIKE記号・設備番号の案内）・変更履歴の差分表示（`unit-history-diff.mjs`）・電気設備点検の通知と検索（`unit-electrical.mjs`）・休止時間の読み取りと集計（`unit-downtime.mjs`）・バックアップの取り忘れ防止（`unit-backup-status.mjs`）・部品の使用実績（`unit-parts-usage.mjs`）・画面エラーの自動記録（`unit-client-errors.mjs`）・開発用ファイルの配信止め（`unit-blocked-paths.mjs`＝リポジトリの全ファイルが「配信」か「拒否」に分類され、拒否するファイルは必ず Functions を通ることを確認） |
| 9.31〜9.34 | 二重登録の防止・削除ファイルの復元・CSV取込の既定／変更履歴の差分表示・SWの全ページ登録・不正入力で500にならない／開発用ファイルの配信止め（抜け道を含む）／電気設備点検の異常通知・横断検索・記録を開くリンク・ユーティリティ日報のオフライン保存 |

## 失敗したときは

- `tests/e2e-server.log` にローカルサーバーのログが残ります
- 「サーバーが起動しませんでした」の場合は `npx wrangler --version` が動くか確認してください
