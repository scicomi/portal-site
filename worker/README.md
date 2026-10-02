# SciComi Site API (Cloudflare Workers)

GAS の Web アプリ(`gas/Code.gs`)の置き換え。設計は [../docs/08_cloudflare_migration_design.md](../docs/08_cloudflare_migration_design.md)。

- **API**: Workers(`src/`)。クライアント(`../api.js`)とは、`action` を POST する従来の方式・JSON の形・エラーコードで互換
- **データ**: D1(`migrations/0001_init.sql`)。列名はスプレッドシート時代の列名のまま
- **ファイル**: R2(`/files/<キー>` で公開。ログイン不要)
- **定期実行**: 毎日 03:00 JST に D1 を R2 の `backups/` に保存し、古いログを整理(`src/maintenance.js`)

## ローカル開発

Node 20 で動くよう Wrangler 3 系に固定している(`package.json`)。

Git Bash(mac / Linux のターミナルも同じ):

```bash
cd worker
npm install
# ローカル専用の TOKEN_SECRET をランダムに作る(値は画面に出ない。本番の鍵とは別)
node -e "require('fs').writeFileSync('.dev.vars','TOKEN_SECRET='+require('crypto').randomBytes(32).toString('hex')+'\n')"
npm run db:migrate:local
NEW_PASSWORD=test-member-pw node scripts/set-password.mjs member --local   # テスト用の値(10 文字以上)
NEW_PASSWORD=test-admin-pw  node scripts/set-password.mjs admin  --local
npm run dev            # http://127.0.0.1:8787
npm test               # 別ターミナルで。API の契約を検証する
```

Windows の PowerShell(`VAR=値 コマンド` の書き方が使えないので、環境変数を先に入れる):

```powershell
cd worker
npm install
node -e "require('fs').writeFileSync('.dev.vars','TOKEN_SECRET='+require('crypto').randomBytes(32).toString('hex')+'\n')"
npm run db:migrate:local
$env:NEW_PASSWORD='test-member-pw'; node scripts/set-password.mjs member --local
$env:NEW_PASSWORD='test-admin-pw';  node scripts/set-password.mjs admin  --local
Remove-Item Env:NEW_PASSWORD
npm run dev            # http://127.0.0.1:8787
npm test               # 別の PowerShell で
```

- `npm test` は起動中のローカル Worker(`npm run dev`)に接続する結合テスト。起動していないと全件 `fetch failed` になる
- テストはローカル DB の設定(ブランド名など)を既定値に戻してから始める。ログイン試行制限のテストはテスト専用の IP だけをロックするので、続けて再実行できる

画面から試すときは、`index.html?api=http://127.0.0.1:8787` で開く(そのブラウザだけ接続先が切り替わる。`?api=reset` で解除)。
ページ自体を `localhost` で開いたときだけ有効で、接続先も `localhost` / `127.0.0.1` に限る(公開サイトでは受け付けない)。

## 本番の初期設定(初回のみ。2026-09-29 に実施済み。作り直すときの手順として残す)

```bash
npx wrangler login                                   # ブラウザで Cloudflare にログイン
npx wrangler d1 create scicomi-portal                # 出力された database_id を wrangler.toml に貼る
npx wrangler r2 bucket create scicomi-portal-files
npm run db:migrate:remote
npx wrangler secret put TOKEN_SECRET                 # ランダムな 32 文字以上。トークンの署名鍵(紛失・変更すると全員が再ログイン)
npm run deploy                                       # https://scicomi-portal.<アカウント名>.workers.dev
node scripts/set-password.mjs member --remote        # 一般パスワードを対話入力(画面には表示されない)
node scripts/set-password.mjs admin  --remote        # 幹部パスワード(一般とは別の値にすること)
```

`TOKEN_SECRET` の生成例: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## データ移行(スプレッドシート → D1)

1. GAS エディタで `exportAllForMigration` を実行 → マイドライブに `scicomi_export_*.json` ができる(**パスワード一覧を含むので、取り込み後に必ず削除**)
2. JSON をこのフォルダにダウンロードし、取り込む:
   ```bash
   node scripts/import.mjs scicomi_export_XXXX.json --remote --dry-run   # 件数だけ確認
   node scripts/import.mjs scicomi_export_XXXX.json --remote             # 取り込み+件数の照合
   node scripts/verify.mjs scicomi_export_XXXX.json https://scicomi-portal.<アカウント名>.workers.dev   # 全件の内容を突き合わせ
   ```
   二重取り込みは自動で止まる。上書きするなら `--replace --yes`(全テーブルを消してから取り込む。`--yes` が無ければ内容の表示だけで止まる。先にバックアップを取る)。

## 差分マージ・復元

```bash
# 切り替え後に D1 へ書き込みが始まっていて --replace できないとき: GAS のエクスポートのうち、D1 に無い/古い分だけを足す(何も削除しない)
# --since(前回取り込んだエクスポートの時刻)は必須。これより前に作られて D1 に無い行は「削除済み」とみなして足さない
node scripts/merge.mjs <export.json> --remote --since 2026-09-29T07:34:06.666Z            # 予行(変更しない)
node scripts/merge.mjs <export.json> --remote --since 2026-09-29T07:34:06.666Z --apply    # 反映

# バックアップ(R2 の backups/YYYY-MM-DD.json をダッシュボードからダウンロード)から復元(現在のデータは置き換わる)
# 予行・実行のどちらでも「復元前に現在のデータを退避したか」の確認と、退避のコマンドが表示される
node scripts/restore.mjs <backup.json> --remote          # 予行
node scripts/restore.mjs <backup.json> --remote --yes    # 実行(先に現在のデータをバックアップすること)
```

## 運用メモ

- **パスワードを変えると**、そのロールのトークンが全員失効して再ログインになる(設定画面からの変更も同じ)。
- **無料枠**: Workers 10 万リクエスト/日、CPU 10ms/回、D1 読み取り 500 万行/日・書き込み 10 万行/日・5GB、R2 10GB。超えると D1 はエラーを返す。
- パスワードのハッシュ(PBKDF2)が CPU 10ms を超えてログインに失敗する場合は、`wrangler.toml` の `PBKDF2_ITERATIONS` を下げるか、有料プラン(月 $5)にする。
- バックアップ(`backups/YYYY-MM-DD.json`)には `secrets`(パスワードのハッシュ・API キー)を含めない。復元しても D1 の `secrets` は変わらない。D1 を作り直した場合は、パスワードと API キーを設定し直す。
- 本番の識別子: D1 `scicomi-portal`(`wrangler.toml` に ID)、R2 `scicomi-portal-files`、URL `https://scicomi-portal.scicomi.workers.dev`
