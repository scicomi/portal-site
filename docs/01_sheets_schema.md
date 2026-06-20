# Google Sheets スキーマ設計書

## 概要
- スプレッドシート名: `SciComi_Portal_DB`
- シート構成
  - `Events` … イベント本体（1行 = 1イベント）
  - `Members` … メンバー（1行 = 1人）
  - `Experiments` … 実験ネタ（1行 = 1種類）
  - `Config` … 設定値（パスワード等）

> シートとヘッダーは GAS の `setupSpreadsheet()` を実行すると自動作成される。
> 列を増やしたい時はヘッダーに足してから `setupSpreadsheet()` を再実行すれば不足列が補完される。

---

## シート1: `Events`

**1行目はヘッダー固定**。コードはヘッダー名で列を識別するので、列順は変更してもOK、ヘッダー名は変えないこと。

| 列名 | 型 | 例 | 説明 |
|---|---|---|---|
| `ID` | 文字列 | `ev_1718000000000` | 主キー。`ev_` + タイムスタンプで自動生成 |
| `Date` | 文字列(YYYY-MM-DD) | `2026-06-20` | 開始日 |
| `DateEnd` | 文字列(YYYY-MM-DD) | `2026-06-22` | 終了日（単日なら空欄） |
| `Title` | 文字列 | `みずほ小学校 実験教室` | イベント名 |
| `Category` | 文字列 | `normal` | `normal` / `other` / `general` / `admin` |
| `Location` | 文字列 | `みずほ小学校 体育館` | 場所 |
| `Audience` | 文字列 | `小学1〜6年生 30名` | 対象者・人数 |
| `TimeStart` | 文字列(HH:MM) | `10:00` | 開始時刻 |
| `TimeEnd` | 文字列(HH:MM) | `12:00` | 終了時刻 |
| `MeetingNumber` | 数値 | `3` | ミーティング回数（ミーティングカテゴリ用） |
| `PartsList` | JSON文字列 | `[{"partName":"一部","items":[...]}]` | 部別の実験・担当者リスト |
| `AdminKyoka` | 文字列 | `鈴木` | 許可願 担当者 |
| `AdminHoukoku` | 文字列 | `田中` | 報告書 担当者 |
| `KyokaDeadline` | 文字列(YYYY-MM-DD) | `2026-06-10` | 許可願 期限（Date−10日で自動算出） |
| `HoukokuDeadline` | 文字列(YYYY-MM-DD) | `2026-06-27` | 報告書 期限（Date+7日で自動算出） |
| `Logistics` | 文字列(複数行) | `9:00 集合\n9:15 搬入` | スケジュール・運搬 |
| `Remarks` | 文字列(複数行) | `駐車場は北側` | 備考 |
| `Belongings` | 文字列(複数行) | `スリッパ\n名札` | 持ち物（1行1つ） |
| `Files` | JSON文字列 | `[{"name":"資料.pdf","url":"https://..."}]` | 関連ファイルリスト |
| `CreatedAt` | 文字列(ISO) | `2026-06-18T10:23:45.000Z` | 作成日時 |
| `UpdatedAt` | 文字列(ISO) | `2026-06-18T11:00:00.000Z` | 最終更新日時 |
| `UpdatedBy` | 文字列 | `太田` | 最終更新者（任意） |

### 注意点
- `PartsList` と `Files` は **JSON文字列**としてセルに保存する（人が読めないがコードが扱いやすい）
- 削除されたイベントは行ごと削除する（ソフトデリートは将来検討）
- 手動で行を追加・編集してもOK。ただしIDの重複に注意

---

## シート2: `Members`

| 列名 | 型 | 例 | 説明 |
|---|---|---|---|
| `ID` | 文字列 | `mb_...` | 主キー |
| `Name` | 文字列 | `井上 咲笑` | 氏名 |
| `Category` | 文字列 | `member` | `adviser` / `coordinator` / `member` |
| `Role` | 文字列 | `プロジェクトリーダー` | 役職（任意） |
| `StudentID` | 文字列 | `4CEQ1205` | 学生証/教職員番号 |
| `Affiliation` | 文字列 | `理系教育センター` | 所属（教員用） |
| `Year` | 文字列 | `4` | 学年 |
| `Note` | 文字列 | | メモ |
| `Active` | 文字列 | `true` | 在籍=`true` / 卒業=`false`（卒業生アーカイブ用） |
| `CreatedAt` / `UpdatedAt` | ISO | | 自動 |

## シート3: `Experiments`

| 列名 | 型 | 例 | 説明 |
|---|---|---|---|
| `ID` | 文字列 | `ex_...` | 主キー |
| `Name` | 文字列 | `スライム` | 実験名 |
| `Category` | 文字列 | `workshop` | `workshop`(工作) / `show`(実験ショー) / `other` |
| `Materials` | 文字列(複数行) | | 使用物品 |
| `Preparation` | 文字列(複数行) | | 事前準備 |
| `Flow` | 文字列(複数行) | | 発表の流れ |
| `Notes` | 文字列(複数行) | | 注意事項 |
| `SlidesURL` | 文字列 | `https://...` | スライド/資料URL |
| `Active` | 文字列 | `true` | 有効フラグ |
| `CreatedAt` / `UpdatedAt` | ISO | | 自動 |

## シート4: `Config`

| Key | Value |
|---|---|
| `password` | `sc2026_xxx`（メンバーに共有するパスワード） |
| `storage_warn_mb` | `60` |
| `storage_block_mb` | `100` |
| `file_retention_years` | `5` |

将来Phase 2でファイル管理にも使う。**`password` は必ず変更すること**。

---

## サンプルデータ（コピペ用）

`Events` シートの2行目以降にテスト用として以下を入れてもOK：

```
ev_001	2026-06-20		みずほ小学校 実験教室	normal	みずほ小学校 体育館	小学1〜6年生 30名	10:00	12:00		[{"partName":"一部","items":[{"name":"空気砲","presenter":"井上"}]}]	鈴木	田中	2026-06-10	2026-06-27	9:00 集合\n9:15 搬入	駐車場は北側	[]	2026-06-18T00:00:00.000Z	2026-06-18T00:00:00.000Z	太田
```
