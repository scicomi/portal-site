# SciComi Portal アーキテクチャ解説

## 全体構成

```
ブラウザ                             サーバーレス
┌─────────────────────────┐         ┌──────────────┐    ┌──────────────┐
│ GitHub Pages            │  HTTP   │ Google Apps   │    │ Google       │
│                         │ ──────→ │ Script        │ ←→ │ Sheets       │
│ config.js  (設定)       │ ←────── │ Code.gs       │    │ 4シート      │
│ api.js     (通信)       │         │               │    │ Events       │
│ app.js     (共通)       │         │ RESOURCE_     │    │ Members      │
│ script.js  (イベント)   │         │ REGISTRY で   │    │ Experiments  │
│ members.js (メンバー)   │         │ リソース管理  │    │ Config       │
│ experiments.js (実験)   │         └──────────────┘    └──────────────┘
│ home.js    (ホーム)     │
│                         │
│ localStorage            │
│ (キャッシュ層)          │
└─────────────────────────┘
```

## レイヤー構造

### 1. 設定レイヤー (config.js)

全ての定数・カテゴリ定義・ルールをここに集約する。
他のファイルは `CONFIG.xxx` で参照し、マジックナンバーや文字列リテラルを持たない。

```
config.js が持つもの:
├── API_URL              → バックエンドのエンドポイント
├── CACHE_PREFIX         → localStorage キーの接頭辞
├── DEADLINE_RULES       → 書類期限の自動計算ルール
├── REMINDER             → メール通知の日数・件名
├── RESOURCE_NAMES       → リソース名の配列 ['events', 'members', 'experiments']
├── NAV_ITEMS            → ナビゲーション定義
├── EVENT_CATEGORIES     → イベント4カテゴリの定義
├── EXPERIMENT_CATEGORIES → 実験3カテゴリの定義
└── MEMBER_CATEGORIES    → メンバー3区分の定義（hasEmail フラグ含む）
```

**新しいリソースやカテゴリを追加する場合**: config.js にエントリを足せば、UIとバックエンドの両方に反映される。

### 2. 通信レイヤー (api.js)

GAS との HTTP 通信を全て担当する。ページ固有のロジックは含まない。

主な設計判断:
- **Content-Type: text/plain**: GAS Web App の CORS 制限を回避するため、`application/json` ではなく `text/plain` で送信し、ボディに JSON 文字列を入れる
- **redirect: 'follow'**: GAS は 302 リダイレクトで応答するため必須
- **キャッシュファースト**: `loadCache()` → UI表示 → `list()` でバックグラウンド更新 → `saveCache()`
- **保存**: `save()` で GAS 保存を待ち、成功したらローカル配列とキャッシュを更新する（同期保存）。UIは先にキャッシュ表示済みなので体感は速い
- **QuotaExceeded 対策**: `_evictOldestCache()` で最古のキャッシュを捨ててリトライ

### 3. 共通UIレイヤー (app.js)

全ページに共通する機能:
- 認証フロー（ログイン画面の表示/非表示）
- ヘッダー/ナビゲーション生成（NAV_ITEMS 駆動）
- 同期状態インジケーター（syncing/synced/error）
- トースト通知（UNDO 対応の5秒ディレイ付き）
- XSS対策ヘルパー（escapeHtml / escapeAttr）

### 4. ページレイヤー (script.js, members.js, experiments.js, home.js)

各ページの CRUD ロジックと DOM 操作。
- `loadEvents()` / `renderEventList()` のようなロード→レンダリングの流れ
- モーダルの開閉・フォームバインディング
- ページ固有のフィルタ/検索/ソート

### 5. バックエンド (gas/Code.gs)

**RESOURCE_REGISTRY パターン**:

```javascript
const RESOURCE_REGISTRY = {
  events:      { sheet: 'Events',      idPrefix: 'ev_', jsonFields: ['PartsList', 'Files'] },
  members:     { sheet: 'Members',     idPrefix: 'mb_', jsonFields: [] },
  experiments: { sheet: 'Experiments', idPrefix: 'ex_', jsonFields: [] }
};
```

