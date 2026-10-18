# AI向けREADME（AI アシスタントは最初にこれを読むこと）

このリポジトリは、東海大学サイエンスコミュニケーターのポータルサイト。
人間の新任者が、あなた（AI）に「修正して」「更新手順を教えて」と頼んでくる。このファイルは、あなたが**安全に・迷わず**動くための指示書。

- 人間向けの引き継ぎ資料は [人への引き継ぎ.md](人への引き継ぎ.md)。アカウントやパスワードなど「人が持つべきもの」はそちらに書いてある
- システム全体の説明は [README.md](README.md)、バックエンドの手順は [worker/README.md](worker/README.md)、設計は [docs/08_cloudflare_migration_design.md](docs/08_cloudflare_migration_design.md)

---

## 0. 絶対に守るルール

1. **秘密情報を読まない・書かない・出力しない。**
   - パスワード、API キー、トークン、`.dev.vars`、`.env`、`TOKEN_SECRET` の値。これらをファイルに書いたり、コミットしたり、チャットに表示したりしない
   - 人が値を貼ってきても、ファイルに保存しない。「貼らないでください。私は値を必要としません」と伝える
2. **本番に影響する操作は、実行前に「何をするか」を人に見せ、明確な了承を得てから実行する。** 本番に影響する操作とは次のもの。
   - `wrangler deploy` / `npm run deploy`（API の本番反映）
   - `--remote` の付くすべてのコマンド（本番 D1 への SQL、マイグレーション、スクリプト）
   - `wrangler secret put` / `wrangler secret delete`
   - `git push`（フロントの本番公開になる）
   - ファイルやデータの削除
3. **本番データを変える前は、必ず先にバックアップを取る**（手順は §5-G）。
4. **個人情報を大量に読み出さない。** `SELECT * FROM members` のようにメンバーの氏名・学籍番号・メールが AI に届くクエリは実行しない。件数や特定の列だけで足りるなら、そうする。
5. **人に確認してから進めるべきこと**（自分で決めない）: 課金プランの変更、Cloudflare / GitHub の権限やメンバーの変更、パスワードの変更、データ削除、外部サービスの契約。
6. **`wrangler login` を AI が代行しない。** ブラウザでの許可は必ず人が行う（§2）。人のパスワードを聞き出して代わりに入力するのは禁止。
7. 迷ったら実行せず、選択肢と影響を説明して人に決めてもらう。

---

## 1. システムの全体像（30 秒で）

```
GitHub Pages（フロント：ルート直下の *.html / *.js / style.css）
        ⇄  HTTPS（api.js が action を POST）
Cloudflare Workers（API：worker/src/）
        ⇄
D1（データ・SQLite） ／ R2（ファイル・毎日のバックアップ）
```

- 公開 URL: `https://scicomi.github.io/portal-site/`
- API の URL: `https://scicomi-portal.scicomi.workers.dev`（`config.js` の `API_URL`）
- 認証は「一般パスワード」「幹部パスワード」の 2 種類（共通パスワード方式。個人認証なし）
- 本番の識別子: D1 `scicomi-portal`、R2 `scicomi-portal-files`、Worker `scicomi-portal`
- 旧バックエンド(GAS)は削除済み(git の履歴には残っている)
- **AI検索(Bot)は削除済み**(git の履歴には残っている)。Gemini は「振り返りの要約」だけが使う(2026-10-18 から本番で稼働。§7 の「振り返りの要約」)。設計は [docs/13_reflection_summary_plan.md](docs/13_reflection_summary_plan.md)、実装と本番反映の記録は [docs/14_reflection_summary_roadmap.md](docs/14_reflection_summary_roadmap.md)。`worker/wrangler.toml` の `GEMINI_ENABLED` が全体のスイッチ(`"true"` 以外なら、`worker/src/gemini.js` がどこから呼ばれても Gemini へ送らない)。無料枠は送った入力が学習に使われ得るので、**このスイッチを人の了承なしに `"true"` にしない**(人に頼まれて `"false"` にして止めるのは、すぐ行ってよい。デプロイの了承は §0 のとおり得る)。経緯は [docs/09_aibot_suspended.md](docs/09_aibot_suspended.md)

### 主要ファイル

| 場所 | 内容 |
|---|---|
| `config.js` | **フロントの設定の一元管理**。カテゴリ・色・期限ルール・API URL |
| `api.js` / `app.js` | 通信レイヤー / 共通ロジック。スクリプトの読み込み順は `config.js → api.js → app.js → pwa.js → 各ページ.js`（**変えない**） |
| `*.html` と対応する `*.js` | 各ページ |
| `worker/src/index.js` | API の入口 |
| `worker/src/tables.js` | **テーブルと列の定義**（`RESOURCES`）。DB の列を増やすとき必ず直す |
| `worker/migrations/` | **DB の変更履歴（SQL）**。番号順に適用される |
| `worker/wrangler.toml` | Worker・D1・R2・定期実行の設定（秘密の値は入っていない） |
| `worker/scripts/` | パスワード設定・データ取り込み・復元などのスクリプト |
| `worker/test/` | 結合テスト（`npm test`） |

