/**
 * ガイドページ（Notion 風の手順書・マニュアル集）
 *
 * - 閲覧と編集は同じ画面。開いたページの文字をクリックして、そのまま書き換える（編集専用ページはない）。
 *   書いた内容は少し待って自動で保存される。「/」でブロックの種類を選ぶ。
 * - ページは入れ子にできる（左のツリー）。本文は Editor.js（vendor/editorjs/）のブロック JSON を Body 列に文字列で保存する。
 * - 閲覧はログインしたメンバー全員。作成・編集・削除は管理者のみ（サーバーでも同じ制限。メンバーには読み取り専用で表示する）。
 * - 同時編集は _baseUpdatedAt で検知する（api.save → worker の saveResource）。
 * - データは guides リソース（worker/src/tables.js）。キャッシュはしない（件数が少なく、常に最新を見せたい）。
 */

let gdPages = [];          // 全ページ（表示順に並べ済み）
let gdCurrentId = '';      // 表示中のページ ID（'' = ガイドのトップ、または未保存の新規ページ）
let gdDraft = null;        // 新規ページ（まだ保存していない） { parentId } / null
let gdBase = '';           // 開いているページの UpdatedAt（競合検知の基準。保存のたびに更新）
let gdDirty = false;       // 未保存の変更があるか
let gdSaving = false;
let gdSaveAgain = false;   // 保存中にさらに変更が入った
let gdSaveTimer = null;
let gdConflict = false;    // 他の人が先に更新した（自動保存を止めている）
let gdSearchKw = '';
let gdEditor = null;       // 表示中の Editor.js
let gdMountSeq = 0;
const GD_OPEN_KEY = 'scicomi_guide_open';
const GD_SAVE_DELAY_MS = 1200;

// ---------- 本文（ブロック JSON）の読み書き ----------

function gdParseBody(body) {
  const s = String(body || '').trim();
  if (!s) return [];
  try {
    const d = JSON.parse(s);
    if (d && Array.isArray(d.blocks)) return gdMigrateBlocks(d.blocks);
  } catch (_) {}
  // JSON でない本文（手で DB に入れた文章など）は、1 行 1 段落として扱う
  return s.split(/\n+/).map(t => ({ type: 'paragraph', data: { text: escapeHtml(t) } }));
}

// 旧形式のトグル（見出し＋本文を 1 ブロックに持つ）を、新形式（見出し＋インデントした下のブロック）に直す
function gdMigrateBlocks(blocks) {
  const out = [];
  blocks.forEach(b => {
    if (b && b.type === 'toggle' && b.data && b.data.text) {
      out.push({ type: 'toggle', data: { title: b.data.title || '' }, tunes: b.tunes });
      out.push({ type: 'paragraph', data: { text: b.data.text }, tunes: { indentTune: { level: Math.min(3, (((b.tunes || {}).indentTune || {}).level || 0) + 1) } } });
    } else out.push(b);
  });
  return out;
}

// HTML 断片を文字だけにする（検索・カード用）。DOMParser はスクリプトを実行しない
function gdPlain(html) {
  if (!html) return '';
  return (new DOMParser().parseFromString(String(html), 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();
}

function gdBlocksText(blocks) {
  const out = [];
  const items = (list) => (list || []).forEach(it => { out.push(gdPlain(it.content)); items(it.items); });
  blocks.forEach(b => {
    const d = b.data || {};
    switch (b.type) {
      case 'paragraph': case 'header': case 'quote': out.push(gdPlain(d.text)); break;
      case 'callout': out.push(gdPlain(d.text)); break;
      case 'toggle': out.push(gdPlain(d.title)); break;
      case 'list': items(d.items); break;
      case 'table': (d.content || []).forEach(r => r.forEach(c => out.push(gdPlain(c)))); break;
      case 'code': out.push(String(d.code || '')); break;
      case 'file': out.push(String(d.name || '')); break;
      case 'image': out.push(String(d.caption || '')); break;
    }
  });
  return out.filter(Boolean).join(' ');
}

// ページごとの検索用テキスト（Body が変わらない限り使い回す）
function gdText(p) {
  if (p._textFor !== p.Body) { p._text = gdBlocksText(gdParseBody(p.Body)); p._textFor = p.Body; }
  return p._text;
}

// ---------- 起動 ----------

document.addEventListener('DOMContentLoaded', () => {
  bootPage('guide', gdInit);
});

async function gdInit() {
  registerGuideActions();
  const sideNew = document.getElementById('gd-side-new');
  if (sideNew) sideNew.hidden = !gdCanEdit();
  attachGuideSearch();
  window.addEventListener('popstate', gdOpenFromUrl);
  window.addEventListener('beforeunload', e => {
    if (gdDirty) { gdSaveNow(); e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && gdDirty) gdSaveNow(); });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (gdDirty) gdSaveNow(); }
  });
  await refreshData(true);
  gdOpenFromUrl();
}

// ヘッダーの同期表示（クリックで再読込）から呼ばれる。入力中のページは上書きしない
async function refreshData(initial) {
  try {
    const items = await api.list('guides');
    const mine = gdCurrentId ? gdById(gdCurrentId) : null;
    gdPages = sortGuides(items);
    gdRenderTree();
    if (initial) return;
    if (!gdDirty && !gdSaving && !gdConflict) {
      const fresh = gdCurrentId ? gdById(gdCurrentId) : null;
      if (!gdDraft && (!mine || !fresh || mine.UpdatedAt !== fresh.UpdatedAt)) gdRenderCurrent();
    }
  } catch (e) {
    console.error(e);
    document.getElementById('gd-content').innerHTML = '<p class="loading-text">読み込めませんでした。しばらくしてから再読込してください。</p>';
  }
}

// ---------- データ操作 ----------

