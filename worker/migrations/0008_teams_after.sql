-- Teams への「イベント終了後の通知」(振り返りの記入のお願いと、広報担当)。設計は docs/12_teams_notify_plan.md。
-- teams_notify と同じく、汎用の list / save の対象外で、毎日のバックアップにも含めない。
-- 失っても、データは壊れない。ただし「送信済み」の記憶が消えるので、前日に終わったイベントには、もう一度送ってしまう。

-- イベントごとに 1 回だけ送るための記録(1 イベント 1 行)
--   State    : 'retry' = 送信中、または失敗して再試行を待っている / 'sent' = 送信済み / 'failed' = 再試行を使い切った
--   DueAt    : retry のとき、次に送ってよい時刻(UNIX 秒)。送信中の実行が重ならないよう、送る前に後ろへずらして確保する
--   Attempts : 送信に失敗した回数   SentAt: 送った時刻(日本時間 'yyyy-MM-ddTHH:mm:ss')
CREATE TABLE teams_after (
  EventID TEXT PRIMARY KEY NOT NULL,
  State TEXT NOT NULL DEFAULT 'retry',
  DueAt INTEGER NOT NULL DEFAULT 0,
  Attempts INTEGER NOT NULL DEFAULT 0,
  SentAt TEXT NOT NULL DEFAULT ''
);