---

## 2. 最初のセットアップ（この PC で初めて作業するとき）

このリポジトリを取得した直後は、次の 3 つが**存在しない**のが正常。存在しなくても問題ない（人がアップロードしてはいけないもの）。

- `worker/node_modules/` → `npm install` で作られる
- `worker/.wrangler/` → ローカル実行時に自動で作られる
- `worker/.dev.vars` → ローカルテスト用の仮の秘密値。必要なときだけ作る（`worker/.dev.vars.example` を参照）

手順（Node.js 22 以上が必要。`node -v` で確認。動作確認は Node 24）:

> wrangler は `worker/package.json` で版を固定している（現在 4.147.0。Node.js 22 以上が必要）。更新するときは、`npm install --save-dev --save-exact wrangler@latest` → `npm run db:migrate:local` → `npm run dev` → `npm test` でローカルの動作を確認してから、`npx wrangler deploy --dry-run`、`npm run deploy` の順で進める。

```bash
cd worker
npm install
```

本番に接続する作業（デプロイ、`--remote`）が必要になったら、**人に次のコマンドを実行してもらう**。

```bash
cd worker
npx wrangler login      # ブラウザが開く。Cloudflare の共有アカウントでログインし「許可」を押す
npx wrangler whoami     # ログインできているか確認（AI が実行してよい）
```

- `wrangler login` は人が行う。AI にパスワードを教える必要はなく、許可証がこの PC に保存されるだけ
- ログインしていないと、デプロイなどは失敗する。それが仕様で、「人が引き継がないと更新できない」を守る要になっている

ローカルでテストするには、`worker/README.md` の「ローカル開発」を参照（`.dev.vars` にはローカル専用の仮の値を使い、本番と同じ値を入れない）。

---

## 3. 変更の種類と、本番への届き方

| 変更したいもの | 触るファイル | 本番への反映 |
|---|---|---|
| 見た目・文言・フロントの動き | ルート直下の `*.html` `*.js` `style.css` `config.js` | `git push` → GitHub Pages が自動更新（数分） |
| API の処理 | `worker/src/*.js` | `cd worker && npm test` → `npm run deploy` |
| DB に列を足す・テーブルを足す | `worker/migrations/` に新 SQL、`worker/src/tables.js`、フロント | §5-B の順番で |
| 設定値（パスワード、API キー、使用モデル、期限日数など） | 設定ページ（画面）から | コード変更は不要 |

> `git push` するのは、リポジトリの中身だけ。`worker/node_modules/` `worker/.wrangler/` `worker/.dev.vars` は `.gitignore` で除外されている。コミット前に `git status` で、これらや秘密らしきファイルが含まれていないか必ず確認する。

---

## 4. 作業前後の基本動作

1. 作業前に `git status` で状態を確認する
2. ローカルで確認する
   - フロント: `npx http-server . -p 8080 -c-1` → `http://localhost:8080`(⚠ `?api=` を付けないと**本番の API**につながり、保存・削除が本番データに反映される。ローカルの Worker に向けるには、下の「ローカルの API に画面をつなぐ」の `?api=` を必ず付ける)
   - API: `cd worker && npm run dev` と `npm test`（別ターミナル）
   - ローカルの API に画面をつなぐ: `index.html?api=http://127.0.0.1:8787`（解除は `?api=reset`。ページ自体を localhost で開いたときだけ有効）
3. 変更内容を人に説明し、了承を得る
4. 本番反映（§3 の表）
5. 反映後の確認: API が応答するか。画面でログイン・保存ができるか
   - Git Bash: `curl -X POST https://scicomi-portal.scicomi.workers.dev -d '{"action":"version"}'`
   - PowerShell: `Invoke-RestMethod -Method Post -Uri https://scicomi-portal.scicomi.workers.dev -Body '{"action":"version"}'`(PowerShell 5.1 の `curl` は別コマンドの別名なので上の書き方は使えない)
6. 変更したことが README や docs の記述とズレるなら、ドキュメントも更新する

---

## 5. よくある作業の手順

### A. フォント・色・文言など、見た目だけを直す