function sortGuides(items) {
  const num = p => { const n = parseFloat(p.SortOrder); return isNaN(n) ? 1e9 : n; };
  return items.slice().sort((a, b) => (num(a) - num(b)) || String(a.CreatedAt).localeCompare(String(b.CreatedAt)));
}
const gdById = id => gdPages.find(p => p.ID === id) || null;
// 親が見つからない（削除済みなど）ページも、迷子にならないよう最上位に出す
const gdRoots = () => gdPages.filter(p => !p.ParentID || !gdById(p.ParentID));
const gdKids = id => gdPages.filter(p => p.ParentID === id);
function gdPath(id) {
  const out = [];
  let p = gdById(id);
  const seen = new Set();
  while (p && !seen.has(p.ID)) { seen.add(p.ID); out.unshift(p); p = p.ParentID ? gdById(p.ParentID) : null; }
  return out;
}
function gdDescendants(id) {
  const out = new Set();
  (function walk(x) { gdKids(x).forEach(k => { if (!out.has(k.ID)) { out.add(k.ID); walk(k.ID); } }); })(id);
  return out;
}
// 編集（作成・書き換え・削除）は管理者のみ。メンバーは読むだけ（サーバーでも同じ制限をかけている）
const gdCanEdit = () => api.isAdmin();
const gdTitle = p => (p && p.Title && p.Title.trim()) || '無題';
// ページの印は絵文字ではなく「色つきの丸ポチ」。Icon 列には色の名前（gray / blue …）を保存する（絵文字だった古い値はグレー扱い）
const gdColor = key => (window.GuideBlocks.COLORS.find(c => c.color === key) || window.GuideBlocks.COLORS[0]);
const gdDot = (p, cls) => `<span class="gd-dot ${cls || ''}" style="background:${gdColor(p && p.Icon).dot}" aria-hidden="true"></span>`;

// ---------- URL・画面遷移 ----------

function gdOpenFromUrl() {
  const id = new URLSearchParams(location.search).get('p') || '';
  gdShow(id && gdById(id) ? id : '', false);
}

// 離れる前に、未保存の変更があれば保存してから proceed を実行する
async function gdLeave(proceed) {
  clearTimeout(gdSaveTimer);
  if (gdConflict) {
    showDiscardConfirm(() => { gdConflict = false; gdDirty = false; proceed(); });
    return;
  }
  if (gdDirty || gdSaving) await gdSaveNow();
  if (gdDirty) { showDiscardConfirm(() => { gdDirty = false; proceed(); }); return; }   // 保存に失敗したままのとき
  proceed();
}

function gdShow(id, push) {
  gdLeave(() => {
    gdCurrentId = id || '';
    gdDraft = null;
    if (push) {
      try { history.pushState(null, '', id ? 'guide.html?p=' + encodeURIComponent(id) : 'guide.html'); } catch (_) {}
    }
    gdRenderTree();
    gdRenderCurrent();
    gdCloseSide();
    window.scrollTo(0, 0);
  });
}

function gdNewPage(parentId) {
  gdLeave(() => {
    gdCurrentId = '';
    gdDraft = { parentId: parentId || '' };
    try { history.pushState(null, '', 'guide.html'); } catch (_) {}
    gdRenderTree();
    gdRenderCurrent();
    gdCloseSide();
    window.scrollTo(0, 0);
    const t = document.getElementById('gd-title');
    if (t) t.focus();
  });
}

// ---------- 左のツリー ----------

function gdOpenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(GD_OPEN_KEY) || '[]')); } catch (_) { return new Set(); }
}
function gdSaveOpenSet(set) {
  try { localStorage.setItem(GD_OPEN_KEY, JSON.stringify(Array.from(set))); } catch (_) {}
}

function gdRenderTree() {
  const el = document.getElementById('gd-tree');
  if (!el) return;
  if (gdSearchKw) { gdRenderSearch(el); return; }
  if (!gdPages.length) { el.innerHTML = '<p class="gd-tree-empty">まだページがありません</p>'; return; }
  const open = gdOpenSet();
  // 表示中のページの祖先は開いておく
  gdPath(gdCurrentId).slice(0, -1).forEach(p => open.add(p.ID));
  const node = p => {
    const kids = gdKids(p.ID);
    const isOpen = open.has(p.ID);
    return `<div class="gd-node">
      <div class="gd-row ${p.ID === gdCurrentId ? 'active' : ''}" data-id="${escapeAttr(p.ID)}"${gdCanEdit() && !gdSearchKw ? ' draggable="true" title="ドラッグして順番を入れ替え"' : ''}>
        ${kids.length
          ? `<button type="button" class="gd-caret ${isOpen ? 'open' : ''}" data-action="gd-caret" data-id="${escapeAttr(p.ID)}" aria-label="${isOpen ? '閉じる' : '開く'}" aria-expanded="${isOpen}">▸</button>`
          : '<span class="gd-caret-space"></span>'}
        <a class="gd-link" href="guide.html?p=${encodeURIComponent(p.ID)}" data-gd-page="${escapeAttr(p.ID)}"><span class="gd-link-icon">${gdDot(p)}</span><span class="gd-link-title">${escapeHtml(gdTitle(p))}</span></a>
        ${gdCanEdit() ? `<button type="button" class="gd-row-add" data-action="gd-new-child" data-id="${escapeAttr(p.ID)}" title="この中にページを追加" aria-label="この中にページを追加">＋</button>` : ''}
      </div>
      ${kids.length && isOpen ? `<div class="gd-children">${kids.map(node).join('')}</div>` : ''}
    </div>`;
  };
  el.innerHTML = gdRoots().map(node).join('');
}