`listResource`, `saveResource`, `deleteResource` は全て RESOURCE_REGISTRY を参照し、リソース名をキーにして動作する。新しいリソース追加時はレジストリに1行足すだけ。

排他制御: `LockService.getScriptLock()` で同時書き込みを防止。

---

## スキーマ駆動リソース追加の手順

例: 新しいリソース「備品 (equipment)」を追加する場合

### Step 1: スプレッドシートにシートを追加

シート名: `Equipment`
ヘッダー: `ID | Name | Category | Quantity | Location | Notes`

### Step 2: Code.gs

```javascript
// RESOURCE_REGISTRY に1行追加
const RESOURCE_REGISTRY = {
  events:      { sheet: 'Events',      idPrefix: 'ev_', jsonFields: ['PartsList', 'Files'] },
  members:     { sheet: 'Members',     idPrefix: 'mb_', jsonFields: [] },
  experiments: { sheet: 'Experiments', idPrefix: 'ex_', jsonFields: [] },
  equipment:   { sheet: 'Equipment',   idPrefix: 'eq_', jsonFields: [] }  // 追加
};
```

これだけで `?action=list&resource=equipment` と `action=save&resource=equipment` が動作する。

### Step 3: config.js

```javascript
RESOURCE_NAMES: ['events', 'members', 'experiments', 'equipment'],  // 追加
```

api.js の `listAll()` と `clearAllCache()` が自動的に equipment を含むようになる。

### Step 4: フロントエンド

- `equipment.html` を作成
- `equipment.js` を作成（members.js をテンプレートにするのが最短）
- `config.js` の `NAV_ITEMS` にページを追加

バックエンドの変更は Step 2 の1行のみ。

---

## データフローの全体像

### 読み込み（キャッシュファースト）

```
ページロード
  ↓
loadCache('events') → キャッシュあり → 即座にUI表示
  ↓                                       ↓（並行）
api.list('events') ← GAS ← Sheets     画面は既に表示済み
  ↓
saveCache('events', items)
  ↓
UIを最新データで再描画
```

### 保存

```
ユーザーが「保存」クリック
  ↓
api.save()（編集時は _baseUpdatedAt 付き） → GAS → Sheets（await）
  ├── 成功 → ローカルリストをGAS応答で更新 → キャッシュ書込 → 再描画
  ├── conflict（他者が先に更新） → モーダルを閉じ最新を再取得して警告
  └── その他失敗 → ローカルは変更せず → エラートースト
```

### 削除（UNDO対応 / 即時削除＋再作成方式）

```
ユーザーが「削除」クリック
  ↓
UIから即除去（楽観的表示） + api.delete() を即実行 → GAS → Sheets
  ├── 削除失敗 → UIに戻す + エラートースト（UNDOトーストは出さない）
  └── 削除成功 → 5秒トースト表示（「元に戻す」ボタン付き）
        ↓
      「元に戻す」クリック → api.save() で同一IDの行を再作成 → UIに戻す

※ サーバー削除は5秒待たずに即実行するため、トースト表示中にページを
   閉じても削除は確実に確定する（旧方式の「離脱で削除が消える」問題を解消）。
```

---

## セキュリティ設計

