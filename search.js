/**
 * SciComi Portal - 共通検索エンジン
 *
 * リスト系ページ（events / members / experiments / event-series / experiment-detail /
 * passwords）の検索を共通化する（config.js → api.js → app.js の後、各ページ JS の前に読み込む前提）:
 *   - searchNormalize:     日本語正規化（かな統一・全角半角統一）
 *   - parseSearchQuery:    検索演算子のパース（スペース=AND / -語=除外 / "フレーズ" / 場所:○○）
 *   - matchesParsedQuery:  単純 haystack ページ向けの照合ヘルパ
 *   - createSearcher:      フィールド重み付きスコアリング検索（正規化キャッシュ付き）
 *   - highlightText:       マッチ部分の <mark> ハイライト（XSS 安全・複数語対応）
 *   - attachSearchBox:     検索窓へデバウンス・サジェスト・キーボード操作・ARIA を一括バインド
 *   - announceSearchResult: スクリーンリーダー向けの結果件数アナウンス
 *   - グローバルショートカット: `/` で検索窓フォーカス、`?` でヘルプモーダル
 *
 * 漢字⇔かなの相互変換（「教室」↔「きょうしつ」）は形態素辞書が必要になるため行わない。
 * 読みで探したいデータは読み仮名フィールド（members の Furigana 等）を
 * フィールド定義に含めることで対応する。
 */

// ====== デバウンス ======

function debounce(fn, wait) {
  let timer = null;
  const debounced = function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
  };
  debounced.cancel = () => { clearTimeout(timer); timer = null; };
  return debounced;
}

// ====== 日本語正規化 ======

// NFKC で全角英数→半角・半角カナ→全角カナ等を統一し、カタカナはひらがなへ寄せる。
// カタカナ変換の範囲は [ァ-ヶ] のみ（「ー」「・」まで含めると別文字に壊れるため）。
function searchNormalize(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ')
    .trim();
}

// ハイライト用の1文字正規化。searchNormalize と同じ変換だが、元テキストとの
// 位置対応を保つために空白の除去・連結はしない（空白1文字は空白1文字のまま）。
function _searchNormChar(ch) {
  return ch.normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s/g, ' ');
}

// ====== 検索演算子のパース ======

// Google 流の暗黙構文のみサポートする（AND/OR キーワード構文は利用者層に対して過剰）:
//   スペース区切り = AND（全語を含む） / -語 = 除外 / "フレーズ" = ひとまとまりで一致
//   場所:教室 のようなフィールド限定（対応フィールドは各ページの fieldSpec の aliases で定義）
const SEARCH_FIELD_PREFIXES = ['場所', '人', '担当', 'タイトル', 'title', 'location', 'person'];

// 戻り値: { include:[], exclude:[], phrases:[], fields:[{name, value}] }（すべて正規化済み）。
// 有効な語が1つも無ければ null（呼び出し側は「検索なし」として扱う）。
function parseSearchQuery(raw) {
  if (raw === null || raw === undefined) return null;
  const q = { include: [], exclude: [], phrases: [], fields: [] };

  // 全角記号を半角へ寄せてからパースする（＂ → " / － → - / 全角スペース → 半角）
  let rest = String(raw).normalize('NFKC').replace(/[“”„]/g, '"');

  // "..." フレーズを先に抜き出す
  rest = rest.replace(/"([^"]*)"/g, (_, p) => {
    const norm = searchNormalize(p);
    if (norm) q.phrases.push(norm);
    return ' ';
  });

  rest.split(/\s+/).filter(Boolean).forEach(tok => {
    // フィールド限定（既知の接頭辞のみ。URL 等の「:」を誤爆させない）
    const m = tok.match(/^([^:：]+)[:：](.+)$/);
    if (m && SEARCH_FIELD_PREFIXES.indexOf(m[1]) >= 0) {
      const value = searchNormalize(m[2]);
      if (value) q.fields.push({ name: searchNormalize(m[1]), value });
      return;
    }
    // -語 = 除外
    if (tok.length > 1 && tok[0] === '-') {
      const t = searchNormalize(tok.slice(1));
      if (t) q.exclude.push(t);
      return;
    }
    const t = searchNormalize(tok);
    if (t) q.include.push(t);
  });

  if (!q.include.length && !q.exclude.length && !q.phrases.length && !q.fields.length) return null;
  return q;
}