1. 該当ファイルを編集（共通は `style.css`、カテゴリの色・名前は `config.js`）
2. ローカルで確認
3. 人の了承を得て `git commit` → `git push`
4. 数分後に公開 URL で確認（ブラウザのキャッシュが残るときは Ctrl+F5）

### B. データの項目（列）を追加する（例: イベントに「駐車場」欄を足す）

**順番が重要。** DB を先に変え、API を次に、画面を最後に出す。古いフロントと新しい API が一時的に混ざっても壊れないようにするため。

1. `worker/migrations/` に**新しい番号のファイル**を作る（既存のマイグレーションは絶対に編集しない。番号は `ls worker/migrations` の最後 + 1。この文書を更新した時点の最新は 0010 なので、次は 0011 — 増えたら実際のフォルダを見ること）。
   例: `0007_add_event_parking.sql`
   ```sql
   ALTER TABLE events ADD COLUMN Parking TEXT NOT NULL DEFAULT '';
   ```
   - 値はすべて TEXT。列名は PascalCase（既存に合わせる）
   - 列の削除・改名・型変更は複雑で危険。SQLite の制約もあるため、まず人に相談する
2. `worker/src/tables.js` の該当リソースの `columns` に同じ列名を追加する（JSON を入れる列なら `jsonFields` にも）
3. フロントを直す（入力フォーム、詳細表示。該当ページの `*.js` と `*.html`）
4. ローカルで確認: `npm run db:migrate:local` → `npm run dev` → `npm test`
5. **人の了承を得て**、本番へ:
   1. バックアップを取る（§5-G の「手動バックアップ」）
   2. `npm run db:migrate:remote`（本番 D1 に列が増える。既存データはそのまま）
   3. `npm run deploy`（API を更新）
   4. `git push`（フロントを更新）
6. 本番の画面で、追加した項目が保存・表示できることを確認

補足: 毎日のバックアップは `SELECT *` で全列を保存するので、列を足しても自動で含まれる。一方、復元スクリプト（`worker/scripts/restore.mjs`）は `tables.js` の列だけを書き戻すので、手順 2 を忘れると新しい列が復元されない。**新しいテーブルを足すときは**、バックアップの対象（`worker/src/maintenance.js` の `BACKUP_TABLES`）と、`restore.mjs` の `columnsOf` にも追加する。ただし、消えても作り直せる派生データのテーブル（`teams_notify` `teams_after` `reflection_summaries`）は、わざと入れていない。

### C. 選択肢・カテゴリ・色・期限ルールを変える

原則 `config.js` だけで済む。`README.md` の表「拡張するときはまず config.js」を参照。書類期限の日数は設定ページからも変えられる。

### D. パスワードを変える

- 通常: サイトの管理者ログイン → 設定ページ → パスワード管理（人が画面で入力する。AI は値を扱わない）
- 画面が使えない緊急時: 人に `cd worker && node scripts/set-password.mjs member --remote`（幹部は `admin`）を実行してもらう。入力は伏せ字で、AI には見えない
- 変更すると、そのロールの全員が再ログインになる（仕様）

### E. API キー（Gemini）を設定する

設定ページから人が入力する。DB に保存され、画面では「設定済み／未設定」だけが見える。AI が値を扱う必要はない。

### F. トラブルの調べ方

`README.md` の「トラブルシューティング」に、症状別の手順がある。最初に API が生きているかを見る(§4 の 5 のコマンド。Git Bash は `curl`、PowerShell は `Invoke-RestMethod`)。Cloudflare 側の障害は https://www.cloudflarestatus.com/ 。Worker のログは Cloudflare ダッシュボード → Workers & Pages → scicomi-portal で人に見てもらう。

### G. バックアップと復元

- **自動**: 毎日 03:00（日本時間）に、D1 の全データが R2 の `backups/YYYY-MM-DD.json` に保存される（既定 14 世代）。パスワードのハッシュと API キーは含まれない
- **手動バックアップ（作業前）**: 直近の自動バックアップが十分新しければ、それでよい。今すぐ取りたいときは、人が Cloudflare ダッシュボードで日付を確認するか、次を実行する（出力は個人情報を含むので、AI は中身を読まず、ファイルに保存するだけにする）:
  ```bash
  cd worker
  npx wrangler d1 export scicomi-portal --remote --output=../backup-YYYYMMDD.sql
  ```
  作ったバックアップファイルは Git に入れない（誤コミット防止のため、`git status` で確認。含まれていたら除外する）
- **復元**: `README.md` の「バックアップと復元」。**現在のデータが上書きされる**ので、必ず予行（`--yes` なし）を先に見せて、人の了承を得る

### H. 本番の DB を直接見る・直す