function gdRenderSearch(el) {
  const kw = gdSearchKw.toLowerCase();
  const hits = gdPages.filter(p => (p.Title + ' ' + gdText(p)).toLowerCase().indexOf(kw) >= 0);
  if (!hits.length) { el.innerHTML = '<p class="gd-tree-empty">見つかりませんでした</p>'; return; }
  el.innerHTML = hits.map(p => {
    const body = gdText(p);
    const at = body.toLowerCase().indexOf(kw);
    const snippet = at >= 0 ? body.slice(Math.max(0, at - 20), at + 50) : '';
    return `<a class="gd-hit" href="guide.html?p=${encodeURIComponent(p.ID)}" data-gd-page="${escapeAttr(p.ID)}">
      <span class="gd-hit-title">${gdDot(p)} ${escapeHtml(gdTitle(p))}</span>
      ${snippet ? `<span class="gd-hit-snippet">…${escapeHtml(snippet)}…</span>` : ''}
    </a>`;
  }).join('');
}

function attachGuideSearch() {
  const input = document.getElementById('gd-search');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { gdSearchKw = input.value.trim(); gdRenderTree(); }, 150);
  });
}

function gdCloseSide() {
  const side = document.getElementById('gd-sidebar');
  if (side) side.classList.remove('open');
  const btn = document.querySelector('.gd-side-toggle');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// ---------- Editor.js ----------

function gdUnmount() {
  gdMountSeq++;
  if (gdEditor) { try { gdEditor.destroy(); } catch (_) {} gdEditor = null; }
}

async function gdUploadForEditor(file) {
  const maxMB = getFileMaxMB();
  if (file.size > maxMB * 1024 * 1024) throw new Error(file.name + ' は ' + maxMB + 'MB を超えているため入れられません');
  const up = await api.uploadFile(file);
  return { url: up.url, name: file.name };
}

const GD_I18N = {
  messages: {
    ui: {
      blockTunes: { toggler: { 'Click to tune': 'クリックでメニュー', 'or drag to move': 'ドラッグで移動' } },
      inlineToolbar: { converter: { 'Convert to': '変換' } },
      toolbar: { toolbox: { Add: 'ブロックを追加', Filter: '検索', 'Nothing found': '見つかりません' } },
      popover: { Filter: '検索', 'Nothing found': '見つかりません', 'Convert to': '変換' },
    },
    toolNames: {
      Text: 'テキスト', Heading: '見出し', 'Heading 1': '見出し1（大）', 'Heading 2': '見出し2（中）', 'Heading 3': '見出し3（小）',
      'Unordered List': '箇条書き', 'Ordered List': '番号付きリスト', Checklist: 'チェックリスト', List: 'リスト',
      Quote: '引用', Code: 'コード', Delimiter: '区切り線', Table: '表', Image: '画像',
      Bold: '太字', Italic: '斜体', Link: 'リンク', Marker: 'マーカー', InlineCode: 'コード', Underline: '下線',
      Move: '移動', 'Move up': '上へ', 'Move down': '下へ', Delete: '削除',
    },
    tools: {
      link: { 'Add a link': 'リンクの URL を貼る' },
      stub: { 'The block can not be displayed correctly.': 'このブロックは表示できません' },
      image: {
        Caption: '説明（任意）', 'Select an Image': '画像を選ぶ', 'With border': '枠をつける', 'Stretch image': '横いっぱいに広げる',
        'With background': '背景をつける',
      },
      list: { Unordered: '箇条書き', Ordered: '番号付き', Checklist: 'チェックリスト' },
      table: {
        'Add column to left': '左に列を追加', 'Add column to right': '右に列を追加', 'Delete column': '列を削除',
        'Add row above': '上に行を追加', 'Add row below': '下に行を追加', 'Delete row': '行を削除',
        'With headings': '見出し行をつける', 'Without headings': '見出し行をなくす',
      },
      quote: { 'Align left': '左揃え', 'Align center': '中央揃え' },
    },
    blockTunes: {
      delete: { Delete: '削除', 'Click to delete': 'もう一度クリックで削除' },
      moveUp: { 'Move up': '上へ' },
      moveDown: { 'Move down': '下へ' },
    },
  }
};

function gdEditorTools() {
  const B = window.GuideBlocks;
  return {
    header: {
      class: Header, inlineToolbar: true, config: { levels: [1, 2, 3], defaultLevel: 2, placeholder: '見出し' },
      // 「/」のメニューに見出し1〜3を別々に出す（Notion と同じ）
      toolbox: [1, 2, 3].map(level => ({ title: '見出し' + level + (level === 1 ? '（大）' : level === 2 ? '（中）' : '（小）'), icon: '<b style="font-size:12px">H' + level + '</b>', data: { level } })),
    },
    list: { class: EditorjsList, inlineToolbar: true, config: { defaultStyle: 'unordered' } },
    quote: { class: Quote, inlineToolbar: true, config: { quotePlaceholder: '引用', captionPlaceholder: '出典（任意）' } },
    table: { class: Table, inlineToolbar: true, config: { rows: 2, cols: 3, withHeadings: true } },
    delimiter: Delimiter,
    code: { class: CodeTool, config: { placeholder: 'コードや、そのままコピーしたい文面' } },
    image: {
      class: ImageTool,
      config: {
        captionPlaceholder: '説明（任意）',
        buttonContent: '画像を選ぶ（貼り付けでも入ります）',
        uploader: {
          uploadByFile: async file => {
            try { const r = await gdUploadForEditor(file); return { success: 1, file: { url: r.url } }; }
            catch (e) { toast(e.message || 'アップロードできませんでした', 'error'); return { success: 0 }; }
          },
          uploadByUrl: async url => ({ success: /^https:\/\//i.test(url) ? 1 : 0, file: { url } }),
        }
      }
    },
    callout: { class: B.Callout },
    toggle: { class: B.Toggle },
    indentTune: { class: B.IndentTune },
    pageLink: { class: B.PageLink, config: { getPages: () => gdPages } },
    file: {
      class: B.FileBlock,
      config: { upload: gdUploadForEditor, onError: e => toast((e && e.message) || 'アップロードできませんでした', 'error') }
    },
    marker: Marker,
    inlineCode: InlineCode,
    underline: Underline,
  };
}

function gdMount(blocks, autofocus, readOnly) {
  gdUnmount();
  const seq = gdMountSeq;
  const holder = document.getElementById('gd-editor');
  if (!holder) return;
  let armed = false;
  const ed = new EditorJS({
    holder,
    readOnly: !!readOnly,
    data: { blocks },
    tools: gdEditorTools(),
    i18n: GD_I18N,
    placeholder: '文章を書きます。「/」を入力すると、見出し・リスト・表などを選べます',
    minHeight: readOnly ? 0 : 120,
    autofocus: !!autofocus,
    tunes: ['indentTune'],
    onChange: () => { if (armed && !gdHist.busy) { gdMarkDirty(); gdHistSchedule(); } },
  });
  gdEditor = ed;
  gdHistReset();
  holder.addEventListener('gd-fold', gdApplyFold);
  ed.isReady.then(() => {
    if (seq !== gdMountSeq) return;
    gdApplyFold();
    setTimeout(() => { armed = true; gdHistSnapshot(); }, 300);   // 初回の描画で onChange が来ても、変更扱いにしない
  }).catch(e => console.error('editor init failed', e));
}

// ---------- トグルの折りたたみ（インデントで入れ子を表す） ----------
// 閉じているトグルの下にある、トグルよりインデントが深い連続したブロックを隠す。
function gdApplyFold() {
  const holder = document.getElementById('gd-editor');
  if (!holder) return;
  let hideLevel = null;
  holder.querySelectorAll('.ce-block').forEach(b => {
    const ind = b.querySelector('.gd-indent');
    const lv = ind ? parseInt(ind.dataset.level, 10) || 0 : 0;
    if (hideLevel !== null) {
      if (lv > hideLevel) { b.classList.add('gd-folded'); return; }
      hideLevel = null;
    }
    b.classList.remove('gd-folded');
    const tg = b.querySelector('.gd-tg');
    if (tg && !tg.classList.contains('open')) hideLevel = lv;
  });
}

// Tab / Shift+Tab でブロックを入れ子にする（リスト・表・コードの中は、それぞれの Tab の動きを優先）
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || !gdEditor || !gdCanEdit() || e.isComposing) return;
  const t = e.target;
  if (!t.closest || !t.closest('#gd-editor')) return;
  if (t.closest('.cdx-list, .tc-table, .ce-code, textarea, input, select')) return;
  if (document.querySelector('#gd-editor .ce-popover--opened')) return;
  const ind = t.closest('.ce-block') && t.closest('.ce-block').querySelector('.gd-indent');
  if (!ind) return;
  e.preventDefault();
  e.stopPropagation();
  ind.dispatchEvent(new CustomEvent('gd-indent', { detail: e.shiftKey ? -1 : 1 }));
}, true);

