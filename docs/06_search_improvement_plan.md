# 06. 検索システム改善プラン（10段階 + 3週間ロードマップ）

**対象**: events / members / experiments / event-series / passwords / experiment-detail の各検索
**現状の共通課題**: すべて「haystack を join → `.toLowerCase()` → `.includes()`」の単純一致。デバウンスなし・スコアリングなし・日本語正規化なし。

> 本ドキュメントは実コード（2026-07 時点）を確認して作成。旧検討メモ（scratchpad の
> search-implementation-guide 等）から以下を修正している:
>
> 1. **空白区切りの転置インデックスは日本語に不適** — 日本語は分かち書きされないため
>    単語分割ベースの inverted index はほぼヒットしない。本プランでは「正規化済み
>    haystack の事前計算 + 部分一致走査」を採用（データ規模的に十分高速）。
> 2. **カタカナ→ひらがな変換の範囲バグ** — `[ァ-ヿ]` に −0x60 すると長音「ー」(U+30FC)
>    や「・」(U+30FB) まで壊れる。正しくは `[ァ-ヶ]` (U+30A1–U+30F6) のみ変換。
> 3. **`npm test` は使えない** — 本リポジトリに package.json はない（静的サイト + GAS）。
>    テストはブラウザで開く `test.html` ランナーで行う。
> 4. **権限フィルタは既にサーバー側で担保済み** — トークンゲート（gas/Code.gs の
>    `isAdminOnlyResource` + HMAC トークン）によりクライアントは閲覧可能なデータしか
>    持たない。クライアント側の残タスクは検索履歴の扱いのみ（段階9参照）。
> 5. **検索結果件数表示・空状態ヒントは実装済み** — `renderEvents()`（script.js）の
>    見出し件数と empty-state。段階6・10は差分だけ実装する。

---

## アーキテクチャ方針

新規ファイル **`search.js`**（`app.js` の後、各ページ JS の前に読み込む）に共通ロジックを集約する。

```
config.js → api.js → app.js → search.js → (script.js | members.js | experiments.js | ...)
```

`search.js` が提供するもの:

| 関数/クラス | 役割 |
|---|---|
| `searchNormalize(text)` | 日本語正規化（段階1） |
| `parseSearchQuery(raw)` | 演算子パース（段階3） |
| `createSearcher(getData, fieldSpec)` | haystack キャッシュ + スコアリング検索（段階2, 8） |
| `highlightText(rawText, terms)` | XSS 安全なハイライト HTML 生成（段階6） |
| `attachSearchBox(input, opts)` | デバウンス・サジェスト・キーボード操作・ARIA（段階4, 5, 10） |
| `debounce(fn, ms)` | 汎用（現状リポジトリに存在しないため新設） |

各ページはフィールド定義（重み付け）だけを渡す。イベント固有の PartsList 展開などは
呼び出し側（script.js）に残し、エンジンは汎用に保つ。

---

## 段階1: クエリ正規化（日本語対応）

### 現状
```javascript
// script.js:198
function onSearchChange() {
    filterState.keyword = (document.getElementById('event-search').value || '').toLowerCase();
    renderEvents();
}
```
`.toLowerCase()` のみ。「キョウシツ」と「きょうしつ」、「Ａ１２３」と「A123」が別物として扱われる。
members.js:225 / experiments.js:130 / passwords.js:140 / event-series.js:299 / experiment-detail.js:175 も同様。

### 改善案
`String.prototype.normalize('NFKC')` で全角英数・半角カナ・互換文字を一括正規化し、
カタカナ→ひらがな変換だけ手書きする。クエリと haystack の両方に同じ関数を適用する
（片側だけ正規化すると一致しない）。

漢字⇔かなの相互変換（「教室」→「きょうしつ」）は形態素解析辞書が必要になるため
**やらない**。代わりに、データ側に読み仮名がある場合（members の `Furigana`）は
haystack に含める。イベントタイトルの読み検索は費用対効果が低いため対象外とする。

