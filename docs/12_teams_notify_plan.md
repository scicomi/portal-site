# Teams への通知(設計と運用)

イベント・ミーティングを、Microsoft Teams のチャンネルに通知する。**新規は自動、変更は詳細ページのボタン。**
プッシュ通知([11_pwa_push_plan.md](11_pwa_push_plan.md))とは別の仕組みで、両方とも動く。

> 状態: コードとローカルのテストまで完成(2026-10-11)。**本番にはまだ反映していない**(§6 の手順を、人が行う)。

## 1. 全体の流れ

```
ポータル(画面)                Worker                        Power Automate のフロー          Teams
 イベントを新規保存 ───────▶ teams_notify に「送信待ち」を積む
                              (約3分後、定期実行が送る) ──▶ POST {kind:'new', attachments:[カード]} ──▶ カードを投稿
 「Teams に変更を通知」ボタン ─▶ 前回送った内容との差分を作る ─▶ POST {kind:'update', ...}      ──▶ 元の投稿への返信
```

- 新規: 保存の約 3 分後(`TEAMS_NEW_DELAY_SEC` の既定 180)。その間の保存し直しは 1 回にまとめる(最後の保存から数える)。
- 変更: 自動では送らない。詳細ページのボタンを押したとき、**前回 Teams に送った時点の内容**(`teams_notify.Snapshot`)と今の内容の差分を、1 枚の変更カードにして送る。何回直しても、押した 1 回が 1 件の返信になる。
- 削除の取り消し(元の `CreatedAt` を持つ再作成)は、新規として送らない。
- 送信先(フローの URL)が未設定なら、機能ごと無効。ボタンも出ない。

## 2. 関連するファイル

| 場所 | 内容 |
|---|---|
| `worker/src/teams.js` | カードの組み立て、前回との差分、送信(`postToTeams`)、送信待ちの処理(`drainTeams`)、ボタン用(`teamsStatus` / `notifyTeamsNow`) |
| `worker/migrations/0007_teams_notify.sql` | `teams_notify` テーブル(イベントごとの状態と、前回送った内容) |
| `worker/src/index.js` | 保存のあとに送信待ちを積む / 1 分ごとの定期実行で送る / action `teamsStatus`・`teamsNotify` |
| `worker/src/config.js` | `teamsConfigured(env)`(送信先が使えるか)。公開設定 `teams_enabled`(画面がボタンを出すかの判定。URL は返さない) |
| `worker/src/eventNotify.js` | 通知の対象の項目(`WATCHED`)と値の比べ方を、プッシュ通知と共有する |
| `event-detail.js` / `api.js` | 詳細ページのボタンと、API の呼び出し |
| `worker/test/teams.test.mjs` | 単体テスト(カード・差分・送信先の判定・URL が漏れないこと) |
| `worker/test/teams-api.test.mjs` | 結合テスト(偽の受け口に送る。先頭のコメントの手順で起動したときだけ動く) |

## 3. カードの形

フローへ送る本文(JSON)は次の形。`eventKey` と `kind` は Teams には表示されず、フローが読む。

```json
{ "type": "message", "eventKey": "<イベントのID>", "kind": "new | update",
  "attachments": [ { "contentType": "application/vnd.microsoft.card.adaptive", "content": { /* Adaptive Card 1.4 */ } } ] }
```

- **イベント(新規)**: 青い枠(`accent`)。見出し「新しいイベントが登録されました」、題名(ExtraLarge の太字)、項目は イベント名 / 企画担当者 / 場所 / イベント日時 / 実験内容・発表者 / 許可願担当 / 報告書担当。空は「未定」、書類が不要なら「不要」。
- **ミーティング(新規)**: 赤い枠(`attention`)。「全体ミーティング(または幹部ミーティング)が登録されました」、項目は ミーティング名 / 場所 / 日時 / 議題。
- **変更**: 黄色い枠(`warning`)。「イベント(ミーティング)の内容が変更されました」、変わった項目だけを「前 から 後」で並べる。
- ボタンは 2 つ: 「ポータルで詳細を見る」と「出欠を入力」(どちらも `events.html?event=<ID>` を開く)。
- 氏名を含む項目の値も載せる(チャンネルがサークルのメンバーだけのため。プッシュ通知のロック画面とは扱いが違う)。

### 目印(重要)
ボタンのリンクは `…/events.html?event=<ID>&id=<ID>~` の形にする。**`id=<ID>~` が、変更のときにフローが元の投稿を探す目印**(Teams の投稿のカードの中身を検索する)。
`~` は区切りで、`id=12` と `id=123` を取り違えないためのもの。ポータルは `event` だけを読み、`id` は無視する。**この形を変えるときは、フローの検索の式も同時に直すこと。**

## 4. Power Automate のフロー(リポジトリの外にある。引き継ぎで失われやすいので、ここに残す)

テンプレート「Webhook アラートをチャネルに送信する」(トリガー: Teams Webhook 要求を受信したとき)を土台に、次の構造にした。
フローの URL は秘密(漏れると誰でもチャンネルに投稿できる)。**このファイルにも、リポジトリのどこにも書かない。**

