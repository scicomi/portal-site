-- 実験の発表資料(パワポ・PDF)。JSON 配列の文字列(Photos と同じ形: { name, url, driveId, size, uploadedAt })
ALTER TABLE experiments ADD COLUMN Slides TEXT NOT NULL DEFAULT '';