### コード例
```javascript
// search.js
function searchNormalize(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .normalize('NFKC')                 // 全角英数→半角、半角カナ→全角カナ、㈱→(株) 等
        .toLowerCase()
        .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)) // カタカナ→ひらがな（ー・は対象外）
        .replace(/[ー]/g, 'ー')        // 長音はそのまま保持（NFKC で半角ｰ→ー 済み）
        .replace(/\s+/g, ' ')
        .trim();
}
```

適用（events の例）:
```javascript
// script.js: applyFilters 内
if (filterState.keyword) {
    if (!searchNormalize(eventSearchText(e)).includes(searchNormalize(filterState.keyword))) return false;
}
```
※ 実運用では毎回正規化せず、段階8のキャッシュ経由にする。

### 実装難度: ⭐（半日）
### テスト方法
```javascript
// test.html のコンソール or アサート
assertEq(searchNormalize('キョウシツ'), 'きょうしつ');
assertEq(searchNormalize('Ａ１２３'), 'a123');
assertEq(searchNormalize('ｻｲｴﾝｽｼｮｰ'), 'さいえんすしょー');  // 半角カナ + 長音保持
assertEq(searchNormalize('ラーメン'), 'らーめん');            // 「ー」が壊れないこと
assertEq(searchNormalize('  foo　 bar '), 'foo bar');
```
実画面: events.html で「さいえんす」と「サイエンス」が同じ件数になること。

---

## 段階2: マルチフィールド優先度付け

### 現状
```javascript
// script.js:223
function eventSearchText(e) {
    const parts = [e.Title, e.Location, e.Audience, e.Remarks, e.Belongings, e.Admin_Kyoka, e.Admin_Houkoku];
    // PartsList（実験名・発表者）もパースして追加済み
    return parts.filter(Boolean).join(' ').toLowerCase();
}
```
対象フィールドは既に広い（旧メモの「フィールド不足」という指摘は誤り）。
問題は **全フィールドが等価** なことと、**ヒット後も日付順のみでソート**されること
（script.js `renderEvents()` のソートは Date 比較のみ）。

### 改善案
フィールドごとに重みを持たせ、「完全一致 > 前方一致 > 部分一致」の倍率を掛ける。
キーワード入力中はスコア降順、スコア同点は既存の日付順を維持する。

### コード例
```javascript
// search.js — 汎用スコアラ
const MATCH_BONUS = { exact: 5, prefix: 3, partial: 1 };

function scoreFieldValue(normValue, normQuery, weight) {
    if (!normValue || !normQuery) return 0;
    if (normValue === normQuery) return weight * MATCH_BONUS.exact;
    if (normValue.startsWith(normQuery)) return weight * MATCH_BONUS.prefix;
    if (normValue.includes(normQuery)) return weight * MATCH_BONUS.partial;
    return 0;
}

// 各ページのフィールド定義（呼び出し側が渡す）
// script.js
const EVENT_FIELD_SPEC = [
    { key: 'title',    weight: 100, get: e => [e.Title] },
    { key: 'location', weight: 80,  get: e => [e.Location] },
    { key: 'person',   weight: 70,  get: e => partsPresenters(e).concat([e.Admin_Kyoka, e.Admin_Houkoku]) },
    { key: 'exp',      weight: 50,  get: e => partsNames(e) },
    { key: 'remarks',  weight: 40,  get: e => [e.Remarks, e.Audience, e.Belongings] },
];

// members.js
const MEMBER_FIELD_SPEC = [
    { key: 'name',  weight: 100, get: m => [m.Name, m.Furigana] },
    { key: 'role',  weight: 70,  get: m => [memberRoleOf(m)] },
    { key: 'attr',  weight: 50,  get: m => [m.Affiliation, m.StudentID] },
    { key: 'note',  weight: 30,  get: m => [m.Note, m.Email, m.Extension] },
];
```
`renderEvents()` 側:
```javascript
const sorted = filterState.keyword
    ? filtered.slice().sort((a, b) => (b._score - a._score) || dateCompare(a, b))
    : filtered.slice().sort(dateCompare);
```

