-- 「スケジュール・運搬」(Logistics) を「備考」(Remarks) に統合して、Logistics 列を削除する。
-- 入力済みの値は消さずに備考へ移す（表示どおり、スケジュール・運搬 → 備考 の順・空行区切り）。
UPDATE events
SET Remarks = CASE WHEN TRIM(Remarks) = '' THEN Logistics ELSE Logistics || char(10) || char(10) || Remarks END
WHERE TRIM(Logistics) <> '';

ALTER TABLE events DROP COLUMN Logistics;
