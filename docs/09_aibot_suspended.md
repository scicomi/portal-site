# 09 AI検索(Gemini)の停止と再開手順

## 現状

AI検索(`bot.html` / `bot.js` / Worker の `gemini.js`・`botPrompt.js`)は **停止中**。コードは削除せず残してある。

停止の理由: Gemini API の無料枠は、送った入力が Google の学習・改善に使われ得る。質問文に人名が入る(例「田中さんの参加イベント」)ほか、要約では備考・振り返りの自由記述も送るため、個人情報を無料枠に流さないことを優先して止めた。

停止のしくみ(2 重):

| 層 | 設定 | 役割 |
|---|---|---|
| フロント | `config.js` の `FEATURES.BOT = false` | メニューから「AI検索」を消す。`bot.html` を直接開いてもホームへ戻す(見た目だけの対策) |
| サーバー | `worker/wrangler.toml` の `GEMINI_ENABLED = "false"` | `gemini*` の action を認証後すぐに `feature_disabled` で拒否する。**実際の遮断はこちら**。保存済みの API キーがあっても Gemini へ送らない |

## 再開手順

1. **有料プラン(請求先を有効化した Cloud プロジェクトのキー)に切り替える。** 有料枠は入力が学習に使われない扱い。規約は最新のものを人が確認すること
2. 下の「再開前に直すべき点」を直す(最低でも 1 と 2)
3. `worker/wrangler.toml` の `GEMINI_ENABLED` を `"true"` にする
4. `config.js` の `FEATURES.BOT` を `true` にする
5. `worker/test/api.test.mjs` の Gemini テストを「キー未設定なら `gemini_key_not_configured`」に戻す
6. `cd worker && npm test` → 人の了承を得て `npm run deploy` → `git push`(この順。サーバーを先に)
7. 設定ページで新しい API キーを入力する
8. `bot.html` の「停止中」コメントと `settings.html` の「【現在停止中】」の文言を消し、`bot.html` のヘルプ文(無料枠の記述)を実態に合わせる

## 再開前に直すべき点(2026-10 の監査)

優先度が高いもの:

1. **要約で、備考・振り返りの自由記述が丸ごと送られる**(`bot.js` の `buildEventContext` / `buildExperimentContext`)。人名が書かれていれば Gemini に届く。送る列の許可リスト化、または送信前の確認を入れる
2. **`geminiGenerate` が任意の文章を送れる入口になっている**(`worker/src/gemini.js` の `handleGeminiGenerate`)。クライアントは `target` と `id` だけ送り、サーバーが許可列から本文を組み立てる形にすると、メンバー全件の外部送信もできなくなる

バグ・堅牢性:

3. 「メンバーは何人?」がイベント数を返す。`count` の `resource` が `botPrompt.js` のスキーマに無い(`bot.js` `countItems`)。あわせて `resource` を allowlist 化する
4. `fiscal_year` がスキーマ例で現年度固定のため、付くと `members_docs` が `date_from/date_to` を無視する
5. 書類担当の照合が名前の完全一致(「田中 太郎」と「田中太郎」、複数名記載で誤判定)
6. `findEvents` などが `Date` だけで期間判定し、複数日イベントの `DateEnd` を見ない
7. 名前検索が正規化なし(全角半角・かな/カナ違いで 0 件)
8. モデル出力の型を検証していない(`p.grade.toUpperCase()` 等で例外)
9. Gemini への `fetch` にタイムアウトが無い。例外時に使用量の予約を返さず、1 回分リークする(`geminiInvoke`)
10. 毎分制限がトークン単位で、再ログインで回避できる。日次上限を 1 人で使い切れる
11. API キーが URL クエリにある(`x-goog-api-key` ヘッダーが望ましい)
12. テストが薄い(429 解析、使用量の予約/返却、システムプロンプトに個人情報が入らないこと、入力長制限)

## 補足

- `gemini_usage` テーブルと、保存済みの API キー(`secrets` テーブル)は残っている。停止中も使われない。キーは Google AI Studio 側で無効化しておくと安全
- 旧 GAS(`gas/`)は削除済み。必要なら git の履歴から取り出せる