### 実装難度: ⭐⭐（1日 — ソート切替と `_score` の受け渡し設計を含む）
### テスト方法
- `{Title:'実験教室'}` は `{Remarks:'…実験…'}` より上位に出る。
- タイトル完全一致がリスト先頭に来る（`includeScore` 付きで `console.table` 確認）。
- キーワード空のとき従来と同じ日付順であること（回帰確認）。

---

## 段階3: 検索演算子サポート（AND / NOT / フレーズ / フィールド指定）

### 現状
なし。スペースを含むクエリは「スペース込みの1文字列」として `.includes()` される
（=「実験 化学」は実質ヒットしない）。

### 改善案
利用者は学生団体メンバーであり、`AND`/`OR` キーワード構文は過剰。**Google 流の暗黙構文**に絞る:

- スペース区切り = AND（全語を含む）← 最重要。現状の「スペースで検索不能」の実質バグ修正
- `-語` = NOT（除外）
- `"フレーズ"` = 完全フレーズ
- `場所:教室` / `人:山田`（events のみ、任意実装）

`OR` は必要になったら追加（優先度低）。

### コード例
```javascript
// search.js
function parseSearchQuery(raw) {
    const q = { include: [], exclude: [], phrases: [], fields: {} };
    if (!raw) return q;
    // "..." フレーズを先に抜き出す
    let rest = raw.replace(/"([^"]+)"/g, (_, p) => { q.phrases.push(searchNormalize(p)); return ' '; });
    rest.split(/\s+/).filter(Boolean).forEach(tok => {
        const m = tok.match(/^(場所|人|title|location|person)[:：](.+)$/);
        if (m) { q.fields[m[1]] = searchNormalize(m[2]); return; }
        if (tok.startsWith('-') && tok.length > 1) q.exclude.push(searchNormalize(tok.slice(1)));
        else q.include.push(searchNormalize(tok));
    });
    return q;
}

function matchesQuery(normHaystack, q) {
    return q.include.every(t => normHaystack.includes(t))
        && q.phrases.every(p => normHaystack.includes(p))
        && !q.exclude.some(t => normHaystack.includes(t));
}
```
スコアは `include` の各語のスコア合計（全語 AND 成立が前提）。

### 実装難度: ⭐⭐（1日）
### テスト方法
```javascript
const q = parseSearchQuery('実験 -中止 "第1回" 場所:教室');
assertEq(q.include, ['実験']);
assertEq(q.exclude, ['中止']);
assertEq(q.phrases, ['第1回']);
assertEq(q.fields['場所'], '教室');
```
実画面: 「実験 教室」で両方を含む日程だけが出る／「実験 -ミーティング」で除外される。

---

## 段階4: 検索提案・オートコンプリート

### 現状
なし。events.html:28 は素の `<input>`（`oninput="onSearchChange()"` のみ）。

### 改善案
入力1文字以上でドロップダウン表示。ソースは3種、計最大8件:

1. **検索履歴**（localStorage、ページ別キー `scicomi_search_history_events` 等、最大20件保存・表示3件）
2. **データ由来の候補**: イベントタイトル・場所・発表者（members ページでは氏名・所属）
3. **アクティブフィルタ内で0件になる候補は出さない**（選んだ瞬間に0件、を防ぐ）

履歴の保存タイミングは「Enter 実行 or サジェスト選択時」のみ（1文字ごとに保存しない）。

### コード例
```javascript
// search.js — attachSearchBox の一部
function buildSuggestions(partial, sources, history) {
    const np = searchNormalize(partial);
    const out = [];
    history.filter(h => searchNormalize(h).includes(np)).slice(0, 3)
        .forEach(h => out.push({ type: 'history', text: h }));
    sources.forEach(src => {            // src = { label:'タイトル', values:[...] }
        src.values
            .filter(v => v && searchNormalize(v).includes(np))
            .slice(0, 3)
            .forEach(v => { if (!out.some(s => s.text === v)) out.push({ type: src.label, text: v }); });
    });
    return out.slice(0, 8);
}
```
```html
<!-- events.html: input を wrapper で包む -->
<div class="search-box" role="search">
    <input id="event-search" class="search-input" type="search" role="combobox"
           aria-expanded="false" aria-controls="event-search-suggest"
           aria-autocomplete="list" aria-label="日程を検索"
           placeholder="タイトル・場所・発表者で検索">
    <ul id="event-search-suggest" class="search-suggest" role="listbox" hidden></ul>
</div>
```
※ `oninput="onSearchChange()"` は削除し、`attachSearchBox()` が input イベントを管理する
（デバウンス — 段階8 — と一体化するため）。

