-- Teams への通知。設計は docs/12_teams_notify_plan.md。
-- 汎用の list / save の対象外(tables.js に入れない)で、毎日のバックアップにも含めない。
-- 失っても、データは壊れない(イベントの内容は events にある)。ただし「送信済み」の記憶が消えるので、
-- 画面のボタンは「新規」として送り直す(Teams に同じイベントのカードがもう 1 枚できる)。

-- イベントごとの Teams 通知の状態(1 イベント 1 行)
--   State    : 'pending' = 新規の自動通知の送信待ち / 'sent' = 送信済み / 'failed' = 自動の再試行を使い切った
--   DueAt    : pending のとき、送ってよい時刻(UNIX 秒)。保存し直すと後ろにずれる(編集をまとめる)
--   Attempts : 送信に失敗した回数
--   Snapshot : 最後に Teams へ送った時点のイベントの内容(通知の対象の列だけの JSON)。次の「変更」は、これとの差分で作る
--   SentAt   : 最後に送った時刻(日本時間 'yyyy-MM-ddTHH:mm:ss')   SentAtSec: 同じ時刻の UNIX 秒(連続送信の抑止に使う)
CREATE TABLE teams_notify (
  EventID TEXT PRIMARY KEY NOT NULL,
  State TEXT NOT NULL DEFAULT 'pending',
  DueAt INTEGER NOT NULL DEFAULT 0,
  Attempts INTEGER NOT NULL DEFAULT 0,
  Snapshot TEXT NOT NULL DEFAULT '',
  SentAt TEXT NOT NULL DEFAULT '',
  SentAtSec INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_teams_notify_due ON teams_notify (State, DueAt);
