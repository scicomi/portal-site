/**
 * PWA とプッシュ通知の共通処理（app.js の後に読み込む）。設計は docs/11_pwa_push_plan.md。
 *
 * - Service Worker（sw.js）の登録（ページを開いたら、ログインの有無に関係なく）
 * - 通知のオン・オフ（ボタンの操作の中で許可を求める。iPhone はホーム画面に追加したアプリの中だけ）
 * - 登録の送り直し（1 日 1 回、ログインし直したとき、名前を変えたとき。サーバーの鍵が変わったら登録し直す）
 * - ホームの「スマホに通知を受け取る」カード（renderPushInviteCard）。メンバーへの発表までは出さない（index.html に
 *   <div id="push-invite-card" class="exp-recruit-card hidden"></div> を置き、home.js の init から呼ぶと出る）
 * - 通知の設定のモーダル（showPushSettingsModal。アカウントメニューから開く）
 */

const PUSH_SYNC_KEY = 'scicomi_push_synced';                 // 最後にサーバーへ登録を送った内容（端末・名前・ログイン・日付）
const PUSH_INVITE_DISMISSED_KEY = 'scicomi_push_invite_dismissed';
const PUSH_INVITE_HIDE_MS = 30 * 24 * 60 * 60 * 1000;         // ホームのカードの「今はしない」で隠す期間

// ---- Service Worker ----

// localhost で ?api= を使っているときは、宛先の付け替え（sw.js の pushsubscriptionchange）もローカルの Worker に向ける
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

// iPhone・iPad（iPadOS は Mac と名乗るので、タッチの有無で見分ける）
function isIOSDevice() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function pushApiSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// サーバーの公開鍵（getPublicConfig の push_public_key。applySiteSettings が端末に保存している）。空なら通知は未設定
function pushPublicKey() {
  const cfg = (typeof _readCachedSiteSettings === 'function' && _readCachedSiteSettings()) || {};
  return String(cfg.push_public_key || '');
}

function b64uToUint8(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function sameKey(buf, b64u) {
  if (!buf || !b64u) return false;
  const a = new Uint8Array(buf), b = b64uToUint8(b64u);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function currentPushSubscription() {
  if (!pushApiSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// この端末の通知の状態:
//   'unavailable'   サーバーに鍵が無い（管理者が未設定）
//   'unsupported'   ブラウザが対応していない
//   'needs-install' iPhone で、ホーム画面に追加したアプリから開いていない
//   'denied'        端末の設定で通知がブロックされている
//   'on' / 'off'
async function pushState() {
  if (!pushPublicKey()) return 'unavailable';
  if (isIOSDevice() && !isStandaloneApp()) return 'needs-install';
  if (!pushApiSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const sub = await currentPushSubscription().catch(() => null);
  return sub ? 'on' : 'off';
}

// ---- オン・オフ ----

function pushSyncId(sub) {
  const token = (typeof api !== 'undefined' && api.getToken()) || '';
  return [sub.endpoint, getSavedVoteMemberId(), token.slice(-16), todayISO()].join('|');
}

async function sendSubscription(sub) {
  await api.pushSubscribe(sub.toJSON(), getSavedVoteMemberId());
  try { localStorage.setItem(PUSH_SYNC_KEY, pushSyncId(sub)); } catch (_) {}
}

// 通知をオンにする。ボタンの click の中から呼ぶ（iPhone は、操作の中でしか許可の確認を出せない）。
// 成功で true。失敗は例外（code: 'denied' / 'unsupported' / API のエラー）
async function enablePush() {
  const key = pushPublicKey();
  if (!key) throw Object.assign(new Error('feature_disabled'), { code: 'feature_disabled' });
  if (!pushApiSupported()) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  // 許可の確認は、ほかの await より先に出す（間に待ちが入ると、Safari は「操作の中」と見なさない）
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error('denied'), { code: 'denied' });
  const reg = (await registerServiceWorker()) && await navigator.serviceWorker.ready;
  if (!reg) throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToUint8(key) });
  try {
    await sendSubscription(sub);
  } catch (e) {
    // サーバーに登録できなければ、端末側も戻す（「オン」に見えて届かない状態を作らない）
    try { await sub.unsubscribe(); } catch (_) {}
    throw e;
  }
  return true;
}

async function disablePush() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try { localStorage.removeItem(PUSH_SYNC_KEY); } catch (_) {}
  await api.pushUnsubscribe(endpoint);
}

// ログアウトのとき（app.js の handleLogout）。待ち時間に上限を設け、失敗してもログアウトは続ける
function disablePushOnLogout() {
  const work = disablePush().catch(e => console.warn('[pwa] 通知の解除に失敗しました:', e));
  return Promise.race([work, new Promise(r => setTimeout(r, 2000))]);
}

// 画面を開いたときに、登録をサーバーへ送り直す（1 日 1 回・ログインし直した・名前を変えた）。
// サーバーの鍵が変わっていたら、許可は残っているので、確認なしで登録し直す
async function syncPushSubscription() {
  try {
    if (typeof api === 'undefined' || !api.getToken() || !pushApiSupported() || Notification.permission !== 'granted') return;
    const key = pushPublicKey();
    let sub = await currentPushSubscription();
    if (!sub || !key) return;
    if (!sameKey(sub.options && sub.options.applicationServerKey, key)) {
      const old = sub.endpoint;
      await sub.unsubscribe();
      api.pushUnsubscribe(old).catch(() => {});
      const reg = await navigator.serviceWorker.ready;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToUint8(key) });
    } else {
      let last = '';
      try { last = localStorage.getItem(PUSH_SYNC_KEY) || ''; } catch (_) {}
      if (last === pushSyncId(sub)) return;
    }
    await sendSubscription(sub);
  } catch (e) {
    if (!e || !e.handled) console.warn('[pwa] 通知の登録を送り直せませんでした:', e);
  }
}