### 実装難度: ⭐⭐⭐（2日 — UI・CSS・履歴管理・0件抑制を含む）
### テスト方法
- 「じ」入力 → タイトル・場所由来の候補が 300ms 以内に出る。
- 候補クリック → その語で検索実行され、履歴の先頭に入る。
- localStorage を消して再読込 → 履歴候補が消える。
- カテゴリ「幹部MTG」選択中は、幹部MTG に存在しない候補が出ない。

---

## 段階5: キーボードナビゲーション完全サポート

### 現状
```javascript
// script.js:41 — `/` で検索窓フォーカス（実装済み）
if (e.key === '/' && document.getElementById('event-search')) { ... }
```
`n`（新規作成）・`Esc`（モーダル閉じ）・`Ctrl+S`（保存）も実装済み（script.js:25-45）。
サジェストが無いため ↓↑ 操作は存在しない。**members / experiments 等には `/` すら無い。**

### 改善案
グローバルハンドラ（script.js:25）は「INPUT 内では早期 return」する設計なので、
サジェスト操作は **input 自身の keydown リスナー**として `attachSearchBox()` 内に実装する
（既存ハンドラと衝突しない）。

- `/` : 検索窓へフォーカス → **search.js に移設して全ページ共通化**
- `↓` `↑` : サジェスト項目を選択（`aria-activedescendant` 更新）
- `Enter` : 選択中サジェストで確定 / 未選択なら現クエリで確定（履歴保存）
- `Esc` : 1回目 = サジェストを閉じる、2回目 = 入力クリアして blur
- `Tab` : サジェストを閉じて通常のフォーカス移動

`?` キーのヘルプモーダル（ショートカット一覧）は Phase 3 の任意項目とする。

### コード例
```javascript
// search.js — attachSearchBox 内
input.addEventListener('keydown', (e) => {
    const items = listEl.querySelectorAll('[role="option"]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        state.active = e.key === 'ArrowDown'
            ? (state.active + 1) % items.length
            : (state.active - 1 + items.length) % items.length;
        updateActiveOption(items, state.active);   // aria-activedescendant + .active class
    } else if (e.key === 'Enter') {
        if (state.active >= 0) { e.preventDefault(); commit(items[state.active].dataset.value); }
        else commit(input.value);
    } else if (e.key === 'Escape') {
        if (!listEl.hidden) { closeSuggest(); }
        else { input.value = ''; opts.onSearch(''); input.blur(); }
        e.stopPropagation();   // グローバルの closeAnyOpenModal を発火させない
    }
});
```

### 実装難度: ⭐⭐（1日 — 段階4と同時に実装するのが効率的）
### テスト方法
マウスを使わずに一連の操作: `/` → 「実験」入力 → `↓↓` → `Enter` → 結果確認 → `Esc``Esc` でクリア。
全ページ（events / members / experiments）で `/` が効くこと。
モーダル表示中に `Esc` が二重動作しないこと（stopPropagation の確認）。

---

## 段階6: 結果表示・グループ化・ハイライト

### 現状
- 件数表示: **実装済み**（`renderEvents()` の見出し「今後の日程 (N件)」）
- 空状態ヒント: **実装済み**（script.js:444-457、members/experiments も同様）
- ハイライト・マッチ理由表示: なし。どのフィールドに引っかかったか分からない。

### 改善案
テーブル UI のまま活かす（グループ見出しで分断するより一覧性が高い）:

1. タイトル・場所セルのマッチ部分を `<mark>` でハイライト
2. タイトル以外でヒットした行に **マッチ理由バッジ**（「発表者: 山田」「備考に一致」）を表示
   — グループ化の代替としてこちらを採用