// ---------- 元に戻す（Ctrl+Z）・やり直し（Ctrl+Shift+Z / Ctrl+Y） ----------
// Editor.js には元に戻す機能が無いため、本文の状態（ブロックの JSON）を少し待つたびに記録しておき、Ctrl+Z でその 1 つ前に戻す。
// タイトルの入力欄は、ブラウザ標準の元に戻すに任せる。
const gdHist = { stack: [], idx: -1, timer: null, busy: false, queued: 0 };
const GD_HIST_MAX = 100;

function gdHistReset() { clearTimeout(gdHist.timer); gdHist.stack = []; gdHist.idx = -1; gdHist.busy = false; gdHist.queued = 0; }

// 比較用の文字列。ブロックの id は描画のたびに変わり得るので除く
const gdHistKey = blocks => JSON.stringify((blocks || []).map(b => { const c = Object.assign({}, b); delete c.id; return c; }));

async function gdHistSnapshot() {
  if (!gdEditor) return;
  let out;
  try { out = await gdEditor.save(); } catch (_) { return; }
  const s = gdHistKey(out.blocks);
  if (gdHist.stack[gdHist.idx] === s) return;
  gdHist.stack.length = gdHist.idx + 1;       // 戻った後に編集したら、やり直しの履歴は捨てる
  gdHist.stack.push(s);
  if (gdHist.stack.length > GD_HIST_MAX) gdHist.stack.shift();
  gdHist.idx = gdHist.stack.length - 1;
}
function gdHistSchedule() { clearTimeout(gdHist.timer); gdHist.timer = setTimeout(gdHistSnapshot, 500); }

async function gdUndoRedo(dir) {
  if (!gdEditor) return;
  if (gdHist.busy) { gdHist.queued += dir; return; }       // 描画中の押下は覚えておき、終わってからまとめて 1 回で動く
  gdHist.busy = true;
  try {
    clearTimeout(gdHist.timer);
    await gdHistSnapshot();                     // 入力途中の分も履歴に入れてから動く
    const to = Math.max(0, Math.min(gdHist.stack.length - 1, gdHist.idx + dir));
    if (to === gdHist.idx) { toast(dir < 0 ? 'これ以上戻れません' : 'やり直せる操作はありません', 'info', 1500); return; }
    const from = JSON.parse(gdHist.stack[gdHist.idx]);
    const target = JSON.parse(gdHist.stack[to]);
    await gdEditor.blocks.render({ blocks: target });
    gdHist.idx = to;
    gdApplyFold();
    await new Promise(r => setTimeout(r, 350));                       // 描画直後の onChange を待つ
    try { gdHist.stack[to] = gdHistKey((await gdEditor.save()).blocks); } catch (_) {}   // 実際に描画された形で履歴を揃える
    let at = 0;                                 // 変わった最初のブロックにカーソルを置く
    while (at < target.length && at < from.length && JSON.stringify(target[at]) === JSON.stringify(from[at])) at++;
    try { gdEditor.caret.setToBlock(Math.min(at, Math.max(0, target.length - 1)), 'end'); } catch (_) {}
    gdMarkDirty();
  } finally {
    gdHist.busy = false;
    const q = gdHist.queued;
    gdHist.queued = 0;
    if (q && gdEditor) gdUndoRedo(q);
  }
}

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !gdEditor || !gdCanEdit() || e.isComposing) return;
  const t = e.target;
  // エディタの中で押したとき。描画の途中でフォーカスが外れている間（body が対象）の連打も受け付ける。タイトル欄などは標準の動作
  const inEditor = t.closest && t.closest('#gd-editor');
  const lostFocus = gdHist.busy && !(t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  if (!inEditor && !lostFocus) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); gdUndoRedo(-1); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); e.stopPropagation(); gdUndoRedo(1); }
}, true);

