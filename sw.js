// Service Worker(PWA)。プッシュ通知の表示と、通知を押したときの移動だけを行う。
//
// fetch の処理(画面のキャッシュ・オフライン対応)は置かない。git push した新しい画面が、今までどおりすぐ反映されるようにするため。
// データのキャッシュは api.js の localStorage が受け持つ。設計は docs/11_pwa_push_plan.md。
//
// 通知の中身(Worker の push.js が送る JSON): { title, body, url, tag }
//   url はこのサイト内の相対パス(events.html?event=ID など)。外部の URL は開かない。

importScripts('config.js');   // CONFIG.API_URL(宛先の付け替えで使う)

// 接続先 API。localhost で開いたページは、pwa.js が sw.js?api=... でローカルの Worker を渡す(api.js の ?api= と同じ条件)
const API_URL = (() => {
  const q = new URL(self.location.href).searchParams.get('api') || '';
  const isLocalPage = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
  return isLocalPage && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(q) ? q : CONFIG.API_URL;
})();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// このサイト(Service Worker の範囲)の中の URL だけを返す。それ以外はホーム
function safeUrl(path) {
  const scope = self.registration.scope;
  try {
    const u = new URL(String(path || ''), scope);
    if (u.origin === self.location.origin && u.href.startsWith(scope)) return u.href;
  } catch (_) {}
  return new URL('index.html', scope).href;
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = String(data.title || 'SciComi Site').slice(0, 100);
  const options = {
    body: String(data.body || '').slice(0, 300),
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    lang: 'ja',
    data: { url: safeUrl(data.url) }
  };
  // 同じ tag(同じイベント)の通知は上書きし、もう一度知らせる
  if (data.tag) { options.tag = String(data.tag).slice(0, 64); options.renotify = true; }
  // iPhone は、届いた push ごとに必ず通知を出す決まり(出さないと購読が取り消される)ので、中身が壊れていても出す
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 同じページが開いていれば前に出す。サイトのほかのページが開いていれば、そこで移動する
    const same = wins.find(w => w.url === target);
    if (same) return same.focus();
    const any = wins.find(w => w.url.startsWith(self.registration.scope));
    if (any) {
      await any.focus();
      try { return await any.navigate(target); } catch (_) { /* 移動できないブラウザは新しく開く */ }
    }
    return self.clients.openWindow(target);
  })());
});

// 配信基盤の都合で宛先が変わったとき、新しい宛先へ付け替える(画面のトークンを持たないので、古い宛先を証明に使う)
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
    if (!oldEndpoint) return;   // 古い宛先が分からなければ、次に画面を開いたときに pwa.js が登録し直す
    let sub = event.newSubscription;
    if (!sub) {
      const key = event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (!key) return;
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'pushResubscribe', oldEndpoint, subscription: sub.toJSON() })
    });
  })());
});
