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