// ガイド内のリンクはページを読み直さずに切り替える。外部リンクは Ctrl/⌘ クリックで別タブ（普通のクリックは文字の編集）。
// http(s)・mailto 以外のリンクは開かない。
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a');
  if (!a) return;
  const page = a.getAttribute('data-gd-page');
  if (page !== null && !(e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0)) {
    e.preventDefault();
    gdShow(page && gdById(page) ? page : '', true);
    return;
  }
  if (a.closest('#gd-editor') && !a.classList.contains('gd-file')) {
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey || !gdCanEdit()) && /^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  }
});

// ---------- ページの表示（そのまま編集できる） ----------

function gdRenderCurrent() {
  const el = document.getElementById('gd-content');
  gdUnmount();
  gdConflict = false;
  const page = gdCurrentId ? gdById(gdCurrentId) : null;
  const isHome = !page && !gdDraft;
  const layout = document.querySelector('.gd-layout');
  if (layout) layout.classList.toggle('gd-is-home', isHome);
  if (isHome) { gdRenderHome(el); return; }
  gdBase = page ? page.UpdatedAt : '';

  document.title = (page ? gdTitle(page) : '新しいページ') + ' | ガイド | SciComi Site';
  const crumbs = page ? gdPath(page.ID) : gdPath(gdDraft.parentId);
  const blocks = page ? gdParseBody(page.Body) : [];
  const kids = page ? gdKids(page.ID) : [];
  const canEdit = gdCanEdit();

  el.innerHTML = `
    <div class="gd-topbar">
      <div class="gd-crumbs">
        <a href="guide.html" data-gd-page="">ガイド</a>
        ${(page ? crumbs.slice(0, -1) : crumbs).map(c => `<span>/</span><a href="guide.html?p=${encodeURIComponent(c.ID)}" data-gd-page="${escapeAttr(c.ID)}">${gdDot(c)} ${escapeHtml(gdTitle(c))}</a>`).join('')}
      </div>
      <span class="gd-status" id="gd-status" role="status" aria-live="polite"></span>
      ${canEdit ? `<div class="gd-menu-wrap">
        <button type="button" class="gd-menu-btn" data-action="gd-menu" aria-label="ページの設定" aria-haspopup="true">･･･</button>
        <div class="gd-menu" id="gd-menu" hidden></div>
      </div>` : ''}
    </div>
    <div id="gd-conflict" class="gd-conflict" hidden></div>
    <div class="gd-page-head">
      <div class="gd-icon-wrap">
        <button type="button" class="gd-page-icon" id="gd-icon" ${canEdit ? 'data-action="gd-icon-open"' : 'disabled'} data-val="${escapeAttr(page ? page.Icon : '')}" aria-label="ページの色" ${canEdit ? 'title="色を変える"' : ''}>${gdDot(page, 'gd-dot-lg')}</button>
        <div class="gd-icon-menu" id="gd-icon-menu" hidden>${window.GuideBlocks.COLORS.map(c => `<button type="button" data-action="gd-icon-pick" data-icon="${c.color}" title="${c.label}" aria-label="${c.label}"><span class="gd-dot gd-dot-lg" style="background:${c.dot}"></span></button>`).join('')}</div>
      </div>
      <div id="gd-title" class="gd-page-title" contenteditable="${canEdit ? 'true' : 'false'}" role="textbox" aria-label="ページのタイトル" data-placeholder="無題" spellcheck="false">${escapeHtml(page ? page.Title : '')}</div>
    </div>
    <div id="gd-editor" class="gd-editor-holder"></div>
    ${kids.length ? `<section class="gd-subpages"><h2>このページの中のページ</h2><div class="gd-cards">${kids.map(gdCardHtml).join('')}</div></section>` : ''}
  `;

  const title = document.getElementById('gd-title');
  if (canEdit) title.addEventListener('input', () => gdMarkDirty());
  title.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (gdEditor) gdEditor.caret.setToFirstBlock('start'); }
  });
  title.addEventListener('paste', e => {          // 書式つきの貼り付けは文字だけにする
    e.preventDefault();
    const t = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\s+/g, ' ');
    document.execCommand('insertText', false, t);
  });
  gdMount(blocks, false, !canEdit);
  gdSetStatus(canEdit ? '' : '閲覧のみ（編集は管理者）');
}

function gdCardHtml(p) {
  const text = gdText(p).slice(0, 50);
  return `<a class="gd-card" href="guide.html?p=${encodeURIComponent(p.ID)}" data-gd-page="${escapeAttr(p.ID)}">
    <div class="gd-card-title">${gdDot(p)} ${escapeHtml(gdTitle(p))}</div>
    ${text ? `<div class="gd-card-text">${escapeHtml(text)}</div>` : ''}
  </a>`;
}

