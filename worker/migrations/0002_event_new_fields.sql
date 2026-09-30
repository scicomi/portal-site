-- イベントの新規項目（企画担当者・荷物運搬方法・各種書類ファイル）
-- 値はすべて TEXT。人の名前は「, 」区切り、ファイルは JSON 配列（1 ファイルのみの項目も配列で持つ）。
ALTER TABLE events ADD COLUMN PlanLeader TEXT NOT NULL DEFAULT '';          -- 企画担当者（イベント・その他）
ALTER TABLE events ADD COLUMN TransportMethod TEXT NOT NULL DEFAULT '';     -- 荷物運搬方法（レンタカー / 学用車 / 配送 / その他）
ALTER TABLE events ADD COLUMN TransportDriver TEXT NOT NULL DEFAULT '';     -- 運転者（レンタカー・学用車のとき）
ALTER TABLE events ADD COLUMN TransportPassengers TEXT NOT NULL DEFAULT ''; -- 同乗者（レンタカー・学用車のとき）
ALTER TABLE events ADD COLUMN RequestDoc TEXT NOT NULL DEFAULT '';          -- 依頼書（JSON・1 ファイル）
ALTER TABLE events ADD COLUMN KyokaDoc TEXT NOT NULL DEFAULT '';            -- 活動許可願（JSON・1 ファイル）
ALTER TABLE events ADD COLUMN HoukokuDoc TEXT NOT NULL DEFAULT '';          -- 活動報告書（JSON・1 ファイル）
ALTER TABLE events ADD COLUMN MeetingDocs TEXT NOT NULL DEFAULT '';         -- 関連資料（ミーティング・JSON・複数ファイル）
ALTER TABLE events ADD COLUMN Minutes TEXT NOT NULL DEFAULT '';             -- 議事録（ミーティング・JSON・1 ファイル）

-- ミーティングの「参加メンバー」入力を廃止したので、既存の値を消す。
-- （Audience は、イベント・その他では「対象者・人数」として引き続き使う。消すのはミーティングだけ）
UPDATE events SET Audience = '' WHERE Category IN ('general', 'admin');
