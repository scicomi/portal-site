-- プッシュ通知(Web Push)。設計は docs/11_pwa_push_plan.md。
-- どちらの表も汎用の list / save の対象外(tables.js に入れない)で、毎日のバックアップにも含めない。
-- 端末は画面を開いたときに登録し直すので、失っても困らない。宛先の URL を外に出さないため。

-- 端末ごとの登録
--   Endpoint : 配信基盤(Apple / Google / Mozilla など)の宛先 URL。主キー
--   P256dh / Auth : 端末の公開鍵と認証用の値(base64url。暗号化に使う)
--   Topics   : 受け取る種類の JSON 配列(今は ["events"] だけ)
--   MemberID : 「あなたの名前」が設定されていればそのメンバー ID。無ければ空
--   Epoch    : 登録したときの一般トークンの epoch。現在の値と違う登録には送らない(パスワード変更で全員の登録が無効になる)
--   Label    : 端末の目安(iPhone / Android など。User-Agent から粗く作る)
--   FailCount: 続けて失敗した回数(一定回数で登録を消す)
--   CreatedAt / LastSeenAt / LastSuccessAt : 日本時間の 'yyyy-MM-ddTHH:mm:ss'
CREATE TABLE push_subscriptions (
  Endpoint TEXT PRIMARY KEY NOT NULL,
  P256dh TEXT NOT NULL DEFAULT '',
  Auth TEXT NOT NULL DEFAULT '',
  Topics TEXT NOT NULL DEFAULT '["events"]',
  MemberID TEXT NOT NULL DEFAULT '',
  Epoch INTEGER NOT NULL DEFAULT 0,
  Label TEXT NOT NULL DEFAULT '',
  FailCount INTEGER NOT NULL DEFAULT 0,
  CreatedAt TEXT NOT NULL DEFAULT '',
  LastSeenAt TEXT NOT NULL DEFAULT '',
  LastSuccessAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_push_subscriptions_epoch ON push_subscriptions (Epoch);

-- 送信待ち(1 宛先 1 行)。1 分ごとの定期実行と、保存の直後の処理が少しずつ送る
--   Payload    : 通知の中身の JSON({title, body, url, tag})
--   CollapseKey: 同じイベントの通知をまとめるための鍵(例 ev_xxx)。まだ送っていない同じ鍵の行は、新しい通知で置き換える
--   Attempts   : 送信を試みた回数   NextAt: 次に送ってよい時刻(UNIX 秒)   CreatedAt: 積んだ時刻(UNIX 秒)
CREATE TABLE push_outbox (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Endpoint TEXT NOT NULL,
  Payload TEXT NOT NULL,
  CollapseKey TEXT NOT NULL DEFAULT '',
  Attempts INTEGER NOT NULL DEFAULT 0,
  NextAt INTEGER NOT NULL DEFAULT 0,
  CreatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_push_outbox_next ON push_outbox (NextAt);
CREATE INDEX idx_push_outbox_endpoint ON push_outbox (Endpoint);
CREATE INDEX idx_push_outbox_collapse ON push_outbox (CollapseKey);