3. 件数見出しに検索中である旨を反映（「検索結果 (N件)」）

**XSS 注意**: 本リポジトリは `escapeHtml` を徹底している（script.js:61 のコメント参照）。
ハイライトは「生テキストをセグメント分割 → 各セグメントを escapeHtml → マッチ部だけ
`<mark>` で包む」順で行い、escape 済み文字列への正規表現置換はしない。

### コード例
```javascript
// search.js — 正規化一致位置を原文にマッピングする単純版
// （NFKC で文字数が変わるケースは稀なため、原文側でも正規化比較しながら走査する）
function highlightText(rawText, terms) {
    let html = '';
    let rest = String(rawText || '');
    outer:
    while (rest) {
        const normRest = searchNormalize(rest);
        let best = -1, len = 0;
        for (const t of terms) {
            const i = normRest.indexOf(t);
            if (i >= 0 && (best < 0 || i < best)) { best = i; len = t.length; }
        }
        if (best < 0) { html += escapeHtml(rest); break outer; }
        // 正規化前後で1文字=1文字対応が崩れない前提の近似（実データはタイトル・場所の短文なので実用上十分）
        html += escapeHtml(rest.slice(0, best))
              + '<mark class="search-hit">' + escapeHtml(rest.slice(best, best + len)) + '</mark>';
        rest = rest.slice(best + len);
    }
    return html;
}
```
```css
/* style.css — 色のみに依存しない（WCAG） */
mark.search-hit { background: #fff3bf; text-decoration: underline; text-underline-offset: 2px; }
```
`renderEvents()` 側はキーワード有時のみ `escapeHtml(displayTitle)` を
`highlightText(displayTitle, q.include)` に差し替え、マッチ理由バッジを行末に追加する。

### 実装難度: ⭐⭐（1日。NFKC 長さずれの端ケース検証込み）
### テスト方法
- 「じっけん」で検索 → タイトル中の「実験」…は光らないが除外もされない（かな正規化はかな同士のみ一致）ことを確認し、仕様として明記。
- `<script>` を含むダミーデータで検索してもタグが実行されない（XSS 回帰テスト）。
- ハイライトが `Ａ１２３`（全角）データ + `a123` クエリで正しい範囲を囲むこと。

---

## 段階7: フィルタとの深い統合

### 現状
実は **基本統合は済んでいる**: `applyFilters()`（script.js:237）はカテゴリ・期間・キーワードを
同時適用する。不足しているのは:

- 検索状態が URL に残らない（リロード・共有で消える）
- フィルタチップに「その条件でのヒット件数」が出ない
- ワンタップの「リセット」がない

### 改善案
1. **URL 同期**: `?q=実験&cat=normal&period=all` を `history.replaceState` で反映、
   `init()` で復元。検索結果を Slack 等で共有可能になる。
2. **チップ件数バッジ**: キーワード入力中、各カテゴリチップに `全部 (12)` のように件数表示。
3. **リセットボタン**: キーワード or カテゴリ絞り込み中のみ表示し、`filterState` を初期化。

### コード例
```javascript
// script.js
function syncFilterToUrl() {
    const p = new URLSearchParams();
    if (filterState.keyword) p.set('q', filterState.keyword);
    if (filterState.category !== 'all') p.set('cat', filterState.category);
    if (filterState.period !== 'upcoming') p.set('period', filterState.period);
    const qs = p.toString();
    history.replaceState(null, '', qs ? 'events.html?' + qs : 'events.html');
}

function restoreFilterFromUrl() {   // init() 冒頭で呼ぶ
    const p = new URLSearchParams(location.search);
    if (p.get('q')) { filterState.keyword = p.get('q'); document.getElementById('event-search').value = p.get('q'); }
    if (p.get('cat')) onCategoryFilter(p.get('cat'));
    if (p.get('period')) onPeriodFilter(p.get('period'));
}
```
※ 既存の `?action=new` / `?edit=` / `?event=` パラメータ処理（script.js:96-156）と
干渉しないよう、`redirectLegacyEventParam()` の後に実行する。