// ハイライト対象の語（除外以外のすべての正の語）を返す
function searchQueryTerms(pq) {
  if (!pq) return [];
  return pq.include.concat(pq.phrases, pq.fields.map(f => f.value));
}

// フィールド構造を持たないページ（event-series / experiment-detail / passwords）向けの照合。
// フィールド指定はこのヘルパでは通常語として扱う。
function matchesParsedQuery(hayNorm, pq) {
  if (!pq) return true;
  if (pq.exclude.some(t => hayNorm.includes(t))) return false;
  for (const t of pq.include) if (!hayNorm.includes(t)) return false;
  for (const p of pq.phrases) if (!hayNorm.includes(p)) return false;
  for (const f of pq.fields) if (!hayNorm.includes(f.value)) return false;
  return true;
}

// ====== スコアリング検索 ======

// 一致の強さ: 完全一致 ×5 / 前方一致 ×3 / 部分一致 ×1 をフィールド重みに掛ける。
const SEARCH_MATCH_EXACT = 5;
const SEARCH_MATCH_PREFIX = 3;
const SEARCH_MATCH_PARTIAL = 1;

/**
 * fieldSpec: [{ key, label, weight, get(item) => [文字列, ...], aliases?: [...] }] を重要度順に並べる。
 *   aliases はフィールド限定検索（場所:教室 等）で使う接頭辞（SEARCH_FIELD_PREFIXES に載っているもの）。
 * getData(): 最新のデータ配列を返す関数（ページ側のグローバル配列をそのまま参照）。
 */
function createSearcher(getData, fieldSpec) {
  // 正規化済みテキストのキャッシュ。このアプリのデータ更新はどの経路でも
  // 「新しいオブジェクトへの差し替え」（gasToUi / {...item} / JSON クローン）なので、
  // オブジェクト単位の WeakMap にしておけば明示的な無効化なしで常に最新が引ける。
  let cache = new WeakMap();

  function entryFor(item) {
    let en = cache.get(item);
    if (!en) {
      const fields = fieldSpec.map(f => {
        const values = [];
        (f.get(item) || []).forEach(v => {
          if (v === null || v === undefined) return;
          const norm = searchNormalize(v);
          if (norm) values.push({ raw: String(v), norm });
        });
        return values;
      });
      en = {
        fields,
        hay: fields.map(vs => vs.map(v => v.norm).join(' ')).join(' ')
      };
      cache.set(item, en);
    }
    return en;
  }

  function fieldIndexFor(name) {
    return fieldSpec.findIndex(f =>
      f.key === name || searchNormalize(f.label) === name || (f.aliases || []).indexOf(name) >= 0);
  }

  // 1アイテムの照合。query は生文字列でもパース済みオブジェクトでも良い。
  // ヒットしなければ null、ヒットすれば { score, match }。
  // match はスコアが付いた最重要フィールド（「何に一致したか」バッジ用）。
  // フィールド境界をまたいだ一致（score 0）も従来の join 検索と同じく結果に残す。
  function matchItem(item, query) {
    const pq = typeof query === 'string' ? parseSearchQuery(query) : query;
    if (!pq) return null;
    const en = entryFor(item);

    // (1) 除外
    if (pq.exclude.some(t => en.hay.includes(t))) return null;

    // (2) AND: 全語・全フレーズを含むこと
    const terms = pq.include.concat(pq.phrases);
    for (const t of terms) if (!en.hay.includes(t)) return null;

    // (3) フィールド限定。このサーチャーに該当フィールドがあれば限定一致、
    //     無ければ（members で 場所: を使った等）通常語として扱う。
    const fieldTerms = [];   // { fi, value }
    for (const f of pq.fields) {
      const fi = fieldIndexFor(f.name);
      if (fi < 0) {
        if (!en.hay.includes(f.value)) return null;
        terms.push(f.value);
      } else {
        if (!en.fields[fi].some(v => v.norm.includes(f.value))) return null;
        fieldTerms.push({ fi, value: f.value });
      }
    }

    // 除外だけのクエリ（例 "-中止"）は絞り込みとしては有効。スコアは付かない。
    if (terms.length === 0 && fieldTerms.length === 0) return { score: 0, match: null };

    // (4) スコア: 各語ごとに「フィールド内の最大一致強度 × フィールド重み」を合算
    let score = 0;
    let match = null;
    fieldSpec.forEach((f, fi) => {
      const applicable = terms.concat(fieldTerms.filter(ft => ft.fi === fi).map(ft => ft.value));
      let fieldBest = 0;
      let bestRaw = '';
      for (const t of applicable) {
        let best = 0;
        let raw = '';
        for (const v of en.fields[fi]) {
          const m = v.norm === t ? SEARCH_MATCH_EXACT
            : v.norm.startsWith(t) ? SEARCH_MATCH_PREFIX
            : v.norm.includes(t) ? SEARCH_MATCH_PARTIAL
            : 0;
          if (m > best) { best = m; raw = v.raw; }
          if (best === SEARCH_MATCH_EXACT) break;
        }
        score += f.weight * best;
        if (best > fieldBest) { fieldBest = best; bestRaw = raw; }
      }
      if (fieldBest > 0 && !match) match = { key: f.key, label: f.label, value: bestRaw };
    });
    return { score, match };
  }

  return {
    // クエリが空（または演算子のみで無効）なら null（呼び出し側は従来の全件表示へ）。
    // ヒットのみ [{ item, score, match }] で返す（並び順はデータ順のまま）。
    search(query) {
      const pq = typeof query === 'string' ? parseSearchQuery(query) : query;
      if (!pq) return null;
      const out = [];
      for (const item of getData()) {
        const r = matchItem(item, pq);
        if (r) out.push({ item, score: r.score, match: r.match });
      }
      return out;
    },
    matchItem
  };
}

