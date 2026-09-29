-- 初期スキーマ。列名はスプレッドシートの列名(PascalCase)をそのまま使う。値はすべて TEXT。
-- 列の定義元: gas/Code.gs の *_HEADERS

CREATE TABLE events (
  ID TEXT PRIMARY KEY NOT NULL,
  Date TEXT NOT NULL DEFAULT '',
  DateEnd TEXT NOT NULL DEFAULT '',
  Title TEXT NOT NULL DEFAULT '',
  Category TEXT NOT NULL DEFAULT '',
  Location TEXT NOT NULL DEFAULT '',
  Audience TEXT NOT NULL DEFAULT '',
  Address TEXT NOT NULL DEFAULT '',
  PostalCode TEXT NOT NULL DEFAULT '',
  LocationTel TEXT NOT NULL DEFAULT '',
  EmergencyHospital TEXT NOT NULL DEFAULT '',
  EmergencyPolice TEXT NOT NULL DEFAULT '',
  TimeStart TEXT NOT NULL DEFAULT '',
  TimeEnd TEXT NOT NULL DEFAULT '',
  GatherTime TEXT NOT NULL DEFAULT '',
  DismissTime TEXT NOT NULL DEFAULT '',
  MeetingNumber TEXT NOT NULL DEFAULT '',
  PartsList TEXT NOT NULL DEFAULT '',
  AdminKyoka TEXT NOT NULL DEFAULT '',
  AdminHoukoku TEXT NOT NULL DEFAULT '',
  KyokaDeadline TEXT NOT NULL DEFAULT '',
  HoukokuDeadline TEXT NOT NULL DEFAULT '',
  KyokaNotRequired TEXT NOT NULL DEFAULT '',
  HoukokuNotRequired TEXT NOT NULL DEFAULT '',
  VoteDeadline TEXT NOT NULL DEFAULT '',
  PlanName TEXT NOT NULL DEFAULT '',
  Logistics TEXT NOT NULL DEFAULT '',
  Remarks TEXT NOT NULL DEFAULT '',
  Files TEXT NOT NULL DEFAULT '',
  Belongings TEXT NOT NULL DEFAULT '',
  Accompany TEXT NOT NULL DEFAULT '',
  SeriesKey TEXT NOT NULL DEFAULT '',
  Positives TEXT NOT NULL DEFAULT '',
  Reflections TEXT NOT NULL DEFAULT '',
  ResultsMemo TEXT NOT NULL DEFAULT '',
  VisitorCount TEXT NOT NULL DEFAULT '',
  ParticipantCount TEXT NOT NULL DEFAULT '',
  PrAssignments TEXT NOT NULL DEFAULT '',
  ReportStatus TEXT NOT NULL DEFAULT '',
  KyokaStatus TEXT NOT NULL DEFAULT '',
  CreatedAt TEXT NOT NULL DEFAULT '',
  UpdatedAt TEXT NOT NULL DEFAULT '',
  UpdatedBy TEXT NOT NULL DEFAULT ''
);

CREATE TABLE members (
  ID TEXT PRIMARY KEY NOT NULL,
  Name TEXT NOT NULL DEFAULT '',
  Furigana TEXT NOT NULL DEFAULT '',
  Category TEXT NOT NULL DEFAULT '',
  Role TEXT NOT NULL DEFAULT '',
  StudentID TEXT NOT NULL DEFAULT '',
  Affiliation TEXT NOT NULL DEFAULT '',
  Email TEXT NOT NULL DEFAULT '',
  Extension TEXT NOT NULL DEFAULT '',
  EmergencyContact TEXT NOT NULL DEFAULT '',
  Note TEXT NOT NULL DEFAULT '',
  FiscalYear TEXT NOT NULL DEFAULT '',
  Active TEXT NOT NULL DEFAULT '',
  CreatedAt TEXT NOT NULL DEFAULT '',
  UpdatedAt TEXT NOT NULL DEFAULT ''
);