### 実装難度: ⭐⭐（1日。既存 URL パラメータとの共存確認が本体）
### テスト方法
- 検索 → リロード → 状態が復元される。
- `events.html?q=実験&cat=normal` を直接開いて絞り込み済みで表示される。
- `?action=new` と `?q=` を同時指定しても両方動く。
- リセット → チップ・セレクト・入力・URL がすべて初期化。

---

## 段階8: パフォーマンス最適化

### 現状の実測すべき問題（コードから確定できるもの）
1. **デバウンスなし**: `oninput="onSearchChange()"`（events.html:28）→ 1キーごとに全行 innerHTML 再構築。
2. **haystack を毎回再計算**: `eventSearchText()` は 1 キーストロークごとに全イベント分
   実行され、PartsList の `JSON.parse` まで毎回走る。
3. **`occurrenceInfo()` が O(n²)**: `renderEvents()` の行生成ごとに全 eventsData を filter +
   sort する（script.js:13-22）。**検索と無関係に、現状最大のレンダリングコスト。**

### 改善案（規模認識が前提）
本システムは学生団体のポータルで、イベント数は数百件オーダー。**Web Worker と転置
インデックスは不要**（1000件 × 部分一致走査は 1ms 台）。効くのは:

1. **デバウンス 150ms**（`attachSearchBox` に内蔵。300ms は体感が重いので 150ms 推奨）
2. **正規化 haystack のキャッシュ**: `refreshData()` 成功時に一度だけ全件分を構築
3. **`occurrenceInfo` のメモ化**: シリーズ集計をデータ更新時に 1 回だけ Map 化

### コード例
```javascript
// search.js
function createSearcher(getData, fieldSpec) {
    let cache = null;   // [{ item, norm: {fieldKey: [normValues]}, hay: '全結合norm' }]
    function rebuild() {
        cache = getData().map(item => {
            const norm = {};
            fieldSpec.forEach(f => { norm[f.key] = f.get(item).filter(Boolean).map(searchNormalize); });
            return { item, norm, hay: Object.values(norm).flat().join(' ') };
        });
    }
    return {
        invalidate() { cache = null; },
        search(rawQuery) {
            if (!cache) rebuild();
            const q = parseSearchQuery(rawQuery);
            if (!q.include.length && !q.phrases.length && !q.exclude.length) return null; // 検索なし
            return cache
                .filter(c => matchesQuery(c.hay, q))
                .map(c => ({ item: c.item, score: scoreEntry(c, q, fieldSpec) }));
        }
    };
}
```
```javascript
// script.js
const eventSearcher = createSearcher(() => eventsData, EVENT_FIELD_SPEC);
// refreshData() 成功時と保存/削除後に eventSearcher.invalidate();

// occurrenceInfo のメモ化
let _seriesMap = null;   // eventsData 更新時に null へ
function seriesMap() {
    if (_seriesMap) return _seriesMap;
    _seriesMap = new Map();
    eventsData.forEach(e => {
        const k = eventSeriesKey(e);
        if (!k || !e.Date) return;
        if (!_seriesMap.has(k)) _seriesMap.set(k, []);
        _seriesMap.get(k).push(e);
    });
    _seriesMap.forEach(list => list.sort((a, b) => (a.Date || '').localeCompare(b.Date || '')));
    return _seriesMap;
}
```

### 実装難度: ⭐⭐（1日。invalidate の呼び忘れ箇所の洗い出しが本体 — 保存・削除・複製後）
### テスト方法
```javascript
// ダミー1000件を注入して計測
eventsData = Array.from({length: 1000}, (_, i) => ({ ID:'t'+i, Title:'テスト実験'+i, Date:'2026-01-01' }));
eventSearcher.invalidate();
console.time('search'); eventSearcher.search('実験'); console.timeEnd('search');  // 目標 < 50ms
console.time('render'); renderEvents(); console.timeEnd('render');               // 目標 < 200ms
```
- 編集保存直後に検索して新タイトルがヒットする（invalidate 漏れ検出）。
- 入力中の体感: 連打してもカクつかない（Performance タブで long task が消えること）。