function gdRenderHome(el) {
  document.title = 'ガイド | SciComi Site';
  el.innerHTML = `
    <div class="gd-home">
      <div class="gd-home-bar">
        <input id="gd-home-search" class="gd-home-search" type="search" placeholder="ガイドを検索" aria-label="ガイドを検索" autocomplete="off" value="${escapeAttr(gdSearchKw)}">
        ${gdCanEdit() ? '<button type="button" class="gd-new-btn" data-action="gd-new-root">＋ 新しいページ</button>' : ''}
      </div>
      <div id="gd-home-list" class="gd-home-list"></div>
    </div>`;
  const input = document.getElementById('gd-home-search');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { gdSearchKw = input.value.trim(); gdRenderHomeList(); }, 150);
  });
  gdRenderHomeList();
}

// ホームのページ一覧（検索中は一致したページ）
function gdRenderHomeList() {
  const box = document.getElementById('gd-home-list');
  if (!box) return;
  if (!gdPages.length) { box.innerHTML = `<div class="gd-empty"><p>まだページがありません。</p><p>${gdCanEdit() ? '「新しいページ」から、最初のガイドを書いてみましょう。' : '管理者がガイドを追加すると、ここに出ます。'}</p></div>`; return; }
  if (gdSearchKw) {
    const kw = gdSearchKw.toLowerCase();
    const hits = gdPages.filter(p => (p.Title + ' ' + gdText(p)).toLowerCase().indexOf(kw) >= 0);
    box.innerHTML = hits.length ? hits.map(p => {
      const body = gdText(p), at = body.toLowerCase().indexOf(kw);
      const snippet = at >= 0 ? body.slice(Math.max(0, at - 20), at + 60) : '';
      return `<a class="gd-list-row" href="guide.html?p=${encodeURIComponent(p.ID)}" data-gd-page="${escapeAttr(p.ID)}">${gdDot(p)}<span class="gd-list-main"><span class="gd-list-title">${escapeHtml(gdTitle(p))}</span>${snippet ? `<span class="gd-list-sub">…${escapeHtml(snippet)}…</span>` : ''}</span></a>`;
    }).join('') : '<p class="gd-tree-empty">見つかりませんでした</p>';
    return;
  }
  const row = (p, depth) => `<a class="gd-list-row" style="padding-left:${8 + depth * 22}px" href="guide.html?p=${encodeURIComponent(p.ID)}" data-gd-page="${escapeAttr(p.ID)}">${gdDot(p)}<span class="gd-list-main"><span class="gd-list-title">${escapeHtml(gdTitle(p))}</span></span></a>` + gdKids(p.ID).map(k => row(k, depth + 1)).join('');
  box.innerHTML = gdRoots().map(p => row(p, 0)).join('');
}

// ---------- 自動保存 ----------

