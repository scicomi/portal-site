// 表示テーマ（自動 / ライト / ダーク）。<head> で最初に読み込み、描画前に data-theme を付けて画面のちらつきを防ぐ。
// 「自動」は端末の設定（prefers-color-scheme）に従う。選んだ値はこの端末の localStorage に保存する。
(function () {
  var KEY = 'scicomi_theme';
  var LABELS = { auto: '自動', light: 'ライト', dark: 'ダーク' };
  function get() {
    try { var v = localStorage.getItem(KEY); return LABELS[v] ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
  }
  window.SciTheme = {
    labels: LABELS,
    get: get,
    set: function (mode) {
      try { if (mode === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) { /* 保存できなくても表示は切り替える */ }
      apply(mode);
    },
    next: function () { var m = get(); return m === 'auto' ? 'light' : m === 'light' ? 'dark' : 'auto'; }
  };
  apply(get());
})();

// ページ移動のとき、ヘッダーが一瞬消えないようにする。
// ヘッダーは app.js が JS で描くので、読み込みが終わるまでは空になる。前のページで描いた
// ヘッダーを localStorage に覚えておき、<header class="app-header"> が現れた瞬間に先に入れる
// (あとで app.js の renderHeader が本物に描き直す)。管理者かどうかでナビが変わるので、2 通りを別々に覚える。
(function () {
  var PREFIX = 'scicomi_header_cache_';
  var ADMIN_KEY = 'scicomi_admin_token';   // config.js の ADMIN_TOKEN_KEY と同じ
  function variant() {
    try { return localStorage.getItem(ADMIN_KEY) ? 'admin' : 'member'; } catch (e) { return 'member'; }
  }
  window.SciHeaderCache = {
    save: function (isAdmin, html) {
      try { localStorage.setItem(PREFIX + (isAdmin ? 'admin' : 'member'), html); } catch (e) { /* 覚えられなくても動く */ }
    }
  };
  var html = '';
  try { html = localStorage.getItem(PREFIX + variant()) || ''; } catch (e) { /* 何もしない */ }
  if (!html) return;

  function fill(header) {
    if (header.firstChild) return;
    header.innerHTML = html;
    // 今のページに合わせて「選択中」を付け直す
    var file = (location.pathname.split('/').pop() || 'index.html');
    var links = header.querySelectorAll('.app-nav a[href]');
    for (var i = 0; i < links.length; i++) links[i].classList.remove('active');
    var btns = header.querySelectorAll('.nav-group-btn');
    for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
    for (var k = 0; k < links.length; k++) {
      if (links[k].getAttribute('href').split(/[?#]/)[0] !== file) continue;
      links[k].classList.add('active');
      var group = links[k].closest('.nav-group');
      if (group) group.querySelector('.nav-group-btn').classList.add('active');
    }
    var who = header.querySelector('#account-who-name');
    if (who) who.textContent = '…';
    header.setAttribute('data-prerendered', '');
  }

  var existing = document.querySelector('.app-header');
  if (existing) { fill(existing); return; }
  var mo = new MutationObserver(function () {
    var h = document.querySelector('.app-header');
    if (!h) return;
    mo.disconnect();
    fill(h);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', function () { mo.disconnect(); });
})();