// ====== ハイライト ======

// 生テキスト中で正規化クエリ（文字列 or 語の配列）に一致する範囲を <mark> で囲んだ
// HTML を返す。escape 済み文字列への正規表現置換はせず、生テキストを分割してから
// 各断片を escapeHtml（app.js）する。全角・カナ違いの一致でも正しい範囲を囲めるよう、
// 「正規化後の各文字が生テキストのどの位置由来か」の対応表を経由する。
function highlightText(rawText, normQuery) {
  const raw = String(rawText === null || rawText === undefined ? '' : rawText);
  const terms = (Array.isArray(normQuery) ? normQuery : [normQuery]).filter(Boolean);
  if (!terms.length) return escapeHtml(raw);

  const normChars = [];
  const srcStart = [];  // 正規化文字 → 生テキスト上の開始 index
  const srcEnd = [];    // 同・終了 index（排他的）
  let i = 0;
  for (const cp of raw) {  // サロゲートペア安全にコードポイント単位で走査
    const n = _searchNormChar(cp);
    for (const c of n) {
      normChars.push(c);
      srcStart.push(i);
      srcEnd.push(i + cp.length);
    }
    i += cp.length;
  }
  const normStr = normChars.join('');

  let html = '';
  let rawCursor = 0;
  let pos = 0;
  while (pos < normStr.length) {
    // 全語の中で最も手前（同点なら最長）の一致を採用する
    let hit = -1;
    let len = 0;
    for (const t of terms) {
      const idx = normStr.indexOf(t, pos);
      if (idx >= 0 && (hit < 0 || idx < hit || (idx === hit && t.length > len))) { hit = idx; len = t.length; }
    }
    if (hit < 0) break;
    const s = srcStart[hit];
    const e = srcEnd[hit + len - 1];
    if (s >= rawCursor) {
      html += escapeHtml(raw.slice(rawCursor, s))
        + '<mark class="search-hit">' + escapeHtml(raw.slice(s, e)) + '</mark>';
      rawCursor = e;
    }
    pos = hit + len;
  }
  html += escapeHtml(raw.slice(rawCursor));
  return html;
}

// ====== グローバルキーボードショートカット（/ と ?） ======

let _searchBoxPrimaryInput = null;   // ページ内で最初に attachSearchBox した入力（/ の飛び先）
let _searchGlobalKeysBound = false;
let _searchHelpExtras = [];          // ページ固有のショートカット行（attachSearchBox の helpShortcuts）

function _bindGlobalSearchKeys() {
  if (_searchGlobalKeysBound) return;
  _searchGlobalKeysBound = true;
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // ウィザード・確認ダイアログ・認証・モーダル表示中は発動しない（ページ側の規約と揃える）
    if (document.querySelector('.wizard-overlay, .confirm-dialog-overlay, #admin-auth-modal, #pw-modal, .modal-overlay:not(.hidden)')) return;
    if (e.key === '/' && _searchBoxPrimaryInput && document.contains(_searchBoxPrimaryInput)) {
      e.preventDefault();
      _searchBoxPrimaryInput.focus();
      if (_searchBoxPrimaryInput.select) _searchBoxPrimaryInput.select();
    } else if (e.key === '?') {
      e.preventDefault();
      showSearchHelpModal();
    }
  });
}