---

## 段階9: 権限・セキュリティ考慮

### 現状（正しく理解する）
- データアクセスは **サーバー側（gas/Code.gs）で既に権限分離済み**:
  HMAC トークン（member/admin 別 + epoch 失効）、`isAdminOnlyResource` によるリソースゲート、
  監査ログ（appendAuditLog）。クライアントには閲覧許可済みデータしか届かない。
- パスワード管理ページ（passwords.html）は adminOnly ナビ + admin トークン必須。
- `handleLogout()`（app.js:190）はトークン・キャッシュ・設定キャッシュを削除する。

**したがって「検索での情報漏洩」の主リスクはサーバー側でなくクライアントの新機能側**
（本プランで追加する検索履歴・サジェスト）にある。

### 改善案（新機能に対する規律）
1. **検索履歴キーを `handleLogout()` の削除対象に追加**（`scicomi_search_history_*`）。
2. **passwords.html では履歴・サジェストを無効化**（`attachSearchBox` にオプション
   `history: false` を用意）。検索語自体が「何のパスワードを探したか」という情報になるため。
3. サジェスト候補は「現在メモリ上にあるデータ」からのみ生成する（= トークンで取得済みの
   データ。別途インデックスを localStorage に永続化しない）。
4. 検索ログのサーバー送信（監査）は **行わない**。GAS 無料枠の実行回数を消費する割に、
   数十人規模の内部ツールでは得るものがない。

### コード例
```javascript
// app.js: handleLogout に1行追加
Object.keys(localStorage)
    .filter(k => k.startsWith('scicomi_search_history_'))
    .forEach(k => localStorage.removeItem(k));
```

### 実装難度: ⭐（数時間）
### テスト方法
- ログアウト → localStorage に `scicomi_search_history_*` が残っていない（DevTools で確認）。
- passwords.html で検索してもサジェスト UI が出ず、履歴も書き込まれない。
- member トークンのみで events を検索 → admin 専用リソース由来の候補が出ない
  （そもそもデータが無いことの確認）。

---

## 段階10: アクセシビリティ（WCAG AA）

### 現状
- できている: フィルタチップの `aria-pressed`（events.html:32-36）、トーストの
  `aria-live="polite"`（app.js:593）、モーダルの `role="dialog"` + trapFocus、empty-state ヒント。
- 不足: 検索入力に **label / aria-label がない**（placeholder と title のみ）。結果件数
  更新がスクリーンリーダーに通知されない。サジェスト（新設）の ARIA。

### 改善案
1. 検索入力: `type="search"` + `aria-label` + wrapper に `role="search"`（段階4の HTML に含む）
2. 件数見出し `#event-list-heading` に `aria-live="polite"` を付与
   （検索のたびに「検索結果 (5件)」が読み上げられる）
3. サジェスト: combobox パターン（`role="combobox"` + `aria-expanded` +
   `aria-activedescendant` + `role="listbox"/"option"` + `aria-selected`）— 段階4・5の実装に内蔵
4. ハイライトは背景色 + 下線の二重表現（段階6の CSS）
5. `mark.search-hit` の配色コントラスト比 4.5:1 以上を確認（#fff3bf 背景 + 既定文字色は AA を満たす）

### コード例
```html
<!-- events.html -->
<h2 id="event-list-heading" aria-live="polite"></h2>
```
```javascript
// attachSearchBox 内 — 開閉時
input.setAttribute('aria-expanded', String(!listEl.hidden));
```

### 実装難度: ⭐（既存段階に埋め込む形。単独作業は半日）
### テスト方法
- NVDA（Windows）で: `/` → 入力 → 「検索結果 (N件)」が読み上げられる、↓ で候補名が読み上げられる。
- キーボードのみで検索→候補選択→結果閲覧→リセットまで完結する。
- Chrome DevTools Lighthouse の Accessibility スコアで検索関連の指摘ゼロ。
- コントラスト: DevTools のカラーピッカーで mark の比率 ≥ 4.5:1。

---

# 3週間ロードマップ

