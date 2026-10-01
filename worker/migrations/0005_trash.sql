-- ゴミ箱。削除したレコード(イベント・メンバー・実験ネタ・パスワード)と、
-- レコードから外した項目(添付ファイル・写真・動画・振り返り・セクション)を一定期間(trash_keep_days、既定 7 日)保管する。
-- 期限が来たものは定期実行で完全に削除し、R2 のファイル実体もそのとき消す。値はすべて TEXT。
--   Kind     : 'record'(レコード全体) / 'item'(レコードの 1 項目)
--   Resource : events / members / experiments / passwords
--   RecordID : record のときは削除したレコードの ID、item のときは外した元のレコードの ID
--   Field    : item のときの列名(Files / Photos など)
--   Label    : 一覧に出す名前   RecordLabel: item の元のレコード名
--   Payload  : record は削除時の行(JSON)、item は外した 1 項目(JSON)
--   Votes    : record(events / members)の出欠投票の退避(JSON)
CREATE TABLE trash (
  ID TEXT PRIMARY KEY NOT NULL,
  Kind TEXT NOT NULL DEFAULT '',
  Resource TEXT NOT NULL DEFAULT '',
  RecordID TEXT NOT NULL DEFAULT '',
  Field TEXT NOT NULL DEFAULT '',
  Label TEXT NOT NULL DEFAULT '',
  RecordLabel TEXT NOT NULL DEFAULT '',
  Payload TEXT NOT NULL DEFAULT '',
  Votes TEXT NOT NULL DEFAULT '',
  DeletedAt TEXT NOT NULL DEFAULT '',
  ExpiresAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_trash_expires ON trash (ExpiresAt);
CREATE INDEX idx_trash_record ON trash (Resource, RecordID);
