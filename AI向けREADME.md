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
- **AI検索(`bot.html` / Gemini)は停止中**。無料枠は入力が学習に使われるため。`config.js` の `FEATURES.BOT` と `worker/wrangler.toml` の `GEMINI_ENABLED` で無効化している。再開手順は [docs/09_aibot_suspended.md](docs/09_aibot_suspended.md)

### 主要ファイル

| 場所 | 内容 |
|---|---|
| `config.js` | **フロントの設定の一元管理**。カテゴリ・色・期限ルール・API URL |
| `api.js` / `app.js` | 通信レイヤー / 共通ロジック。スクリプトの読み込み順は `config.js → api.js → app.js → 各ページ.js`（**変えない**） |
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

1. `worker/migrations/` に**新しい番号のファイル**を作る（既存のマイグレーションは絶対に編集しない。番号は `ls worker/migrations` の最後 + 1。現在は 0006）。
   例: `0006_add_event_parking.sql`
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

補足: 復元用スクリプトやバックアップは列を `tables.js` から参照するので、手順 2 を忘れると新しい列がバックアップされない。

### C. 選択肢・カテゴリ・色・期限ルールを変える

原則 `config.js` だけで済む。`README.md` の表「拡張するときはまず config.js」を参照。書類期限の日数は設定ページからも変えられる。

### D. パスワードを変える

- 通常: サイトの管理者ログイン → 設定ページ → パスワード管理（人が画面で入力する。AI は値を扱わない）
- 画面が使えない緊急時: 人に `cd worker && node scripts/set-password.mjs member --remote`（幹部は `admin`）を実行してもらう。入力は伏せ字で、AI には見えない
- 変更すると、そのロールの全員が再ログインになる（仕様）

### E. API キー（Gemini）・LINE トークンを設定する

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

---

## 6. 人に頼むべきこと

AI にはできない、または任せてはいけない作業。指示するときは具体的に伝えること。

| 作業 | 理由 |
|---|---|
| `npx wrangler login`（Cloudflare へのログイン許可） | 認証は人が行う |
| Cloudflare ダッシュボードでの D1 Console の操作、使用量・請求の確認 | 個人情報・課金に関わる |
| Cloudflare / GitHub の権限・メンバーの追加削除 | 引き継ぎの要 |
| ポータルのパスワード変更、API キー・LINE トークンの入力 | 秘密の値を AI に見せない |
| 外部サービス（Gemini、LINE、ドメイン）のアカウント操作 | AI は契約者ではない |
| 共通パスワードの新任者への共有 | AI を経由させない |

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