| 脅威 | 対策 |
|---|---|
| XSS | `escapeHtml()` / `escapeAttr()` でユーザー入力をエスケープ |
| CSRF | GAS Web App はトークンベース認証。Content-Type: text/plain で preflight 回避 |
| データ破損 | LockService で排他制御。ID に乱数サフィックスで衝突回避 |
| ロストアップデート（同時編集） | 楽観的競合検知。編集開始時の `UpdatedAt`（`_baseUpdatedAt`）を保存時に送り、サーバー側の現在値と食い違えば `conflict` で拒否→フロントが最新を再取得 |
| 操作の追跡 | AuditLog シートに create/update/delete/upload/設定変更/認証失敗などを JST で記録（月次で `audit_keep_days` 超過分を間引き） |
| データ消失 | スプレッドシートを毎月自動バックアップ（`backupSpreadsheet`、`backup_keep_count` 世代を保持） |
| セッション管理 | ステートレス署名トークン（`role|epoch|発行時刻` + HMAC-SHA256）。`token_secret`/`token_epoch_*` は ScriptProperties に保持。パスワード変更で epoch を進め、既存トークンを即時失効（`invalidateAllTokens`） |
| 総当たり | `auth`/`adminAuth` の失敗回数を CacheService で数え、漸進的に最大4秒遅延（`throttleFailedAuth_`）。失敗は AuditLog に記録 |
| APIキー悪用 | Gemini プロキシのシステムプロンプトはサーバー側で固定生成（クライアント提供を無視）。セッション単位で毎分20回に制限 |
| ファイル公開 | アップロードは既定でドメイン限定共有（`file_sharing=domain`）。個人アカウント等で不可なら自動で ANYONE_WITH_LINK にフォールバック |
| キャッシュ肥大化 | QuotaExceededError 時に最古キャッシュを自動退避 |

---

## clasp による自動デプロイ

```
開発者が gas/Code.gs を編集
  ↓
git push origin main
  ↓
GitHub Actions (.github/workflows/deploy-gas.yml)
  ↓
clasp push --force → GAS プロジェクトに Code.gs を上書き
```

注意: clasp push はコードのプッシュのみ。Web App として公開するには GAS エディタで「新しいバージョンをデプロイ」が必要（この手順は自動化不可）。

---

## innerHTML/onclick パターンのリファクタリング指針

現状、テーブル行の生成やモーダルボタンで `innerHTML` に直書き + `onclick="funcName('${id}')"` というパターンを多用している。

### 現状の問題点

1. **XSS リスク**: ID やタイトルに `"` や `<` が含まれるとHTMLが壊れる（現状 escapeHtml/escapeAttr で対応済みだが漏れやすい）
2. **デバッグ困難**: onclick 文字列内のエラーはスタックトレースが不明確
3. **テスタビリティ**: DOM に依存した文字列結合はユニットテスト不可

### 推奨リファクタリング（擬似コンポーネント方式）

フレームワーク（React/Vue等）の導入は、この規模では過剰。代わりに「ビルダー関数 + addEventListener」パターンを推奨する。

**Before（現状）**:
```javascript
tbody.innerHTML = items.map(e => `
  <tr class="clickable-row" onclick="viewExp('${e.ID}')">
    <td>${escapeHtml(e.Name)}</td>
    <td><button onclick="editExp('${e.ID}')">編集</button></td>
  </tr>
`).join('');
```

**After（推奨）**:
```javascript
function createExpRow(e) {
  const tr = document.createElement('tr');
  tr.className = 'clickable-row';
  tr.addEventListener('click', () => viewExp(e.ID));

  const tdName = document.createElement('td');
  tdName.textContent = e.Name;  // textContent = 自動エスケープ
  tr.appendChild(tdName);

  const tdActions = document.createElement('td');
  const btnEdit = document.createElement('button');
  btnEdit.textContent = '編集';
  btnEdit.addEventListener('click', (ev) => {
    ev.stopPropagation();
    editExp(e.ID);
  });
  tdActions.appendChild(btnEdit);
  tr.appendChild(tdActions);

  return tr;
}

// 使用
const tbody = document.getElementById('exp-tbody');
tbody.replaceChildren(...items.map(createExpRow));
```

### 段階的移行の推奨

全ファイルを一度にリファクタリングする必要はない。以下の優先度で進める:

1. **高優先**: ユーザー入力値を含む innerHTML（XSSリスクが最も高い箇所）
   - `script.js` のイベントタイトル表示、ファイルURL表示
   - `members.js` の名前・メールアドレス表示
2. **中優先**: テーブル行の生成（experiments.js, members.js の `tbody.innerHTML = ...map()`)
3. **低優先**: 静的なUIパーツ（app.js のヘッダー生成、モーダルテンプレート）

静的な構造（ボタンラベルが固定のモーダルなど）は innerHTML のままでも実害はない。