// ショートカット・検索構文の一覧モーダル（? キー）。
function showSearchHelpModal() {
  if (document.getElementById('search-help-modal')) return;
  const keyRows = [
    ['/', '検索ボックスへ移動'],
    ['↓ ↑', '検索候補を選択'],
    ['Enter', '候補の確定・検索の実行'],
    ['Esc', '候補を閉じる → 検索をクリア'],
    ['?', 'このヘルプを表示']
  ].concat(_searchHelpExtras);
  const syntaxRows = [
    ['実験 教室', 'すべての語を含む（AND）'],
    ['-中止', 'その語を含まない（除外）'],
    ['"第1回"', 'ひとまとまりで一致（フレーズ）'],
    ['場所:教室 / 人:山田', 'フィールドを限定して検索']
  ];
  const row = ([k, desc]) => `<tr><td class="search-help-key"><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(desc)}</td></tr>`;

  const overlay = document.createElement('div');
  overlay.id = 'search-help-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:440px;" role="dialog" aria-modal="true" aria-labelledby="search-help-title">
      <h2 id="search-help-title" style="margin-top:0;">キーボードショートカット</h2>
      <table class="search-help-table">${keyRows.map(row).join('')}</table>
      <h3 style="font-size:0.95rem;margin:16px 0 4px;">検索の書き方</h3>
      <table class="search-help-table">${syntaxRows.map(row).join('')}</table>
      <div class="action-buttons" style="margin-top:16px;">
        <button type="button" class="btn btn-secondary" data-close>閉じる</button>
      </div>
    </div>`;
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  bindOverlayClose(overlay, close);
  bindModalEscape(overlay, close);
  document.body.appendChild(overlay);
  trapFocus(overlay.querySelector('.modal-content'));
  setTimeout(() => overlay.querySelector('[data-close]').focus(), 30);
}

// ====== 検索窓バインド（デバウンス + サジェスト + キーボード + ARIA） ======

const SEARCH_HISTORY_PREFIX = 'scicomi_search_history_';
const SEARCH_HISTORY_MAX = 20;

function _searchHistoryLoad(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(arr) ? arr.filter(v => typeof v === 'string') : [];
  } catch (_) { return []; }
}

function _searchHistorySave(key, term) {
  term = (term || '').trim();
  if (term.length < 2) return;  // 1文字は履歴として役に立たない
  const arr = _searchHistoryLoad(key).filter(v => v !== term);
  arr.unshift(term);
  try { localStorage.setItem(key, JSON.stringify(arr.slice(0, SEARCH_HISTORY_MAX))); } catch (_) {}
}

/**
 * 検索入力へ検索動作を一括バインドする。
 *   opts.onSearch(value)    : 入力の変化ごと（デバウンス済み）と確定時に呼ばれる
 *   opts.suggestSources()   : [{ label, values: [...] }] を返す関数（省略時サジェスト無効）
 *   opts.historyKey         : 履歴 localStorage キーの接尾辞（省略で履歴無効。
 *                             パスワード等、検索語自体が機微な画面では指定しない）
 *   opts.helpShortcuts      : ? ヘルプに追加するページ固有ショートカット [['n','説明'], ...]
 *   opts.debounceMs         : 既定 150ms
 * サジェストの表示先は input の aria-controls が指す <ul role="listbox">（無ければ
 * デバウンス検索のみ動く）。候補の選択は ↓↑ / Enter / クリック、Esc は
 * 1回目でサジェストを閉じ、2回目で入力をクリアする。`/` はこの入力へフォーカスする。
 */
function attachSearchBox(input, opts) {
  if (!input) return;
  const onSearch = opts.onSearch;
  const listEl = document.getElementById(input.getAttribute('aria-controls') || '');
  const histKey = opts.historyKey ? SEARCH_HISTORY_PREFIX + opts.historyKey : null;
  const maxItems = opts.maxItems || 8;

  // グローバルショートカット（/ と ?）の飛び先として登録
  if (!_searchBoxPrimaryInput) _searchBoxPrimaryInput = input;
  if (opts.helpShortcuts) _searchHelpExtras = _searchHelpExtras.concat(opts.helpShortcuts);
  _bindGlobalSearchKeys();
  if (!input.title) input.title = 'ショートカット: / キーで検索欄へ';

  let activeIndex = -1;
  let currentItems = [];

  const debouncedInput = debounce(() => {
    onSearch(input.value);
    openSuggest();
  }, opts.debounceMs !== undefined ? opts.debounceMs : 150);

  function buildSuggestions(partial) {
    const np = searchNormalize(partial);
    if (!np) return [];
    const out = [];
    const seen = new Set();
    const push = (type, text) => {
      const k = searchNormalize(text);
      if (!k || seen.has(k) || k === np) return false;  // 入力と同一の候補は出さない
      seen.add(k);
      out.push({ type, text });
      return true;
    };
    if (histKey) {
      let added = 0;
      for (const h of _searchHistoryLoad(histKey)) {
        if (added >= 3) break;
        if (searchNormalize(h).includes(np) && push('履歴', h)) added++;
      }
    }
    if (opts.suggestSources) {
      for (const src of opts.suggestSources()) {
        let added = 0;
        for (const v of src.values) {
          if (added >= 3 || out.length >= maxItems) break;
          if (v && searchNormalize(v).includes(np) && push(src.label, v)) added++;
        }
        if (out.length >= maxItems) break;
      }
    }
    return out.slice(0, maxItems);
  }

  function closeSuggest() {
    if (!listEl) return;
    listEl.hidden = true;
    listEl.innerHTML = '';
    currentItems = [];
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function openSuggest() {
    if (!listEl) return;
    currentItems = buildSuggestions(input.value);
    activeIndex = -1;
    if (currentItems.length === 0) { closeSuggest(); return; }
    const nq = searchNormalize(input.value);
    listEl.innerHTML = currentItems.map((it, i) => `
      <li id="${listEl.id}-opt-${i}" class="search-suggest-item" role="option" aria-selected="false" data-value="${escapeAttr(it.text)}">
        <span class="search-suggest-type" aria-hidden="true">${escapeHtml(it.type)}</span>
        <span class="search-suggest-text">${highlightText(it.text, nq)}</span>
      </li>`).join('');
    listEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function setActive(idx) {
    activeIndex = idx;
    const items = listEl.querySelectorAll('.search-suggest-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.setAttribute('aria-selected', String(i === idx));
    });
    if (idx >= 0 && items[idx]) {
      input.setAttribute('aria-activedescendant', items[idx].id);
      items[idx].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function commit(value) {
    debouncedInput.cancel();
    input.value = value;
    if (histKey) _searchHistorySave(histKey, value);
    closeSuggest();
    onSearch(value);
  }

  input.addEventListener('input', debouncedInput);

  input.addEventListener('keydown', (e) => {
    const open = listEl && !listEl.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open || currentItems.length === 0) return;
      e.preventDefault();
      const n = currentItems.length;
      setActive(e.key === 'ArrowDown' ? (activeIndex + 1) % n : (activeIndex - 1 + n) % n);
    } else if (e.key === 'Enter') {
      // IME 変換確定の Enter（keyCode 229 は isComposing が false になる Safari 等向け）では検索を確定しない
      if (e.isComposing || e.keyCode === 229) return;
      if (open && activeIndex >= 0) {
        e.preventDefault();
        commit(currentItems[activeIndex].text);
      } else {
        commit(input.value);
      }
    } else if (e.key === 'Escape') {
      // ページ側の Esc 処理（モーダル閉じ等）を誤発火させない
      e.stopPropagation();
      if (open) { closeSuggest(); return; }
      if (input.value) {
        input.value = '';
        debouncedInput.cancel();
        onSearch('');
      }
      input.blur();
    } else if (e.key === 'Tab') {
      closeSuggest();
    }
  });

  if (listEl) {
    // mousedown を殺して blur より先にクリックを成立させる（フォーカスは入力に残す）
    listEl.addEventListener('mousedown', (e) => e.preventDefault());
    listEl.addEventListener('click', (e) => {
      const li = e.target.closest('.search-suggest-item');
      if (li) commit(li.dataset.value);
    });
  }

  input.addEventListener('blur', () => closeSuggest());
  input.addEventListener('focus', () => { if (input.value) openSuggest(); });
}

// ====== スクリーンリーダー向け結果件数アナウンス ======

// aria-live 領域へ件数を書き込む（視覚上は不可視）。ページに1つだけ生成して使い回す。
function announceSearchResult(message) {
  let el = document.getElementById('search-live-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'search-live-status';
    el.className = 'sr-only';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
}
