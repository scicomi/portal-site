# SciComi Portal API (Cloudflare Workers)

GAS の Web アプリ(`gas/Code.gs`)の置き換え。設計は [../docs/08_cloudflare_migration_design.md](../docs/08_cloudflare_migration_design.md)。

- **API**: Workers(`src/`)。クライアント(`../api.js`)とは、`action` を POST する従来の方式・JSON の形・エラーコードで互換
- **データ**: D1(`migrations/0001_init.sql`)。列名はスプレッドシート時代の列名のまま
- **ファイル**: R2(`/files/<キー>` で公開。ログイン不要)
- **定期実行**: 毎日 03:00 JST に D1 を R2 の `backups/` に保存し、古いログを整理(`src/maintenance.js`)

## ローカル開発

Node 20 で動くよう Wrangler 3 系に固定している(`package.json`)。

```bash
cd worker
npm install
printf 'TOKEN_SECRET=ローカル用の16文字以上の文字列\n' > .dev.vars      # 本番の鍵とは別にすること
npm run db:migrate:local
NEW_PASSWORD=test-member-pw node scripts/set-password.mjs member --local   # テスト用の値
NEW_PASSWORD=test-admin-pw  node scripts/set-password.mjs admin  --local
npm run dev            # http://127.0.0.1:8787
npm test               # 別ターミナルで。API の契約を 15 項目検証する
```

画面から試すときは、`index.html?api=http://127.0.0.1:8787` で開く(そのブラウザだけ接続先が切り替わる。`?api=reset` で解除)。
`workers.dev` と `localhost` 以外の接続先は受け付けない。

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
   二重取り込みは自動で止まる(上書きするなら `--replace`)。

## 差分マージ・復元

```bash
# 切り替え後に D1 へ書き込みが始まっていて --replace できないとき: GAS のエクスポートのうち、D1 に無い/古い分だけを足す(何も削除しない)
node scripts/merge.mjs <export.json> --remote            # 予行(変更しない)
node scripts/merge.mjs <export.json> --remote --apply    # 反映

# バックアップ(R2 の backups/YYYY-MM-DD.json をダッシュボードからダウンロード)から復元(現在のデータは置き換わる)
node scripts/restore.mjs <backup.json> --remote          # 予行
node scripts/restore.mjs <backup.json> --remote --yes    # 実行
```

## 運用メモ

- **パスワードを変えると**、そのロールのトークンが全員失効して再ログインになる(設定画面からの変更も同じ)。
- **無料枠**: Workers 10 万リクエスト/日、CPU 10ms/回、D1 読み取り 500 万行/日・書き込み 10 万行/日・5GB、R2 10GB。超えると D1 はエラーを返す。
- パスワードのハッシュ(PBKDF2)が CPU 10ms を超えてログインに失敗する場合は、`wrangler.toml` の `PBKDF2_ITERATIONS` を下げるか、有料プラン(月 $5)にする。
- バックアップ(`backups/YYYY-MM-DD.json`)には `secrets`(パスワードのハッシュ・API キー)を含めない。復元しても D1 の `secrets` は変わらない。D1 を作り直した場合は、パスワードと API キーを設定し直す。
- 本番の識別子: D1 `scicomi-portal`(`wrangler.toml` に ID)、R2 `scicomi-portal-files`、URL `https://scicomi-portal.scicomi.workers.dev`
