-- 振り返りの要約(AI が作る)。設計は docs/13_reflection_summary_plan.md と docs/14_reflection_summary_roadmap.md。
-- 汎用の list / save の対象外(tables.js に入れない)で、毎日のバックアップにも含めない。
-- 失っても、データは壊れない(振り返りの本文は experiments / events にある)。要約は作り直せる。

-- 1 件(実験 1 つ、またはイベント 1 つ)1 行。結果と、自動更新の待ち行列を兼ねる
--   TargetType  : 'experiments' / 'events'(テーブル名と同じ)   TargetID: そのレコードの ID
--   Summary     : 結果の JSON({ positive, improve, topics: [{ label, type, count, entryIds }] })。まだ無ければ空
--   InputHash   : 要約を作った時点の振り返り(id・種類・本文)の SHA-256。今の振り返りと違えば「古い」
--   SourceCount : 要約に使った件数(送る量の上限で、新しい順に切ることがある)
--   EntryCount  : 要約を作った時点の振り返りの全件数(「3 件以上増えたら作り直す」の判定に使う)
--   Model / GeneratedAt : 使ったモデル / 作った時刻(日本時間 'yyyy-MM-ddTHH:mm:ss')
--   State       : 'idle' = 待ちなし / 'dirty' = 自動更新の判定待ち / 'failed' = 自動の再試行を使い切った
--   DueAt       : dirty のとき、取り出してよい時刻(UNIX 秒)。保存し直すと後ろにずれる(続けて書かれても 1 回で済む)
--   Attempts    : 自動更新に失敗した回数
--   ManualAt    : 最後に「再生成」ボタンを使った時刻(UNIX 秒。1 件 1 日 1 回の制限の判定)
CREATE TABLE reflection_summaries (
  TargetType TEXT NOT NULL,
  TargetID TEXT NOT NULL,
  Summary TEXT NOT NULL DEFAULT '',
  InputHash TEXT NOT NULL DEFAULT '',
  SourceCount INTEGER NOT NULL DEFAULT 0,
  EntryCount INTEGER NOT NULL DEFAULT 0,
  Model TEXT NOT NULL DEFAULT '',
  GeneratedAt TEXT NOT NULL DEFAULT '',
  State TEXT NOT NULL DEFAULT 'idle',
  DueAt INTEGER NOT NULL DEFAULT 0,
  Attempts INTEGER NOT NULL DEFAULT 0,
  ManualAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (TargetType, TargetID)
);
CREATE INDEX idx_reflection_summaries_due ON reflection_summaries (State, DueAt);