- 人が Cloudflare ダッシュボード → D1 → `scicomi-portal` → Console で操作するのが基本。個人情報を AI に流さないため
- どうしても AI がコマンドで行うなら、`SELECT` は件数や必要な列に限定し、`UPDATE` `DELETE` は必ず `WHERE ID = '...'` で 1 件に絞って、事前に人へ見せる
- `ID` は変更しない。`UpdatedAt` を手で書き換えない（同時編集の検知が壊れる）
- `PartsList` `Files` `PrAssignments` は JSON 文字列。形式を壊さない

### I. うまくいかなかったとき（巻き戻し）

どれも本番に影響する操作なので、実行前に何をするかを人に見せて了承を得る（§0）。**戻す前に、まず原因と影響範囲を調べる**。慌てて戻すと、戻したことで別の問題が起きることがある。

| 戻したいもの | 方法 | 注意 |
|---|---|---|
| フロント（GitHub Pages） | 問題のコミットを `git revert <ハッシュ>` で打ち消して `git push`（数分で反映） | 履歴を書き換える `git reset --hard` + 強制 push はしない |
| API（Worker）のコード | 問題のコミットを `git revert` して `cd worker && npm test` → `npm run deploy`。急ぐときは Cloudflare ダッシュボード → Workers & Pages → `scicomi-portal` → Deployments から、前のバージョンへ戻せる（`npx wrangler rollback` でも可。人が `wrangler login` 済みの PC で行う） | `CODE_VERSION`（`worker/src/util.js`）も、戻したことが分かるよう更新する |
| DB の列を足したマイグレーション | **マイグレーションは戻せない**（既存のファイルは編集しない）。列を足すだけの変更は、古い Worker のコードでも動くので、コードだけ戻せばよい | 列の削除・改名が必要なら、まず人に相談する（§5-B） |
| データそのもの（誤って消した・壊した） | まずゴミ箱（`trash.html`）から戻せないか確認する。だめなら毎日のバックアップから復元（§5-G）。復元は現在のデータを上書きするので、予行を先に見せる | バックアップは毎日 03:00 の時点の状態。それ以降の変更は失われる |
| 直前の時点までの DB | D1 には、過去の時点へ戻す標準機能（Time Travel、`wrangler d1 time-travel`）がある。保持期間や費用は Cloudflare の公式ドキュメントで確認すること。**この環境では未検証** | 現在のデータを上書きする。実行前に必ずバックアップを取り、人が了承する |

---

## 6. 人に頼むべきこと

AI にはできない、または任せてはいけない作業。指示するときは具体的に伝えること。

| 作業 | 理由 |
|---|---|
| `npx wrangler login`（Cloudflare へのログイン許可） | 認証は人が行う |
| Cloudflare ダッシュボードでの D1 Console の操作、使用量・請求の確認 | 個人情報・課金に関わる |
| Cloudflare / GitHub の権限・メンバーの追加削除 | 引き継ぎの要 |
| ポータルのパスワード変更、API キーの入力 | 秘密の値を AI に見せない |
| 外部サービス（Gemini、ドメイン）のアカウント操作 | AI は契約者ではない |
| 共通パスワードの新任者への共有 | AI を経由させない |
| ストレージの上限の自動取得に使う Cloudflare の API トークンの作成と登録(`wrangler secret put CF_API_TOKEN` / `CF_ACCOUNT_ID`) | 秘密の値を AI に見せない。未登録でも動く(無料プランの上限で表示) |

---

## 7. 既知の落とし穴

