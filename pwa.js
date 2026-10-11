/**
 * PWA の共通処理（app.js の後に読み込む）。
 *
 * フェーズ 2: Service Worker（sw.js）の登録だけ。通知のオン・オフ・登録はフェーズ 3 で足す。
 * 設計は docs/11_pwa_push_plan.md。
 */

// Service Worker の登録。ログインの有無に関係なく、ページを開いたら登録する（ホーム画面への追加・通知の受信に必要）。
// localhost で ?api= を使っているときは、宛先の付け替え（sw.js の pushsubscriptionchange）もローカルの Worker に向ける。
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  const local = typeof API_URL !== 'undefined' && typeof CONFIG !== 'undefined' && API_URL !== CONFIG.API_URL;
  const url = 'sw.js' + (local ? '?api=' + encodeURIComponent(API_URL) : '');
  return navigator.serviceWorker.register(url).catch(e => {
    // 登録できなくても画面は使える。原因調査用に残す
    console.warn('[pwa] Service Worker を登録できませんでした:', e);
    return null;
  });
}

// ホーム画面に追加したアイコンから開いているか（iPhone は、このときだけ通知を受け取れる）
function isStandaloneApp() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}

window.addEventListener('load', () => { registerServiceWorker(); });