// ---- 画面の文言 ----

const PUSH_INSTALL_STEPS_HTML = `
  <ol class="push-steps">
    <li>Safari の下（または上）にある <strong>共有ボタン</strong>（四角から矢印が出たアイコン）を押す</li>
    <li><strong>「ホーム画面に追加」</strong>を選び、「追加」を押す</li>
    <li>ホーム画面にできた <strong>SciComi</strong> のアイコンから開き直し、ここで通知をオンにする</li>
  </ol>`;

function pushErrorMessage(e) {
  const code = e && e.code;
  if (code === 'denied') return '通知が許可されませんでした。端末の設定で、このサイト（またはアプリ）の通知を許可してください。';
  if (code === 'unsupported') return 'この端末・ブラウザは通知に対応していません。';
  return humanizeApiError(e);
}

// ---- ホームのカード ----

async function renderPushInviteCard() {
  const card = document.getElementById('push-invite-card');
  if (!card) return;
  let dismissedAt = 0;
  try { dismissedAt = parseInt(localStorage.getItem(PUSH_INVITE_DISMISSED_KEY) || '0', 10) || 0; } catch (_) {}
  const state = await pushState();
  const show = (state === 'off' || state === 'needs-install') && Date.now() - dismissedAt > PUSH_INVITE_HIDE_MS;
  card.classList.toggle('hidden', !show);
  if (!show) return;
  card.innerHTML = `
    <div class="exp-recruit-header"><h3>スマホに通知を受け取る</h3></div>
    <p class="exp-recruit-note">イベントやミーティングの追加・変更を、この端末に通知します。</p>
    ${state === 'needs-install' ? `<p class="exp-recruit-note">iPhone・iPad は、ホーム画面に追加すると通知を受け取れます。</p>${PUSH_INSTALL_STEPS_HTML}` : ''}
    <div class="push-card-actions">
      ${state === 'off' ? '<button type="button" class="btn btn-sm btn-primary-solid" data-push="on">通知をオンにする</button>' : ''}
      <button type="button" class="btn btn-sm btn-secondary" data-push="later">今はしない</button>
    </div>`;
  card.querySelector('[data-push="later"]').addEventListener('click', () => {
    try { localStorage.setItem(PUSH_INVITE_DISMISSED_KEY, String(Date.now())); } catch (_) {}
    card.classList.add('hidden');
    toast('アカウントメニューの「通知」から、いつでもオンにできます');
  });
  const on = card.querySelector('[data-push="on"]');
  if (on) on.addEventListener('click', async () => {
    on.disabled = true;
    try {
      await enablePush();
      card.classList.add('hidden');
      toast('通知をオンにしました', 'success');
    } catch (e) {
      on.disabled = false;
      if (!e.handled) toast(pushErrorMessage(e), 'error', 6000);
    }
  });
}

// ---- アカウントメニュー・設定のモーダル ----

