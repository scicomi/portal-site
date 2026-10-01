-- ガイド(Notion 風のページ集)。書類の書き方・活動ガイド・領収書の渡し方など、誰でも読める手順書を置く。
-- 親子関係は ParentID(空なら最上位)。本文は Markdown 風テキストをそのまま保存する。値はすべて TEXT。
CREATE TABLE guides (
  ID TEXT PRIMARY KEY NOT NULL,
  Title TEXT NOT NULL DEFAULT '',
  Icon TEXT NOT NULL DEFAULT '',
  ParentID TEXT NOT NULL DEFAULT '',
  SortOrder TEXT NOT NULL DEFAULT '',
  Body TEXT NOT NULL DEFAULT '',
  CreatedAt TEXT NOT NULL DEFAULT '',
  UpdatedAt TEXT NOT NULL DEFAULT ''
);