```
トリガー: Teams Webhook 要求を受信したとき
 ├ (テンプレートのまま)変数 Body と Attachments を初期化
 └ 条件「Attachments is null」
    ├ はい(カードでない本文): そのまま「カードを投稿」(テンプレートのまま。使わない)
    └ いいえ:
       条件「kind が update」  式 triggerOutputs()?['body']?['kind']  が  update  に等しい
        ├ はい:
        │   「チャネル内のメッセージを取得する」(チーム・チャネルを指定)
        │   「アレイのフィルター処理」
        │       From: 上の取得の value
        │       条件: contains(string(item()?['attachments']), concat('id=', triggerOutputs()?['body']?['eventKey'], '~'))  が  true
        │   条件「見つかったか」  length(body('アレイのフィルター処理'))  が  0 より大きい
        │    ├ はい: 「アダプティブ カードを使用してチャネルで返信する」
        │    │        メッセージ ID: last(body('アレイのフィルター処理'))?['id']        (新しい順なので last = 一番古い = 元の投稿)
        │    │        アダプティブ カード: triggerOutputs()?['body']?['attachments']?[0]?['content']
        │    └ いいえ: 「チャットやチャネルにカードを投稿する」(カード: 同じ式)  ← 元の投稿が見つからないときは新規として投稿
        └ いいえ(new): For each(attachments) → 「Post card in a chat or channel」(カード: item()?['content'])
```

はまった点:
- **式は、入力欄に文字を打つのではなく、「機能(fx)」のタブから入れる。** 打つと文字のまま入り、返信が「ブール値の解析エラー」で失敗する。
- 件数の条件は「0 より**大きい**」。「等しい」にすると、見つかったときに新規投稿になり、見つからないときに返信が失敗する。
- 「応答(Response)」と「HTTP」はプレミアム(有料)で、大学のアカウントでは使えない。SharePoint の接続も、大学の制限で作れなかった。そのため、投稿の ID を Worker に返す方式は取れず、**カードの中身の目印で探す方式**にした。
- カード末尾の「〇〇 used a Workflow template to send this card」の行は、Workflows が自動で足す。本文からは消せない。
- **フローが失敗しても、Webhook は 202 を返す。** Worker からは失敗が見えない。Power Automate の失敗通知(メール)を設定しておくこと。
- 「チャネル内のメッセージを取得する」は、チャンネルの最近の投稿だけを返す。古いイベントの変更は、元の投稿が見つからず、新規の投稿になる(許容している)。

## 5. 制約と注意

- **フローの所有者のアカウントが無効になると止まる**(卒業・退部など)。フローはその人の接続で動く。サークルで管理するアカウントへの移行を、引き継ぎの資料に書くこと。
- **`teams_notify` はバックアップの対象外**(失っても、データは壊れない)。失うと「送信済み」の記憶が消えるので、ボタンは新規として送り直し、Teams に同じイベントのカードがもう 1 枚できる。復元しても `events` と食い違うだけで、害はない。
- 自動の新規通知が失敗したら、1 分・5 分・15 分後に再試行し、それでも駄目なら `failed` にして止める(詳細ページに「自動の通知に失敗しました」と出る。ボタンで送り直せる)。失敗は監査ログ(`teams_fail`)に残る。送信先の URL はログにも画面にも出さない。
- ボタンの連続送信は、同じイベントにつき 1 分あけないと断る(`too_soon`)。変更がないときは送らない。
- 新しい列を通知の対象にしたいときは、`eventNotify.js` の `WATCHED`(プッシュ通知と共通)に足す。カードにだけ載せる項目なら、`teams.js` の `DOC_FIELDS` と `buildNewCard` を直す。

## 6. 本番に反映する手順(人が行う。AI は実行しない)

1. 本番用のフローを作る(§4 の構造)。テスト用のチームではなく、本番のチャンネルに向ける。フローの所有者・失敗通知のメールを決める。
2. 本番の D1 に列(テーブル)を足す: `cd worker && npm run db:migrate:remote`(0007)
3. 送信先の URL を登録する: `cd worker && npx wrangler secret put TEAMS_WEBHOOK_URL`(プロンプトに貼る。画面には出ない)
4. `npm run deploy`(Worker を更新)→ `git push`(画面を更新)
5. 本番で確認: テスト用のイベントを 1 件作って、約 3 分後にカードが出るか。詳細ページのボタンで変更が返信になるか。確認後、テスト用のイベントを削除する(Teams の投稿も消す)。
6. 止めたいとき: `npx wrangler secret delete TEAMS_WEBHOOK_URL`(機能ごと無効になり、ボタンも消える)。または、フロー側を無効化する。

## 7. ローカルでの試験

結合テストは、本物の Teams には送らず、テストの中の偽の受け口に送る。`.dev.vars` は触らず、試験用の値だけを書いた別のファイルを `--env-file` で足す。

```
# teams-test.env(コミットしない。リポジトリの外に置く)
TEAMS_WEBHOOK_URL=http://127.0.0.1:18787/hook
TEAMS_ALLOW_LOCAL_URL=true
TEAMS_NEW_DELAY_SEC=0
TEAMS_COOLDOWN_SEC=0
```

```bash
cd worker
npm run db:migrate:local
npx wrangler dev --local --persist-to .wrangler/state --test-scheduled --port 8788 --env-file .dev.vars --env-file <teams-test.env のパス>
API_BASE=http://127.0.0.1:8788 TEAMS_TEST_PORT=18787 npm test
```

- `--var` では、値の中の `:`(URL のポート番号)が正しく渡らなかったので、`--env-file` を使う。
- `--env-file` を 1 つだけ渡すと、`.dev.vars` が読まれなくなる。**両方を渡す。**
- `npm test` は、ファイルを 1 つずつ動かす(`--test-concurrency=1`)。`api.test.mjs` がパスワードを変えてトークンを失効させる試験を含むため、並行すると他のテストが `unauthorized` になる。