CREATE TABLE experiments (
  ID TEXT PRIMARY KEY NOT NULL,
  Name TEXT NOT NULL DEFAULT '',
  Category TEXT NOT NULL DEFAULT '',
  Materials TEXT NOT NULL DEFAULT '',
  Preparation TEXT NOT NULL DEFAULT '',
  Flow TEXT NOT NULL DEFAULT '',
  Notes TEXT NOT NULL DEFAULT '',
  SlidesURL TEXT NOT NULL DEFAULT '',
  Sections TEXT NOT NULL DEFAULT '',
  Photos TEXT NOT NULL DEFAULT '',
  Videos TEXT NOT NULL DEFAULT '',
  Reflections TEXT NOT NULL DEFAULT '',
  Positives TEXT NOT NULL DEFAULT '',
  Active TEXT NOT NULL DEFAULT '',
  CreatedAt TEXT NOT NULL DEFAULT '',
  UpdatedAt TEXT NOT NULL DEFAULT ''
);

CREATE TABLE passwords (
  ID TEXT PRIMARY KEY NOT NULL,
  Category TEXT NOT NULL DEFAULT '',
  SiteName TEXT NOT NULL DEFAULT '',
  URL TEXT NOT NULL DEFAULT '',
  LoginID TEXT NOT NULL DEFAULT '',
  LoginType TEXT NOT NULL DEFAULT '',
  Password TEXT NOT NULL DEFAULT '',
  Note TEXT NOT NULL DEFAULT '',
  Photos TEXT NOT NULL DEFAULT '',
  CreatedAt TEXT NOT NULL DEFAULT '',
  UpdatedAt TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_events_date ON events (Date);
CREATE INDEX idx_events_updated ON events (UpdatedAt);
CREATE INDEX idx_members_updated ON members (UpdatedAt);
CREATE INDEX idx_experiments_updated ON experiments (UpdatedAt);

-- 出欠投票
CREATE TABLE event_votes (
  EventID   TEXT NOT NULL,
  MemberID  TEXT NOT NULL,
  Status    TEXT NOT NULL,
  UpdatedAt TEXT NOT NULL DEFAULT '',
  Note      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (EventID, MemberID)
);

-- 表示・運用設定(機密値は含めない)
CREATE TABLE config (
  Key   TEXT PRIMARY KEY NOT NULL,
  Value TEXT NOT NULL DEFAULT ''
);

-- 機密値(パスワードのハッシュ、API キー、トークンの世代番号)。API では絶対に返さない。
CREATE TABLE secrets (
  Key   TEXT PRIMARY KEY NOT NULL,
  Value TEXT NOT NULL DEFAULT ''
);

-- 監査ログ(Timestamp は JST の ISO 形式 yyyy-MM-ddTHH:mm:ss)
CREATE TABLE audit_log (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  Timestamp TEXT NOT NULL,
  Action    TEXT NOT NULL,
  Detail    TEXT NOT NULL DEFAULT '',
  TokenHash TEXT NOT NULL DEFAULT '',
  Role      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_ts ON audit_log (Timestamp);

-- ログイン失敗の記録(IP 単位の総当たり対策)。古い行は定期的に削除する。
CREATE TABLE auth_fail (
  Id    INTEGER PRIMARY KEY AUTOINCREMENT,
  Scope TEXT NOT NULL,
  Ip    TEXT NOT NULL,
  Ts    INTEGER NOT NULL
);
CREATE INDEX idx_auth_fail ON auth_fail (Scope, Ip, Ts);

-- Gemini の日次使用回数
CREATE TABLE gemini_usage (
  Date  TEXT PRIMARY KEY NOT NULL,
  Count INTEGER NOT NULL DEFAULT 0
);

-- 汎用の一時キャッシュ/カウンタ(セッション単位の毎分レート制限、モデル一覧のキャッシュなど)
CREATE TABLE kv_cache (
  K   TEXT PRIMARY KEY NOT NULL,
  V   TEXT NOT NULL DEFAULT '',
  Exp INTEGER NOT NULL DEFAULT 0
);