const PUSH_MENU_LABELS = { on: '通知: オン', off: '通知: オフ', denied: '通知: ブロック中', 'needs-install': '通知: オフ' };

// アカウントメニューを開いたときに、項目の表示を今の状態にする（通知が使えない端末・未設定なら隠す）
async function refreshPushMenuItem() {
  const item = document.getElementById('account-push-btn');
  if (!item) return;
  const state = await pushState();
  item.classList.toggle('hidden', state === 'unavailable' || state === 'unsupported');
  item.textContent = PUSH_MENU_LABELS[state] || '通知';
}

async function showPushSettingsModal() {
  const existing = document.getElementById('push-settings-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'push-settings-modal';
  modal.innerHTML = `
    <div class="pw-overlay">
      <div class="pw-box push-box" role="dialog" aria-modal="true" aria-labelledby="push-settings-title">
        <h2 id="push-settings-title">通知の設定</h2>
        <div id="push-settings-body"><p>読み込み中...</p></div>
        <div id="push-settings-error" class="pw-error" role="alert"></div>
        <div class="push-modal-actions" id="push-settings-actions"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  bindModalEscape(modal, close);
  modal.querySelector('.pw-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) close(); });
  const body = modal.querySelector('#push-settings-body');
  const actions = modal.querySelector('#push-settings-actions');
  const errEl = modal.querySelector('#push-settings-error');

  const render = async () => {
    const state = await pushState();
    errEl.textContent = '';
    const text = {
      on: '<p>この端末に、イベントやミーティングの追加・変更の通知が届きます。</p>',
      off: '<p>オンにすると、イベントやミーティングの追加・変更を、この端末に通知します。</p>',
      'needs-install': '<p>iPhone・iPad は、ホーム画面に追加したアプリの中でだけ通知を受け取れます（iOS 16.4 以上）。</p>' + PUSH_INSTALL_STEPS_HTML,
      denied: '<p>この端末では、通知がブロックされています。端末の設定（iPhone は「設定」→「通知」→「SciComi」、Android は「設定」→「アプリ」→ ブラウザ →「通知」）で許可してから、もう一度開いてください。</p>',
      unsupported: '<p>この端末・ブラウザは通知に対応していません。Android は Chrome、iPhone は Safari でホーム画面に追加して使ってください。</p>',
      unavailable: '<p>通知の機能は、まだ準備中です。</p>'
    }[state];
    body.innerHTML = text + (state === 'on' || state === 'off' ? '<p class="text-hint">通知はこの端末だけの設定です。ほかの端末でも受け取るには、その端末でもオンにしてください。</p>' : '');
    actions.innerHTML = '<button type="button" class="btn btn-secondary" data-push="close">閉じる</button>'
      + (state === 'on' ? '<button type="button" class="btn btn-secondary" data-push="test">テスト通知を送る</button><button type="button" class="btn btn-secondary" data-push="off">通知をオフにする</button>' : '')
      + (state === 'off' ? '<button type="button" class="btn btn-primary-solid" data-push="on">通知をオンにする</button>' : '');
    trapFocus(modal.querySelector('.pw-box'));
    refreshPushMenuItem();
  };

  actions.addEventListener('click', async e => {
    const btn = e.target.closest('[data-push]');
    if (!btn) return;
    const act = btn.dataset.push;
    if (act === 'close') { close(); return; }
    btn.disabled = true;
    errEl.textContent = '';
    try {
      if (act === 'on') { await enablePush(); toast('通知をオンにしました', 'success'); }
      if (act === 'off') { await disablePush(); toast('通知をオフにしました', 'success'); }
      if (act === 'test') {
        const sub = await currentPushSubscription();
        if (!sub) throw Object.assign(new Error('not_found'), { code: 'not_found' });
        await api.pushTest(sub.endpoint);
        toast('テスト通知を送りました。数秒で届きます', 'success');
      }
      await render();
    } catch (err) {
      btn.disabled = false;
      if (err && err.handled) return;
      errEl.textContent = err && err.code === 'not_found'
        ? 'この端末の登録が見つかりません。通知をオフにしてから、もう一度オンにしてください。'
        : pushErrorMessage(err);
    }
  });
  await render();
}

window.addEventListener('load', () => {
  registerServiceWorker();
  // ログイン・公開設定の読み込み（bootPage）が先に済むよう、少し待ってから送り直す
  setTimeout(syncPushSubscription, 3000);
});