function gdSetStatus(text, isError) {
  const el = document.getElementById('gd-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function gdMarkDirty() {
  if (gdConflict) return;
  gdDirty = true;
  gdSetStatus('編集中…');
  clearTimeout(gdSaveTimer);
  gdSaveTimer = setTimeout(gdSaveNow, GD_SAVE_DELAY_MS);
}

function gdTitleText() {
  const t = document.getElementById('gd-title');
  return t ? t.innerText.replace(/\s+/g, ' ').trim() : '';
}

async function gdSaveNow(force) {
  clearTimeout(gdSaveTimer);
  if (!gdDirty || gdConflict || !gdEditor) return;
  if (gdSaving) { gdSaveAgain = true; return; }
  const isNew = !gdCurrentId;
  const title = gdTitleText();
  let out;
  try { out = await gdEditor.save(); } catch (e) { console.error(e); return; }
  const blocks = out.blocks || [];
  const page = isNew ? null : gdById(gdCurrentId);
  const icon = document.getElementById('gd-icon').dataset.val || '';
  if (isNew && !title && !blocks.length) { gdDirty = false; gdSetStatus(''); return; }   // 何も書いていない新規ページは作らない

  gdSaving = true;
  gdDirty = false;
  gdSetStatus('保存中…');
  const item = {
    Title: title,
    Icon: icon,
    Body: blocks.length ? JSON.stringify({ blocks }) : '',
  };
  if (isNew) {
    item.ParentID = gdDraft ? gdDraft.parentId : '';
  } else {
    item.ID = page.ID;
    if (!force) item._baseUpdatedAt = gdBase;
  }
  try {
    const saved = await api.saveGuide(item);
    const at = gdPages.findIndex(p => p.ID === saved.ID);
    if (at >= 0) gdPages[at] = saved; else gdPages.push(saved);
    gdPages = sortGuides(gdPages);
    gdBase = saved.UpdatedAt;
    if (isNew) {
      gdCurrentId = saved.ID;
      gdDraft = null;
      try { history.replaceState(null, '', 'guide.html?p=' + encodeURIComponent(saved.ID)); } catch (_) {}
    }
    document.title = gdTitle(saved) + ' | ガイド | SciComi Site';
    gdRenderTree();
    gdSetStatus(gdDirty ? '編集中…' : '保存しました');
  } catch (e) {
    gdDirty = true;
    if (e && e.message === 'conflict') { gdShowConflict(); }
    else if (e && e.message === 'ADMIN_REQUIRED') {
      gdSetStatus('管理者の認証が切れています。右上の「管理者」から認証し直してください', true);
    } else {
      gdSetStatus('保存できていません（通信を確認してください）', true);
      gdSaveTimer = setTimeout(gdSaveNow, 5000);   // 通信が戻れば自動で再試行
    }
  } finally {
    gdSaving = false;
    if (gdSaveAgain) { gdSaveAgain = false; if (gdDirty) gdSaveNow(); }
  }
}

function gdShowConflict() {
  gdConflict = true;
  gdSetStatus('保存を止めています', true);
  const box = document.getElementById('gd-conflict');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div><strong>他の人が、このページを先に更新しました。</strong><br>いま書いている内容はこの画面に残っています。</div>
    <div class="gd-conflict-actions">
      <button type="button" class="btn btn-secondary" data-action="gd-reload">最新を読み込む（自分の変更は捨てる）</button>
      <button type="button" class="btn btn-danger" data-action="gd-overwrite">自分の内容で上書きする</button>
    </div>`;
}

// ---------- ページの設定メニュー・削除 ----------

function gdOpenMenu() {
  const menu = document.getElementById('gd-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  const page = gdCurrentId ? gdById(gdCurrentId) : null;
  const excluded = page ? gdDescendants(page.ID) : new Set();
  if (page) excluded.add(page.ID);
  const parentId = page ? (page.ParentID || '') : (gdDraft ? gdDraft.parentId : '');
  const options = gdPages.filter(p => !excluded.has(p.ID)).map(p => {
    const depth = gdPath(p.ID).length - 1;
    return `<option value="${escapeAttr(p.ID)}" ${p.ID === parentId ? 'selected' : ''}>${'　'.repeat(depth)}${escapeHtml(gdTitle(p))}</option>`;
  }).join('');
  const updated = page && page.UpdatedAt ? new Date(page.UpdatedAt) : null;
  menu.innerHTML = `
    ${page ? `<button type="button" class="gd-menu-item" data-action="gd-new-child" data-id="${escapeAttr(page.ID)}">＋ このページの中にページを追加</button>` : ''}
    <label class="gd-menu-field">親ページ（移動）
      <select id="gd-m-parent">${'<option value="">（なし：いちばん上）</option>'}${options}</select>
    </label>
    ${page ? (() => {
      const sibs = gdSiblings(page);
      const i = sibs.findIndex(x => x.ID === page.ID);
      return `<div class="gd-menu-order"><span>順番（同じ階層の中で）</span>
        <button type="button" class="gd-menu-item" data-action="gd-move" data-id="${escapeAttr(page.ID)}" data-dir="-1" ${i <= 0 ? 'disabled' : ''}>↑ 上へ</button>
        <button type="button" class="gd-menu-item" data-action="gd-move" data-id="${escapeAttr(page.ID)}" data-dir="1" ${i < 0 || i >= sibs.length - 1 ? 'disabled' : ''}>↓ 下へ</button>
      </div>`;
    })() : ''}
    ${page && api.isAdmin() ? `<button type="button" class="gd-menu-item gd-menu-danger" data-action="gd-delete" data-id="${escapeAttr(page.ID)}">このページを削除</button>` : ''}
    ${updated ? `<div class="gd-menu-meta">最終更新: ${updated.getFullYear()}/${updated.getMonth() + 1}/${updated.getDate()}</div>` : ''}
  `;
  menu.hidden = false;
  document.getElementById('gd-m-parent').addEventListener('change', e => {
    // 別の親へ移したページは、移し先の末尾に並べる
    const parentId = e.target.value;
    const max = gdPages.filter(q => q.ID !== gdCurrentId && (gdById(q.ParentID) ? q.ParentID : '') === parentId)
      .reduce((m, q) => Math.max(m, parseFloat(q.SortOrder) || 0), 0);
    gdSetPageMeta({ ParentID: parentId, SortOrder: String(max + 10) });
  });
}

// ---------- ページの並べ替え ----------
// 同じ階層（同じ親の下）のページどうしで順番を入れ替える。Sort 値は 10, 20, 30… で振り直す。
function gdSiblings(p) {
  const key = gdById(p.ParentID) ? p.ParentID : '';
  return gdPages.filter(q => (gdById(q.ParentID) ? q.ParentID : '') === key);
}

async function gdApplyOrder(ids) {
  await gdLeaveSilently();                       // 開いているページの入力中の分を先に保存する
  const changes = [];
  ids.forEach((id, i) => {
    const p = gdById(id), v = String((i + 1) * 10);
    if (p && p.SortOrder !== v) changes.push([p, v]);
  });
  if (!changes.length) return;
  const before = changes.map(([p]) => [p, p.SortOrder]);
  changes.forEach(([p, v]) => { p.SortOrder = v; });      // 先に画面へ反映する
  gdPages = sortGuides(gdPages);
  gdRenderTree();
  gdRenderHomeList();
  try {
    for (const [p, v] of changes) {
      const saved = await api.saveGuide({ ID: p.ID, SortOrder: v, _baseUpdatedAt: p.UpdatedAt });
      const at = gdPages.findIndex(x => x.ID === saved.ID);
      if (at >= 0) gdPages[at] = saved;
      if (saved.ID === gdCurrentId) gdBase = saved.UpdatedAt;
    }
    gdSetStatus('順番を保存しました');
  } catch (e) {
    before.forEach(([p, old]) => { p.SortOrder = old; });
    toast(e && e.message === 'conflict' ? '他の人が先に更新したため、並べ替えできませんでした。最新を読み込みます' : '並べ替えを保存できませんでした: ' + (e && e.message ? e.message : e), 'error', 4500);
    await refreshData(true);
    gdRenderTree();
    gdRenderHomeList();
  }
}

function gdMoveSibling(id, dir) {
  const p = gdById(id);
  if (!p) return;
  const ids = gdSiblings(p).map(x => x.ID);
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  gdApplyOrder(ids);
}

// ツリー上のドラッグ＆ドロップ（同じ階層の中でだけ入れ替え）
let gdDragId = '';
function gdClearDropMarks() {
  document.querySelectorAll('#gd-tree .gd-drop-before, #gd-tree .gd-drop-after, #gd-tree .gd-dragging').forEach(r => r.classList.remove('gd-drop-before', 'gd-drop-after', 'gd-dragging'));
}
function bindGuideTreeDnd() {
  const tree = document.getElementById('gd-tree');
  tree.addEventListener('dragstart', e => {
    const row = e.target.closest && e.target.closest('.gd-row');
    if (!row || !gdCanEdit()) return;
    gdDragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', gdDragId); } catch (_) {}
    row.classList.add('gd-dragging');
  });
  tree.addEventListener('dragover', e => {
    const row = e.target.closest && e.target.closest('.gd-row');
    if (!row || !gdDragId || row.dataset.id === gdDragId) return;
    const src = gdById(gdDragId), dst = gdById(row.dataset.id);
    if (!src || !dst || !gdSiblings(src).some(x => x.ID === dst.ID)) return;       // 別の階層には置けない
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    tree.querySelectorAll('.gd-drop-before, .gd-drop-after').forEach(x => x.classList.remove('gd-drop-before', 'gd-drop-after'));
    row.classList.add(before ? 'gd-drop-before' : 'gd-drop-after');
  });
  tree.addEventListener('drop', e => {
    const row = e.target.closest && e.target.closest('.gd-row');
    const src = gdById(gdDragId);
    if (!row || !src || row.dataset.id === gdDragId) { gdClearDropMarks(); return; }
    const dst = gdById(row.dataset.id);
    if (!dst || !gdSiblings(src).some(x => x.ID === dst.ID)) { gdClearDropMarks(); return; }
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const ids = gdSiblings(src).map(x => x.ID).filter(id => id !== src.ID);
    ids.splice(ids.indexOf(dst.ID) + (before ? 0 : 1), 0, src.ID);
    gdClearDropMarks();
    gdDragId = '';
    gdApplyOrder(ids);
  });
  tree.addEventListener('dragend', () => { gdDragId = ''; gdClearDropMarks(); });
}

// 親ページ・表示順の変更はすぐ保存する（本文は触らない）
async function gdSetPageMeta(patch) {
  if (!gdCurrentId) {                       // 未保存の新規ページ
    if (patch.ParentID !== undefined && gdDraft) gdDraft.parentId = patch.ParentID;
    return;
  }
  const page = gdById(gdCurrentId);
  if (!page) return;
  await gdLeaveSilently();
  try {
    const saved = await api.saveGuide(Object.assign({ ID: page.ID, _baseUpdatedAt: gdBase }, patch));
    const at = gdPages.findIndex(p => p.ID === saved.ID);
    if (at >= 0) gdPages[at] = saved;
    gdPages = sortGuides(gdPages);
    gdBase = saved.UpdatedAt;
    gdRenderTree();
    gdSetStatus('保存しました');
  } catch (e) {
    if (e && e.message === 'conflict') gdShowConflict();
    else toast('保存できませんでした: ' + (e && e.message ? e.message : e), 'error');
  }
}
async function gdLeaveSilently() { clearTimeout(gdSaveTimer); if (gdDirty || gdSaving) await gdSaveNow(); }

function gdDelete(id) {
  const page = gdById(id);
  if (!page) return;
  if (!api.isAdmin()) { showAdminAuthModal(() => location.reload()); return; }
  if (gdKids(id).length) {
    toast('中にページがあるため削除できません。先に中のページを移動または削除してください', 'error', 4500);
    return;
  }
  showConfirmDialog({
    title: '「' + gdTitle(page) + '」を削除しますか？',
    message: '削除すると元に戻せません。',
    okLabel: '削除する', danger: true,
    onOk: async () => {
      clearTimeout(gdSaveTimer);
      gdDirty = false; gdConflict = false;
      await api.delete('guides', id);
      gdPages = gdPages.filter(p => p.ID !== id);
      toast('削除しました', 'success');
      gdShow(page.ParentID && gdById(page.ParentID) ? page.ParentID : '', true);
    }
  });
}

// ---------- イベント ----------

function registerGuideActions() {
  bindGuideTreeDnd();
  registerActions({
    'gd-move': el => { document.getElementById('gd-menu').hidden = true; gdMoveSibling(el.dataset.id, parseInt(el.dataset.dir, 10)); },
    'gd-caret': el => {
      const open = gdOpenSet();
      const id = el.dataset.id;
      if (open.has(id)) open.delete(id); else open.add(id);
      gdSaveOpenSet(open);
      gdRenderTree();
    },
    'gd-toggle-side': el => {
      const side = document.getElementById('gd-sidebar');
      const open = side.classList.toggle('open');
      el.setAttribute('aria-expanded', String(open));
    },
    'gd-new-root': () => gdNewPage(''),
    'gd-new-child': el => gdNewPage(el.dataset.id),
    'gd-menu': () => gdOpenMenu(),
    'gd-delete': el => gdDelete(el.dataset.id),
    'gd-icon-open': () => { const m = document.getElementById('gd-icon-menu'); m.hidden = !m.hidden; },
    'gd-icon-pick': el => {
      const btn = document.getElementById('gd-icon');
      btn.dataset.val = el.dataset.icon || '';
      btn.innerHTML = gdDot({ Icon: el.dataset.icon }, 'gd-dot-lg');
      document.getElementById('gd-icon-menu').hidden = true;
      gdMarkDirty();
    },
    'gd-reload': async () => {
      gdConflict = false; gdDirty = false;
      await refreshData(true);
      if (gdCurrentId && !gdById(gdCurrentId)) gdCurrentId = '';
      gdRenderTree(); gdRenderCurrent();
    },
    'gd-overwrite': () => {
      showConfirmDialog({
        title: '自分の内容で上書きしますか？',
        message: '先に更新した人の変更は消えます。',
        okLabel: '上書きする', danger: true,
        onOk: async () => { gdConflict = false; gdDirty = true; document.getElementById('gd-conflict').hidden = true; await gdSaveNow(true); }
      });
    },
  });

  // メニュー・アイコン選択は、外側をクリックしたら閉じる
  document.addEventListener('click', e => {
    const menu = document.getElementById('gd-menu');
    if (menu && !menu.hidden && !e.target.closest('.gd-menu-wrap')) menu.hidden = true;
    const im = document.getElementById('gd-icon-menu');
    if (im && !im.hidden && !e.target.closest('.gd-icon-wrap')) im.hidden = true;
  });
}
