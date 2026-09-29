# Cloudflare 移行 設計案

作成日: 2026-09-29 / 状態: 承認済み(2026-09-29)・完了(2026-09 に本番を Cloudflare へ切り替え済み。旧 GAS は読み取り専用で履歴として残置)

## 1. 目的と方針

**目的**: GAS の Web アプリ(`/exec`)が不安定で「同期エラー」「ログイン画面が出る」が頻発する問題を、根本から解消する。

**調査で分かったこと**: 1 人の利用でも `Failed to fetch`(0.4〜3 秒)、`macros/echo` の 404、11〜50 秒の遅延が出る。GAS の実行数に失敗は残らない。アクセス過多ではなく、Google 側の入口の問題。

**方針**

1. **画面(HTML/CSS/JS)は GitHub Pages のまま**。公開 URL は変えない。
2. 裏側の **API を Workers、データを D1、ファイルを R2** に移す。
3. **API の形(`action` を POST する方式と JSON の形)は今のまま**にする。`api.js` は接続先の変更と最小限の修正で済ませ、画面側のコードは触らない。
4. ログイン方式は**現状維持**(共有パスワード+幹部パスワード)。個人ログインは将来検討。
5. 一斉切り替えは避け、**並行運用と巻き戻し手順**を用意する。
6. 費用は**無料枠内**を目標にする(超える場合は月 $5 の有料プランを検討)。

## 2. 全体構成

```
[メンバーのブラウザ]
      │  画面の取得
      ▼
[GitHub Pages]  scicomi.github.io/portal-site   ← 変更なし
      │  API 呼び出し(POST / JSON)
      ▼
[Cloudflare Workers]  xxx.workers.dev            ← 新規(GAS の doPost/doGet の代替)
      ├─ [D1]  データ(イベント・メンバー・投票・設定・監査ログ)
      ├─ [R2]  ファイル(資料・写真)+ D1 の定期バックアップ
      ├─ Gemini API / LINE API を呼び出し
      └─ Cron Trigger(定期実行)

(GAS は移行完了後に停止。リマインダー・年間レポートのメール機能は廃止)
```

## 3. 機能の移行先

| 機能 | 現在 | 移行後 | 備考 |
|---|---|---|---|
| データ CRUD(list/listAll/save/delete) | GAS+スプレッドシート | Workers+D1 | 競合検知(`_baseUpdatedAt`)も再現 |
| 投票(getEventVotes/listVotes/submitVote) | 同上 | Workers+D1 | 締切後は管理者のみ変更可、を維持 |
| ログイン(login/auth/adminAuth) | GAS | Workers | 3 章の認証設計を参照 |
| 設定(getPublicConfig/adminGetConfig/adminSetConfig) | Config シート+Script Properties | D1 の config テーブル+Workers Secrets | 機密値は返さない仕様を維持 |
| 監査ログ | AuditLog シート | D1 の audit_log | 保持日数の間引きは Cron |
| ファイル(uploadFile/deleteFile) | Drive | R2 | 現在ファイルなし。新規機能として実装 |
| Gemini(geminiProxy/geminiGenerate/geminiUsage) | GAS | Workers | 使用回数は D1 に記録。API キーは Secrets |
| LINE 新規イベント通知 | GAS | Workers | トークンは Secrets |
| バックアップ | 月次でシートを複製 | Cron で D1 を R2 に書き出し | 世代数は設定値を維持 |
| 監査ログ・孤児ファイルの整理 | 月次トリガー | Cron | |
| リマインダーメール・年間レポート | GAS の MailApp | **廃止** | 不要のため削除(関連する設定キーも削除) |

**GAS は完全に不要になる**: メール機能を廃止したため、移行後に GAS を止められる。データはスプレッドシートから CSV で書き出して D1 へ取り込む(GAS の Web アプリを介さない)。

## 4. D1 テーブル設計

方針: **列名は現在のシートの列名(PascalCase)をそのまま使う**。値はすべて文字列(TEXT)で保存し、日付・時刻・JSON も今の表現(`yyyy-MM-dd`、`HH:mm`、JSON 文字列)を維持する。これで画面側の変更を避ける。

| テーブル | 主キー | 元 | 列 |
|---|---|---|---|
| `events` | `ID` | Events | `EVENTS_HEADERS` の全列 |
| `members` | `ID` | Members | `MEMBERS_HEADERS` の全列 |
| `experiments` | `ID` | Experiments | `EXPERIMENTS_HEADERS` の全列 |
| `passwords` | `ID` | Passwords | `PASSWORDS_HEADERS` の全列(管理者のみ) |
| `event_votes` | (`EventID`, `MemberID`) | EventVotes | `Status`, `UpdatedAt`, `Note` |
| `config` | `Key` | Config | `Value`(表示系の設定) |
| `secrets` | `Key` | Script Properties | パスワードのハッシュとソルト、トークンの世代番号 |
| `audit_log` | 自動採番 | AuditLog | `Timestamp`, `Action`, `Detail`, `TokenHash`, `Role` |
| `gemini_usage` | `Date` | Script Properties | 日ごとの使用回数 |
| `auth_fail` | 自動採番 | CacheService | IP 単位のログイン失敗記録(一定期間で削除) |