- `worker/wrangler.toml` の `ALLOWED_ORIGINS` に含まれないサイトからは、ブラウザが API を呼べない。フロントの置き場所を変えたら追加して再デプロイする
- Cloudflare の無料枠（Workers 1 日 10 万リクエスト、D1 書き込み 10 万行/日）を超えると D1 がエラーを返す
- ログインのパスワード検証は CPU 10ms の枠内で動く。ログインが失敗し続けるなら `PBKDF2_ITERATIONS`（`wrangler.toml`）を確認する
- 「パスワード一覧」ページは第三者サービスのパスワードを**平文**で D1 に保存し、毎日のバックアップにも含まれる。新しい機能を作るときも、この事実を前提に慎重に扱う
- アップロードされたファイル（R2）は URL を知っていれば**ログインなしで**見られる。個人情報を含むファイルは扱わない設計
- 同時編集は「後から保存した人が再読込される」楽観的競合検知。`UpdatedAt` を壊さない
- ガイド（`guide.html`・`guides` テーブル・`api.saveGuide`）は、本文を Editor.js のブロック JSON（`{"blocks":[…]}`）の文字列で `Body` 列に保存している。`vendor/editorjs/` は配布ファイルをそのままコピーしたもので、**直接編集しない**（更新手順は同フォルダの README.md）。独自ブロックは `guide-blocks.js`。閲覧はメンバーも可、作成・編集・削除は管理者のみ（`tables.js` の `adminWrite: true`）。保存は `api.saveGuide`（管理者トークンを送る。`api.save` は送らない）。入れ子は「ブロックのインデント（tune）」で表し、トグルは見出しだけで、その下のインデントされたブロックが中身。元に戻す（Ctrl+Z）は Editor.js に無いので `guide.js` の履歴で自作している。並べ替えは同じ親の下の兄弟どうしで、`SortOrder` を 10, 20, 30… に振り直す。アップロードした画像・ファイルは URL を知っていればログイン不要で見られるので、個人情報は載せない
- **削除はゴミ箱に入る**（ガイド以外。`trash` テーブル、`worker/src/trash.js`、7 日で完全削除）。メンバーも削除・復元・完全削除ができる。パスワード一覧の分だけ管理者専用。添付・写真・動画・振り返り・セクションの列を足したら `worker/src/data.js` の `TRASH_ITEM_RULES` に追加する。削除したファイルの R2 実体は `deleteFile` で直接消さず、ゴミ箱の完全削除に任せる(完全削除は、ほかのレコードやゴミ箱の別の行がまだ同じファイルを参照していれば、R2 から消さない。`trash.js` の `isFileReferenced`)。`trash` の中身（個人情報を含む）を AI に流さない
- メンバー（`members`）と実験ネタ（`experiments`）の追加・編集は、サーバー側では一般のトークンでも通る（共通パスワード方式の仕様。`tables.js` の `adminOnly` は `false`）。画面の「幹部の認証」は誤操作防止であって権限の強制ではない。幹部限定にしたいと頼まれたら、まず人に相談する
- 画面の「今日」・年度・出欠の締切は、端末のタイムゾーンではなく**日本時間**で判定する（海外から操作しても、サーバーと同じ日付で動くように。`app.js` の `jstParts` / `todayISO` / `currentFiscalYear`、`vote-widget.js` の `voteDeadlinePassed`）。「今日」を求めるときに `new Date()` から直接日付を作らず、`todayISO()` を使う。YYYY-MM-DD の日付そのものはタイムゾーンを持たないので、そのまま比べてよい
- **保存できる値の長さに上限がある**（`worker/src/data.js`）。題名・氏名などの短い列は 2,000 バイト、本文・備考・振り返りなどの長い列は 500,000 バイト、その他（JSON の列を含む）は 100,000 バイト、1 回の保存の合計は 1,500,000 バイト。リクエスト本文は 28MB まで（超えると `too_large`、画面は「内容が長すぎるため保存できません」）。ファイルの上限の設定 `file_max_mb` は 1〜95（既定 50。ファイルは JSON ではなく `POST /upload` で送るので、28MB の制限は受けない。下の「ファイルのアップロード」）。新しい列を足すときは、短い列か長い列かを `data.js` の `SHORT_COLUMNS` / `LONG_COLUMNS` で決める
- **出欠は、実在するメンバーとイベントにだけ保存される**（`submitVote`。実在しなければ `invalid_id` / `member_not_found`）。ゴミ箱から戻すときも、相手が消えている投票は戻さない。テストで投票するときは、先にテスト用のメンバーを作る
- **ガイド本文は、描画する前に無害化する**（`guide.js` の `gdSanitizeBlocks`。Editor.js の掃除は保存時と貼り付け時にしか効かない）。新しい種類のブロックを `guide-blocks.js` に足すときは、HTML を持つ項目を `gdSanitizeBlocks` の対象に入れ、`innerHTML` に入れる前に `sanitizeRichHtml` を通す
- **保存が競合したときは、画面側で最新を取り込む**。イベントのウィザードは、最新の上に自分が変えた項目だけを重ねて開き直せる（`event-wizard.js` の `rebaseEventInput`、`toastUndo` の「入力を開き直す」）。実験詳細は最新を取り込んで、もう一度保存を促す（`experiment-detail.js` の `refreshCurrentExpAfterConflict`）。実験・メンバーのウィザードは、競合すると最新を読み込むだけで入力は残らない（既知の制約）。`toastUndo` の `onUndo` が `false` を返すと、ボタンを残して再試行できる
- **失敗の文言は `humanizeApiError(e)` を通す**（`api.js`）。`err.message` をそのままトーストに出さない（`NETWORK_UNREACHABLE` や `internal_error` のようなコードが画面に出てしまう）
- **アクセシビリティの共通の仕組み**（`app.js`。ページごとに書かなくてよい）:
  - `autoLabelControls`: `<label>` を `.e1-group` の中、入力欄と同じ場所に置けば、自動で `for` / `id` で結び付く。ラベルの末尾が「*」なら `aria-required` が付く。ラジオ・チェックボックスの並びは、グループの名前（`aria-labelledby`）になる。動的に作られる画面（ウィザードなど）にも効く
  - `initTablistKeyboard`: `role="tab"` のタブに、← → / Home / End の操作と、選択中のタブだけを Tab の停止位置にする処理を付ける。タブ（`role="tablist"` の中）には `aria-selected` を必ず付ける
  - `ensureSkipLink`: `renderHeader` が「本文へ移動」のスキップリンクを差し込む。`<main>` があるページで有効
  - マウスを乗せたときだけ出る操作（行内の編集・削除、写真の ✕）は、タッチ端末（`@media (hover: none)`）では常に表示する。タップ領域は 44px（`--touch-min`）以上にする
  - 通知（トースト）の領域は最初から DOM にあり、失敗は `role="alert"`。文字・枠の色は `style.css` の変数（`--text-muted` など）が、白地で 4.5:1 以上になる濃さにそろえてある。色を足すときは、コントラストを確かめる
