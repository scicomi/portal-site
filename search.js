/**
 * SciComi Portal - 共通検索エンジン
 *
 * リスト系ページ（events / members / experiments 等）の検索を共通化する
 * （config.js → api.js → app.js の後、各ページ JS の前に読み込む前提）:
 *   - searchNormalize: 日本語正規化（かな統一・全角半角統一）
 *   - createSearcher:  フィールド重み付きスコアリング検索（正規化キャッシュ付き）
 *   - highlightText:   マッチ部分の <mark> ハイライト（XSS 安全）
 *   - attachSearchBox: 検索窓へデバウンス・サジェスト・キーボード操作・ARIA を一括バインド
 *   - announceSearchResult: スクリーンリーダー向けの結果件数アナウンス
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

// ====== ハイライト ======

// 生テキスト中で正規化クエリに一致する範囲を <mark> で囲んだ HTML を返す。
// escape 済み文字列への正規表現置換はせず、生テキストを分割してから各断片を
// escapeHtml（app.js）する。全角・カナ違いの一致でも正しい範囲を囲めるよう、
// 「正規化後の各文字が生テキストのどの位置由来か」の対応表を経由する。
function highlightText(rawText, normQuery) {
  const raw = String(rawText === null || rawText === undefined ? '' : rawText);
  if (!normQuery) return escapeHtml(raw);

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
  let cursor = 0;
  let from = 0;
  for (;;) {
    const hit = normStr.indexOf(normQuery, from);
    if (hit < 0) break;
    const s = srcStart[hit];
    const e = srcEnd[hit + normQuery.length - 1];
    if (s >= cursor) {
      html += escapeHtml(raw.slice(cursor, s))
        + '<mark class="search-hit">' + escapeHtml(raw.slice(s, e)) + '</mark>';
      cursor = e;
    }
    from = hit + normQuery.length;
  }
  html += escapeHtml(raw.slice(cursor));
  return html;
}

// ====== スコアリング検索 ======

// 一致の強さ: 完全一致 ×5 / 前方一致 ×3 / 部分一致 ×1 をフィールド重みに掛ける。
const SEARCH_MATCH_EXACT = 5;
const SEARCH_MATCH_PREFIX = 3;
const SEARCH_MATCH_PARTIAL = 1;

/**
 * fieldSpec: [{ key, label, weight, get(item) => [文字列, ...] }] を重要度順に並べる。
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

  // 1アイテムの照合。ヒットしなければ null、ヒットすれば { score, match }。
  // match はスコアが付いた最重要フィールド（「何に一致したか」バッジ用）。
  // フィールド境界をまたいだ一致（score 0）も従来の join 検索と同じく結果に残す。
  function matchItem(item, normQuery) {
    if (!normQuery) return null;
    const en = entryFor(item);
    if (!en.hay.includes(normQuery)) return null;
    let score = 0;
    let match = null;
    fieldSpec.forEach((f, fi) => {
      let best = 0;
      let bestRaw = '';
      for (const v of en.fields[fi]) {
        const m = v.norm === normQuery ? SEARCH_MATCH_EXACT
          : v.norm.startsWith(normQuery) ? SEARCH_MATCH_PREFIX
          : v.norm.includes(normQuery) ? SEARCH_MATCH_PARTIAL
          : 0;
        if (m > best) { best = m; bestRaw = v.raw; }
        if (best === SEARCH_MATCH_EXACT) break;
      }
      if (best > 0) {
        score += f.weight * best;
        if (!match) match = { key: f.key, label: f.label, value: bestRaw };
      }
    });
    return { score, match };
  }

  return {
    // クエリが空なら null（呼び出し側は従来の全件表示へ）。
    // ヒットのみ [{ item, score, match }] で返す（並び順はデータ順のまま）。
    search(rawQuery) {
      const nq = searchNormalize(rawQuery);
      if (!nq) return null;
      const out = [];
      for (const item of getData()) {
        const r = matchItem(item, nq);
        if (r) out.push({ item, score: r.score, match: r.match });
      }
      return out;
    },
    matchItem
  };
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
 *   opts.debounceMs         : 既定 150ms
 * サジェストの表示先は input の aria-controls が指す <ul role="listbox">（無ければ
 * デバウンス検索のみ動く）。候補の選択は ↓↑ / Enter / クリック、Esc は
 * 1回目でサジェストを閉じ、2回目で入力をクリアする。
 */
function attachSearchBox(input, opts) {
  if (!input) return;
  const onSearch = opts.onSearch;
  const listEl = document.getElementById(input.getAttribute('aria-controls') || '');
  const histKey = opts.historyKey ? SEARCH_HISTORY_PREFIX + opts.historyKey : null;
  const maxItems = opts.maxItems || 8;

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