前提: 実装順は「共通基盤 → events で完成 → 他ページへ横展開」。各週末にデプロイ可能な状態を保つ。

## Phase 1: 基本品質向上（Week 1）— 検索が「正しく」なる

| 日 | 作業 | 対応段階 |
|---|---|---|
| 1 | `search.js` 新設: `searchNormalize` / `debounce` / `test.html`（アサートランナー） | 1 |
| 2 | `createSearcher` + haystack キャッシュ + `invalidate` 配線（refreshData / 保存 / 削除） | 8 |
| 3 | スコアリング + スコア順ソート（events） | 2 |
| 4 | スペース AND / `-除外` / フレーズ（`parseSearchQuery`） | 3（基本形） |
| 5 | ハイライト + マッチ理由バッジ（events）、XSS 回帰テスト | 6 |

**完了条件**: 「サイエンス」=「さいえんす」で同結果 / 「実験 教室」で AND 検索 /
タイトル一致が先頭 / 1000件ダミーで検索 <50ms / `<script>` 入りデータで安全。

## Phase 2: 体験向上（Week 2）— 検索が「気持ちよく」なる

| 日 | 作業 | 対応段階 |
|---|---|---|
| 1-2 | `attachSearchBox`: サジェスト UI + 履歴（localStorage）+ CSS | 4 |
| 3 | キーボード完全対応（↓↑ Enter Esc、`/` の共通化） | 5 |
| 4 | combobox ARIA + `aria-live` 件数 + NVDA 確認 | 10 |
| 5 | members / experiments へ横展開（FIELD_SPEC を書くだけの状態にする） | 2,4,5 |

**完了条件**: マウスなしで検索が完結 / サジェスト <300ms / NVDA で操作可能 /
members・experiments でも同品質。

## Phase 3: 高度な機能（Week 3）— 検索が「行き渡る」

| 日 | 作業 | 対応段階 |
|---|---|---|
| 1 | URL 同期（?q= 復元・共有）+ リセットボタン + チップ件数バッジ | 7 |
| 2 | `場所:` `人:` フィールド指定（events） | 3（拡張） |
| 3 | 権限まわり: 履歴のログアウト消去 / passwords の履歴無効化 | 9 |
| 4 | 残ページ横展開（event-series / experiment-detail / passwords） + occurrenceInfo メモ化 | 8 |
| 5 | 総合テスト（下記チェックリスト）+ Lighthouse + 実データでのユーザーテスト | 全 |

**完了条件**: 全6検索が search.js 経由 / URL 共有が機能 / ログアウトで履歴消去 /
Lighthouse Accessibility で検索関連指摘ゼロ。

---

## 最終チェックリスト

```
機能
[ ] ひらがな/カタカナ/全角半角の揺れを吸収して同一結果
[ ] スペース区切り AND・-除外・"フレーズ" が機能
[ ] タイトル完全一致 > 前方一致 > 部分一致 > 他フィールドの順に表示
[ ] サジェスト（履歴 + タイトル + 場所 + 人名）が表示・選択可能
[ ] / ↓ ↑ Enter Esc のみで検索が完結（全ページ）
[ ] マッチ部分ハイライト + マッチ理由バッジ
[ ] ?q= URL で検索状態を共有・復元できる
[ ] 検索 + カテゴリ + 期間フィルタの同時適用（既存機能の回帰なし）

性能（1000件ダミーで計測）
[ ] search() < 50ms / renderEvents() < 200ms
[ ] 入力連打でフレーム落ちしない（デバウンス 150ms）
[ ] 編集・削除・複製の直後に検索キャッシュが最新（invalidate 漏れなし）

安全・権限
[ ] <script> 入りデータでハイライトしても XSS が発生しない
[ ] ログアウトで検索履歴が消える
[ ] passwords.html は履歴・サジェスト無効

アクセシビリティ
[ ] NVDA で件数読み上げ・候補読み上げ
[ ] mark のコントラスト比 ≥ 4.5:1 + 下線の二重表現
[ ] Lighthouse Accessibility 指摘ゼロ（検索 UI 起因）
```