- **イベントの振り返り（`events` の `Positives` / `Reflections`）は、1 人 1 件の JSON 配列**（`{ id, text, memberId, name, createdAt }`。実験の振り返りと同じ作り）。以前の「1 つの文章」は、`parseEventFeedback`（`app.js`）が名前なしの 1 件として読む。保存は `event-detail.js` の `updateEventFeedback` を通す（競合したら最新を取り直して書き換え直す。直接列を丸ごと上書きしない）。記入者は端末に記憶した「あなたの名前」（`getSavedVoteMemberId`）で、未設定なら記入時に選ぶ。編集・削除できるのは本人の記入（と名前なしの以前の記入）だけで、これは画面の取り決め（サーバーは強制しない）。イベントの振り返りの削除はゴミ箱に入らず、画面の「元に戻す」だけで戻せる。ホームの「振り返りを記入」は、書いたかどうかに関わらず、終了後 5 日間は出す
- **ダークテーマ**: 配色は CSS の `light-dark(ライトの色, ダークの色)` で書く(`style.css` の `:root` のトークン、`guide.css`)。新しい色を足すときは両方の値を書く。`<head>` の `theme-init.js` が、端末の設定(自動)かアカウントメニューで選んだ値(`localStorage` の `scicomi_theme`)を `data-theme` に反映する。カテゴリ色(`config.js` の `bg` / `text`)のようにパステルの地と濃い文字をセットで持つ色は、ダークでも固定のまま使う(片方だけ変えると読めなくなる)
- **プッシュ通知(Web Push)**: 設計は [docs/11_pwa_push_plan.md](docs/11_pwa_push_plan.md)。暗号化と署名は `worker/src/webpush.js`(外部ライブラリなし。RFC 8291 の試験値で `worker/test/webpush.test.mjs` が確かめる)、登録と送信待ちは `worker/src/push.js`。鍵は公開鍵が `wrangler.toml` の `VAPID_PUBLIC_KEY`、秘密鍵が Secret の `VAPID_PRIVATE_KEY`(人が `node scripts/gen-vapid.mjs --remote` で作る。AI は値を扱わない)。公開鍵が空なら通知は無効。`push_subscriptions`・`push_outbox` は `tables.js` にもバックアップにも入れない(宛先 URL を外に出さない。端末が自動で登録し直す)。一般パスワードを変えると、全端末の登録が無効になる(epoch)。無料枠の CPU 10ms に収めるため、1 回に送る件数は `PUSH_BATCH_SIZE`(既定 5)で、残りは 1 分ごとの定期実行が送る。本番で CPU 超過(エラー 1102)が出たら下げる。宛先は配信基盤のホストだけを受け付ける(`push.js` の `ENDPOINT_HOSTS`)
- **PWA**: `manifest.webmanifest`・`sw.js`・`pwa.js`・`icons/`。新しいページを足すときは、`<head>` に manifest・apple-touch-icon・theme-color の行を、スクリプトに `pwa.js`(`app.js` の直後)を入れる(既存のページからコピーする)。`sw.js` には `fetch` の処理を**入れない**(入れると画面がキャッシュされ、`git push` した変更が利用者に届くのが遅れる)。`sw.js` は `config.js` を `importScripts` するので、`config.js` に `window`・`document` を使う処理を書かない。アイコンは `icon_PWA.png`(白地)から作った。作り直すときは、白地を透明にして、maskable と apple-touch-icon には白い背景を敷く
- **通知の画面側**(`pwa.js`): 状態は `pushState()`(未設定 / 非対応 / iPhone でホーム画面未追加 / ブロック中 / オン / オフ)。オンにする `enablePush()` は、ボタンの click の中で**最初に** `Notification.requestPermission()` を呼ぶ(間に別の await を入れると、iPhone は許可の確認を出さない)。画面を開くと `syncPushSubscription()` が 1 日 1 回・ログインし直したとき・名前を変えたときに登録を送り直し、サーバーの鍵が変わっていれば登録し直す。ログアウトは通知を解除してから行う(`app.js` の `handleLogout` → `disablePushOnLogout`)。Claude の内蔵ブラウザは通知を常に拒否するので、画面の確認は状態を差し替えて行い、実際の受信は実機で確かめる
- **Teams への通知**(`worker/src/teams.js`。設計・Power Automate のフローの構造・本番の手順は [docs/12_teams_notify_plan.md](docs/12_teams_notify_plan.md)): 新規のイベントは保存の約 3 分後に自動で、変更は詳細ページのボタンで、前回送った内容(`teams_notify.Snapshot`)との差分を送る。送信先のフローの URL は Secret の `TEAMS_WEBHOOK_URL`(**AI は値を扱わない**。人が `wrangler secret put` で登録する。未登録なら機能ごと無効)。フローが失敗しても Webhook は 202 を返すので、成否は Worker から分からない。ボタンのリンクの `id=<ID>~` は、変更のときにフローが元の投稿を探す目印なので、形を変えるときはフローの式も直す。`teams_notify` はバックアップの対象外。結合テストは、先頭のコメントの手順(偽の受け口)で起動したときだけ動く。`npm test` はファイルを 1 つずつ動かす(パスワード変更のテストと並行できないため)
- **イベントの通知**(`worker/src/eventNotify.js`): イベント・ミーティングの `save` で、追加と、決めた項目(`WATCHED`。イベント詳細のイベント名・企画名・企画担当者・場所・対象・人数・日程・時間・集合・解散・運搬・実験内容・発表者・備考)の変更を通知する。イベントに列を足して通知の対象にしたいときは `WATCHED` に足す。氏名や本文を含む項目は `show` を付けない(ロック画面に中身を出さない)。送るのは保存の約 3 分後で、まだ送っていない同じイベントの通知は 1 件にまとめる。削除の取り消し・ゴミ箱やバックアップからの復元では通知しない
- **振り返りの要約（AI が生成）**（`worker/src/reflectionSummary.js` ほか。設計は docs/13、記録は docs/14）。実験・イベントの振り返り（`Positives` / `Reflections`）を Gemini の無料枠で要約し、`reflection_summaries` テーブルに保存する。守っていること:
  - **送るのは本文と種類（良かった点／改善点）だけ**。`name` / `memberId` / 日時 / イベント名は送らない（`feedback.js`）。本文のメンバーの氏名（フルネーム、姓・名＋敬称）と連絡先は送る前に置き換える（`redact.js`）。敬称なしの姓・名だけや、子どもの名前は防げないので、入力欄の注意書きで補う。**置き換えの規則を緩めない**。送る列を増やすときは人に相談する
  - モデルには一時的な番号（[F1]…）だけを渡し、本物の id への戻しはサーバーで行う。出力は型を検証し（`reflectionPrompt.js`）、崩れていれば保存しない。画面は `textContent` で描く
  - 自動更新は 1 分ごとの定期実行で 1 件ずつ、1 日 20 件まで（設定 `reflection_summary_auto` で止められる）。画面の「まとめを作る」は 1 件 1 日 1 回。3 件未満では作らない
  - `reflection_summaries` はバックアップの対象外（作り直せる）。中身の要約は個人情報を含み得るものとして扱い、AI が大量に読み出さない
  - テストは `worker/test/reflection.test.mjs`（単体）と `summary-api.test.mjs`（偽の Gemini を使う結合テスト。起動手順はファイルの先頭）。**本物の Gemini に送るテストを書かない**
  - 止め方: 自動更新だけなら設定ページ。全体は `GEMINI_ENABLED = "false"` で再デプロイ