- 列の詳細は [01_sheets_schema.md](01_sheets_schema.md) と `gas/Code.gs` の `*_HEADERS` に従う。実装時にマイグレーション用 SQL を `worker/migrations/` に置く。
- `events` などは `UpdatedAt` にインデックスを付け、将来の差分取得に備える。
- 「シートに列を足す」運用は、SQL のマイグレーション(列追加)に置き換わる。

## 5. API 設計

**単一のエンドポイントに `POST` で `action` を送る現在の方式を維持する**。

- 応答は今と同じ JSON(`{success, ...}`)。エラーコード(`unauthorized`、`admin_required`、`conflict`、`vote_closed` など)も同じ。
- `Content-Type: text/plain` で送る現在の形も受け付ける。CORS ヘッダーは Workers で正しく返す(GAS ではできなかった)。
- `listAll` は最初は互換のため残す(D1 では十分速い見込み)。安定後に、画面ごとの取得と差分取得(`since`)、ETag による通信の省略を追加する。

## 6. 認証設計

現在の方式を再現する。

| 項目 | 設計 |
|---|---|
| トークン | `ペイロード(role\|世代\|発行時刻).HMAC 署名` の現在の形式。有効期間はメンバー・管理者とも 180 日 |
| 署名鍵 | **Workers Secrets に固定保存**(読み込み失敗で鍵を作り直す現在の弱点を排除) |
| 世代番号 | `secrets` テーブル。パスワード変更時に +1 して全トークンを失効 |
| パスワード | ハッシュ化して `secrets` に保存。設定画面から変更可能 |
| 総当たり対策 | **IP 単位**の失敗回数と待ち時間(`CF-Connecting-IP` を利用) |
| 権限 | 幹部パスワードでログインすると、メンバーと管理者の両方のトークンを発行(現状維持) |

**切り替え時の影響**: 署名鍵が新しくなるため、**全員が 1 回だけ再ログイン**する。

**初期パスワード**: 決定済み(切り替え時に再設定)。パスワードは `worker/scripts/set-password.mjs` をユーザー自身が実行して設定する(チャットや画面に平文を出さない)。

**要検討**: 無料プランの CPU 時間は 1 回 10ms のため、重いハッシュ(PBKDF2 の反復)は超える可能性がある。実測して、収まらなければ「反復回数を抑える」か「月 $5 の有料プラン」を選ぶ。既存のパスワードハッシュを移せるかは、実装時に確認する(無理なら幹部がパスワードを再設定する)。

## 7. ファイル(R2)

- 現在 Drive にファイルはないため、**移行作業は不要**。アップロード機能を R2 用に作る。
- `uploadFile` は R2 に保存し、`{ name, url, driveId(=R2 のキー), size }` を返す。**フィールド名 `driveId` は当面維持**して、画面側の変更を減らす。
- 表示用 URL は、推測されにくいランダムなキーの公開 URL(ログイン不要。現在の「リンクを知っている人が閲覧可」と同等)。決定済み。
- 画面側の Drive 直リンク(`drive.google.com/thumbnail?id=...`)は、R2 の URL を使う形に修正する(`experiment-detail.js`、`passwords.js`)。

## 8. データ移行

1. スプレッドシートの各シート(Events / Members / Experiments / Passwords / EventVotes / Config)を **CSV でダウンロード**する。
2. CSV を D1 に投入するスクリプト(`worker/scripts/import.mjs`)を用意する。日付・時刻の書式は取り込み時に正規化する。
3. **件数と内容を、シートと D1 で突き合わせる**(全テーブル、JSON 列、日付・時刻の書式)。
4. 切り替え直前に、更新を止めた状態で**最終の書き出し→投入**を行う。

## 9. 切り替えと巻き戻し

| 段階 | 内容 |
|---|---|
| A. 並行構築 | Workers を作り、テスト用のデータで検証。本番の画面は GAS のまま |
| B. 試験運用 | 少人数のブラウザだけ、接続先を Workers にする(URL パラメータや設定で切り替え) |
| C. 切り替え | 更新停止 → 最終移行 → `config.js` の `API_URL` を Workers に変更 → 全員に告知 |
| D. 保険期間 | GAS を読み取り専用で残す。問題があれば `API_URL` を戻す |
| E. 完了 | 一定期間問題がなければ GAS の Web アプリを停止 |