- **Word・Excel・PowerPoint は Office Online ビューアで開く**(設計は [docs/15_office_preview_plan.md](docs/15_office_preview_plan.md))。ファイルのリンクは `app.js` の `fileOpenUrl(url)` を通す。自分の API の `/files/` にある `.doc(x)` `.xls(x)` `.ppt(x)` だけ `view.officeapps.live.com` の URL に変わり、それ以外(PDF・画像・外部リンク・ローカル開発の API)は元の URL のまま。保存データは変えない。ファイルの URL が Microsoft に渡る(個人情報入りの書類を含む。人は了承済み)。新しくファイルのリンクを作る画面を足すときは `fileOpenUrl` を通す。開けなくなったら `fileOpenUrl` が元の URL を返すだけにすれば、従来のダウンロードに戻る
- **ファイルのアップロードは `POST /upload`**（設計は [docs/16_large_upload_slides_plan.md](docs/16_large_upload_slides_plan.md)）。本文がファイルそのもので、トークンは `Authorization: Bearer`、名前は `X-File-Name`（`encodeURIComponent` 済み）、種類は `Content-Type`。Worker（`files.js` の `uploadFileRaw`）は中身をメモリに展開せず、`FixedLengthStream` で R2 に流す。上限は設定 `file_max_mb`（1〜95MB。Cloudflare の無料プランは本文 100MB まで）。画面は `api.uploadFile(file, { onProgress })`（`XMLHttpRequest`。進み具合が取れる）。base64 の `action: 'uploadFile'` は古い画面のために残してあり、上限は 20MB。**順番**: `/upload` を使う画面を出す前に、Worker を先にデプロイする。大きいファイルで R2 の無料枠（10GB）に近づくので、使用量は人が Cloudflare ダッシュボードの R2 で見る（`npx wrangler r2 bucket info scicomi-portal-files` でも件数と合計が分かる）
- **実験の発表資料**は `experiments.Slides`（JSON 配列。形は `Photos` と同じ `{ name, url, driveId, size, uploadedAt }`。0010 で追加）。画面は実験詳細の「資料」タブ（`experiment-detail.js` の `renderSlides` ほか。最大 30 件。表の見出し「ファイル名」「アップロード日」「サイズ」で並べ替え（今の列だけ ▲▼ を出す）。「⋯」のメニューからダウンロード（取得して表示名で保存。失敗したら元のリンクを開く）、表示名の変更（ダイアログ。拡張子は変えられず、名前だけ編集）、削除（確認ダイアログ）。表示名を変えても R2 のファイルと URL は変わらない）。外すとゴミ箱に入る（`TRASH_ITEM_RULES`）。リンクは `fileOpenUrl` を通すので、パワポは Office Online ビューアで開く。実験情報の「スライド URL」（`SlidesURL`）は外部リンク用で、別物
- **ホームのストレージ(D1・R2 の円グラフ)**: API は `getStorageUsage`(`worker/src/storage.js`。メンバーも可)。D1 は `SELECT 1` の結果の `meta.size_after`、R2 はバケットの一覧の `size` の合計(`backups/` とそれ以外に分ける)で、R2 の一覧は Class A 操作なので 6 時間だけ `kv_cache` に覚える。**上限の決め方(優先順)**: ①設定 `storage_d1_limit_mb` / `storage_r2_limit_mb` に数字があればそれ(空欄が自動) ②Secret の `CF_API_TOKEN`(アカウントの契約情報を読むだけの権限)と `CF_ACCOUNT_ID` があれば、Cloudflare の API(`GET /accounts/{id}/subscriptions`)でプランを読み、`storage.js` の `PLAN_LIMITS_MB`(free: D1 500MB・R2 10GB / paid: D1 10GB・R2 10GB)で決める(1 日 1 回。失敗したら 1 時間後に取り直す) ③読めなければ無料プランの上限(安全側)で、画面に「自動で取得できない」と出す。Cloudflare が上限を変えたら `PLAN_LIMITS_MB` を直す。`detectPlan` は rate_plan.id に `workers` と `paid`/`standard`/`bundled` を含む有効な契約を Paid とみなす(公式の一覧に値の保証がないので、本番で `plan` が想定と違えば `worker/test/storage.test.mjs` と一緒に直す)。トークンの作成と `wrangler secret put CF_API_TOKEN` / `CF_ACCOUNT_ID` は人が行う(AI は値を扱わない)。**利用量**(`worker/src/usage.js`): 同じトークンに「Account Analytics: Read」も付けると、GraphQL Analytics API(`workersInvocationsAdaptive` / `d1AnalyticsAdaptiveGroups`。アカウント全体の合計)から、Workers のリクエスト数と D1 の読み取り・書き込み行数を読み、無料プランは今日(UTC。日本時間 9 時にリセット)の分を 1 日の上限と、Paid は今月の分を含まれる量(`ACTIVITY_LIMITS`)と比べる(1 時間覚える。失敗は 30 分後に取り直し、画面はそのカードを出さない)。**GraphQL のノード名・項目名は本番で未検証**なので、カードが出ないときは Worker のログ(`activity fetch failed`)を確認して `usage.js` の `QUERY` を直す。70% で黄、90% で赤。**順番**: 画面より先に Worker をデプロイする(古い Worker には `getStorageUsage` がなく、画面は「読み込めませんでした」になる)