巻き戻し時は、D1 で更新されたデータを GAS 側に戻せるよう、D1 → シートの書き出し手段も用意する。

## 10. リポジトリ構成とデプロイ

```
worker/
  wrangler.toml          設定(D1・R2・Cron の紐づけ)
  migrations/            D1 のテーブル定義(SQL)
  src/                   Workers のコード
  test/                  ローカルでの検証
```

- 初期は手元から `wrangler deploy` で公開する。安定後に、GitHub Actions からの自動公開を検討する(既存の `deploy-gas.yml` の代わり)。
- 秘密情報(署名鍵、Gemini キー、LINE トークン)は `wrangler secret` で登録する。リポジトリには置かない。

## 11. フェーズと完了条件

| # | フェーズ | 完了条件 |
|---|---|---|
| 1 | 基盤(Workers、D1 のテーブル、Secrets) | ローカルで起動し、テーブルが作成される |
| 2 | 認証(login、トークン、IP 制限) | メンバー・管理者でログインでき、誤パスワードで制限がかかる |
| 3 | データ API(list/listAll/save/delete、競合検知、監査ログ) | 既存の画面が、Workers に向けて動く |
| 4 | 投票・設定 | 出欠、締切の制御、設定画面が動く |
| 5 | データ移行と照合 | 全テーブルの件数と内容が一致する |
| 6 | Gemini・LINE・R2 | 各機能が動く |
| 7 | Cron(D1 のバックアップ、監査ログの整理) | 毎日バックアップが R2 に保存される |
| 8 | 並行運用・切り替え | 全員が Workers 経由で利用できる |
| 9 | 運用整備 | README、引き継ぎ資料、使用量の確認方法 |

## 12. リスクと対策

| リスク | 対策 |
|---|---|
| 無料枠の CPU 時間(10ms)を超える処理がある | 実測して判断。超えるなら処理の分割か、月 $5 の有料プラン |
| 無料枠を超えると D1 がエラーを返す | 使用量の確認手順を整備。想定利用量とは大きく離れている |
| 管理者がシートを直接編集できなくなる | 設定画面の強化、CSV の書き出し・取り込み、D1 のコンソール手順書 |
| 切り替え時のデータの不一致 | 突き合わせの検証、更新停止期間、巻き戻し手順 |
| アカウントの引き継ぎ | 共有用のメールで管理し、手順を README に残す |

## 13. 確認事項の回答(2026-09-29)

1. ファイルの閲覧: **ログイン不要**(ランダムな URL の公開)
2. リマインダー・年間レポートのメール: **廃止**(移行も不要)
3. `workers.dev` の名前: 任せる → アカウント `scicomi`、Worker 名 `scicomi-portal`(空いていなければ調整)
4. パスワード: **切り替え時に再設定**
5. 更新停止: **許容可**

## 14. 進捗(2026-09-29)

| フェーズ | 状態 |
|---|---|
| 1 基盤 / 2 認証 / 3 データ API / 4 投票・設定 | 実装済み。ローカルで結合テスト 15 項目が通過(`worker/test/api.test.mjs`) |
| 5 データ移行 | 取り込み・突き合わせのスクリプト実装済み。合成データで往復検証済み。本番データの投入は未実施 |
| 6 Gemini・LINE・R2 | 実装済み。R2 はローカルで動作確認済み。Gemini は API キーが必要なため、本番で確認する |
| 7 Cron(バックアップ・整理) | 実装済み。ローカルで動作確認済み |
| フロント差し替え | `api.js` に接続先の試験切替(`?api=`)を追加、Drive 依存の表示を修正、リマインダー設定を削除 |
| 8 並行運用・切り替え | **完了(2026-09-29)**。本番の D1 へ取り込み(60 イベント・39 メンバー・19 実験・195 投票、全件一致を確認)、サイトを公開。旧 GAS は読み取り専用で保険として残す |
| 9 運用整備 | 完了。README・`worker/README.md` を更新、復元(`restore.mjs`)と差分マージ(`merge.mjs`)を追加。切り替え後、同期エラー・ログイン画面の頻発が解消したことを確認。旧 GAS の停止と `deploy-gas.yml` の整理は任意 |

**挙動の変更点(意図的)**
- LINE の新規イベント通知: GAS 版は「クライアントが ID を省略したとき」だけ通知する実装で、フロントは常に ID を送るため実際には送られていなかった。Worker 版は「新しい行が作られたとき」に通知する。トークン未設定なら送られない。
- 監査ログの `create` / `update` の区別も、同じ理由で「新しい行かどうか」で判定する。
- 廃止した設定キー: `reminder_*`、`report_recipients`、`annual_report_enabled`、`file_sharing`、`file_retention_years`、`storage_*`。
