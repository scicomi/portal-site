// プッシュ通知: 端末の登録と、送信待ち(push_outbox)の処理。暗号化と署名は webpush.js。
//
// 流れ: enqueuePush で、受け取る端末ごとに送信待ちを積む → drainPushOutbox が少しずつ送る
// (保存の直後の waitUntil と、1 分ごとの定期実行)。無料枠は 1 回の実行で CPU 10ms なので、
// 1 回に送る件数を PUSH_BATCH_SIZE(wrangler.toml)で絞る。1 件あたり約 1〜1.5ms(暗号化・署名)。
// 設計は docs/11_pwa_push_plan.md。

import { getEpoch } from './auth.js';
import { appendAuditLog, ID_PATTERN } from './data.js';
import { jstIso, sha256Hex, ApiError } from './util.js';
import { vapidConfigured, vapidJwt, sendPush, b64uToBytes, isP256PublicKey, MAX_PLAINTEXT_BYTES } from './webpush.js';

export const PUSH_TOPICS = ['events'];
const MAX_ENDPOINT_LENGTH = 1000;
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 40;           // 無料枠の外部への fetch(1 回の実行で 50 回)に余裕を持たせる
const CLAIM_SEC = 120;               // 取り出した行は、この間ほかの処理が送らない(二重送信を防ぐ)
const RETRY_DELAYS_SEC = [60, 300, 1800, 3600];   // 一時的な失敗(429・5xx・通信失敗)の再送の間隔。使い切ったら諦める
const MAX_FAIL_COUNT = 3;            // 恒久的な失敗(400・403 など)がこの回数続いた登録は消す
const OUTBOX_MAX_AGE_SEC = 86400;    // 1 日たっても送れない通知は捨てる
const SUBSCRIPTION_MAX_IDLE_DAYS = 180;   // トークンの有効期間と同じ。画面を開かない端末の登録は消す
const TEST_INTERVAL_SEC = 60;        // テスト通知は 1 端末 1 分に 1 回まで

// 受け付ける配信基盤のホスト。Worker が利用者から受け取った URL へ POST するので、任意の URL は許さない
const ENDPOINT_HOSTS = [
  /^fcm\.googleapis\.com$/,                 // Chrome・Edge(Android)など
  /^([a-z0-9-]+\.)*push\.apple\.com$/,      // Safari(iPhone・Mac)
  /^updates\.push\.services\.mozilla\.com$/,  // Firefox
  /^([a-z0-9-]+\.)*notify\.windows\.com$/   // Edge(Windows)
];

const nowSec = () => Math.floor(Date.now() / 1000);

export function pushEnabled(env) {
  return vapidConfigured(env);
}

export function isAllowedEndpoint(env, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let u;
  try { u = new URL(endpoint); } catch (_) { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:' && !u.port) return ENDPOINT_HOSTS.some(re => re.test(u.hostname));
  // ローカルの結合テストだけ(.dev.vars の PUSH_ALLOW_LOCAL_ENDPOINT=true)。本番では設定しない
  return env.PUSH_ALLOW_LOCAL_ENDPOINT === 'true' && u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
}

// 端末の目安。User-Agent の細部は保存しない
function deviceLabel(ua) {
  const s = String(ua || '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s)) return 'iPad';
  if (/Android/.test(s)) return 'Android';
  if (/Windows/.test(s)) return 'Windows';
  if (/Macintosh/.test(s)) return 'Mac';
  return 'その他';
}

// クライアントの PushSubscription.toJSON() を検査して { endpoint, p256dh, auth } にする。不正なら ApiError
function parseSubscription(env, sub) {
  const s = sub && typeof sub === 'object' ? sub : {};
  const keys = s.keys && typeof s.keys === 'object' ? s.keys : {};
  if (!isAllowedEndpoint(env, s.endpoint)) throw new ApiError('invalid_subscription', '通知の宛先が不正です');
  let ok = false;
  try {
    ok = isP256PublicKey(b64uToBytes(keys.p256dh)) && b64uToBytes(keys.auth).length === 16;
  } catch (_) { ok = false; }
  if (!ok) throw new ApiError('invalid_subscription', '通知の鍵が不正です');
  return { endpoint: s.endpoint, p256dh: String(keys.p256dh), auth: String(keys.auth) };
}

function normalizeTopics(topics) {
  const list = Array.isArray(topics) ? topics.filter(t => PUSH_TOPICS.indexOf(t) >= 0) : PUSH_TOPICS.slice();
  return JSON.stringify(Array.from(new Set(list)));
}

// ---- 登録・解除 ----

// 同じ宛先なら上書き(画面を開くたびに送り直して、Epoch と LastSeenAt を新しくする)
export async function subscribePush(env, body, userAgent) {
  const sub = parseSubscription(env, body.subscription);
  const memberId = typeof body.memberId === 'string' && ID_PATTERN.test(body.memberId) ? body.memberId : '';
  const now = jstIso();
  await env.DB.prepare(
    'INSERT INTO push_subscriptions (Endpoint, P256dh, Auth, Topics, MemberID, Epoch, Label, FailCount, CreatedAt, LastSeenAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?) '
    + 'ON CONFLICT(Endpoint) DO UPDATE SET P256dh = excluded.P256dh, Auth = excluded.Auth, Topics = excluded.Topics, MemberID = excluded.MemberID, '
    + 'Epoch = excluded.Epoch, Label = excluded.Label, LastSeenAt = excluded.LastSeenAt'
  ).bind(sub.endpoint, sub.p256dh, sub.auth, normalizeTopics(body.topics), memberId, await getEpoch(env, 'member'), deviceLabel(userAgent), now, now).run();
  return { success: true };
}

// 宛先を知っていれば解除できる(ログアウト・通知オフのとき。トークンが切れていても消せるように認証は求めない)
export async function unsubscribePush(env, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return { success: false, error: 'invalid_subscription' };
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_outbox WHERE Endpoint = ?').bind(endpoint),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE Endpoint = ?').bind(endpoint)
  ]);
  return { success: true };
}

// sw.js の pushsubscriptionchange 用。Service Worker は画面のトークンを持たないので、
// 「古い宛先が登録済みであること」を条件に、新しい宛先へ付け替える(種類・メンバー・Epoch は引き継ぐ)
export async function resubscribePush(env, oldEndpoint, newSubscription) {
  if (typeof oldEndpoint !== 'string' || !oldEndpoint || oldEndpoint.length > MAX_ENDPOINT_LENGTH) return { success: false, error: 'invalid_subscription' };
  const sub = parseSubscription(env, newSubscription);
  const old = await env.DB.prepare('SELECT Topics, MemberID, Epoch, Label, CreatedAt FROM push_subscriptions WHERE Endpoint = ?').bind(oldEndpoint).first();
  if (!old) return { success: false, error: 'not_found' };
  const now = jstIso();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_outbox WHERE Endpoint = ?').bind(oldEndpoint),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE Endpoint = ?').bind(oldEndpoint),
    env.DB.prepare(
      'INSERT INTO push_subscriptions (Endpoint, P256dh, Auth, Topics, MemberID, Epoch, Label, FailCount, CreatedAt, LastSeenAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?) '
      + 'ON CONFLICT(Endpoint) DO UPDATE SET P256dh = excluded.P256dh, Auth = excluded.Auth, LastSeenAt = excluded.LastSeenAt'
    ).bind(sub.endpoint, sub.p256dh, sub.auth, old.Topics, old.MemberID, old.Epoch, old.Label, old.CreatedAt || now, now)
  ]);
  return { success: true };
}

// 管理者向け: 台数だけ(宛先は返さない)
export async function pushStats(env) {
  const epoch = await getEpoch(env, 'member');
  const { results } = await env.DB.prepare('SELECT Label, COUNT(*) AS N FROM push_subscriptions WHERE Epoch = ? GROUP BY Label').bind(epoch).all();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS N FROM push_outbox').first();
  const byLabel = {};
  let total = 0;
  (results || []).forEach(r => { byLabel[r.Label || 'その他'] = r.N; total += r.N; });
  return { success: true, enabled: pushEnabled(env), total, byLabel, pending: (pending && pending.N) || 0 };
}

// ---- 送信待ちに積む ----

// payload: { title, body, url, tag }。collapseKey を渡すと、まだ送っていない同じ鍵の通知を置き換える。
// 積んだ件数を返す(鍵が未設定なら積まない)
export async function enqueuePush(env, topic, payload, collapseKey) {
  if (!pushEnabled(env) || PUSH_TOPICS.indexOf(topic) < 0) return 0;
  const text = JSON.stringify(payload);
  if (new TextEncoder().encode(text).length > MAX_PLAINTEXT_BYTES) throw new Error('push payload too large');
  const key = String(collapseKey || '');
  const now = nowSec();
  const stmts = [];
  if (key) stmts.push(env.DB.prepare('DELETE FROM push_outbox WHERE CollapseKey = ? AND Attempts = 0').bind(key));
  stmts.push(env.DB.prepare(
    'INSERT INTO push_outbox (Endpoint, Payload, CollapseKey, Attempts, NextAt, CreatedAt) '
    + 'SELECT Endpoint, ?, ?, 0, ?, ? FROM push_subscriptions WHERE Epoch = ? AND Topics LIKE ?'
  ).bind(text, key, now, now, await getEpoch(env, 'member'), '%"' + topic + '"%'));
  const out = await env.DB.batch(stmts);
  return (out[out.length - 1].meta && out[out.length - 1].meta.changes) || 0;
}

// ---- 送信 ----

// 宛先のオリジンごとの VAPID の JWT(12 時間有効)。同じ実行環境が続く間は使い回して、署名の回数を減らす
const _jwtCache = new Map();

async function jwtFor(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const now = nowSec();
  const hit = _jwtCache.get(aud);
  if (hit && hit.key === env.VAPID_PUBLIC_KEY && hit.exp - now > 3600) return hit.jwt;
  const exp = now + 12 * 3600;
  const jwt = await vapidJwt(env, aud, exp);
  _jwtCache.set(aud, { jwt, exp, key: env.VAPID_PUBLIC_KEY });
  return jwt;
}

// 配信基盤の応答で分類する
function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'gone';                   // 端末側で解除された
  if (status === 0 || status === 429 || status >= 500) return 'retry';   // 一時的
  return 'reject';                                                       // 400・403(鍵の不一致など)・413
}

async function sendOne(env, sub, payloadText, topic) {
  try {
    return await sendPush(env, sub, payloadText, await jwtFor(env, sub.Endpoint), { topic });
  } catch (e) {
    console.error('push send failed: ' + e);
    return -1;   // こちら側の失敗(鍵の形式など)
  }
}

async function recordSuccess(env, endpoint) {
  await env.DB.prepare('UPDATE push_subscriptions SET FailCount = 0, LastSuccessAt = ? WHERE Endpoint = ?').bind(jstIso(), endpoint).run();
}

async function removeSubscription(env, endpoint) {
  await unsubscribePush(env, endpoint);
}

async function recordReject(env, endpoint) {
  const row = await env.DB.prepare('UPDATE push_subscriptions SET FailCount = FailCount + 1 WHERE Endpoint = ? RETURNING FailCount').bind(endpoint).first();
  if (row && row.FailCount >= MAX_FAIL_COUNT) { await removeSubscription(env, endpoint); return true; }
  return false;
}

export function batchSize(env) {
  const n = parseInt(env.PUSH_BATCH_SIZE, 10);
  return n >= 1 ? Math.min(n, MAX_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
}

// 送信待ちから limit 件を取り出して送る。{ sent, failed, removed, retry } を返す
export async function drainPushOutbox(env, limit) {
  const result = { sent: 0, failed: 0, removed: 0, retry: 0 };
  if (!pushEnabled(env)) return result;
  const now = nowSec();
  // 取り出しと同時に NextAt を先へずらし、Attempts を増やす(1 文なので、同時に動いた別の処理と同じ行を取り合わない)
  const { results } = await env.DB.prepare(
    'UPDATE push_outbox SET NextAt = ?, Attempts = Attempts + 1 WHERE ID IN (SELECT ID FROM push_outbox WHERE NextAt <= ? ORDER BY ID LIMIT ?) '
    + 'RETURNING ID, Endpoint, Payload, CollapseKey, Attempts'
  ).bind(now + CLAIM_SEC, now, Math.max(1, Math.min(limit || DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE))).all();
  const rows = results || [];
  if (!rows.length) return result;

  const endpoints = Array.from(new Set(rows.map(r => r.Endpoint)));
  const subRows = (await env.DB.prepare('SELECT Endpoint, P256dh, Auth FROM push_subscriptions WHERE Endpoint IN (' + endpoints.map(() => '?').join(',') + ')')
    .bind(...endpoints).all()).results || [];
  const subs = new Map(subRows.map(s => [s.Endpoint, s]));

  await Promise.all(rows.map(async row => {
    const sub = subs.get(row.Endpoint);
    if (!sub) {   // 登録が消えた
      await env.DB.prepare('DELETE FROM push_outbox WHERE ID = ?').bind(row.ID).run();
      return;
    }
    const status = await sendOne(env, sub, row.Payload, row.CollapseKey);
    const kind = status === -1 ? 'reject' : classify(status);
    if (kind === 'ok') {
      await env.DB.prepare('DELETE FROM push_outbox WHERE ID = ?').bind(row.ID).run();
      await recordSuccess(env, row.Endpoint);
      result.sent++;
    } else if (kind === 'gone') {
      await removeSubscription(env, row.Endpoint);
      result.removed++;
    } else if (kind === 'retry' && row.Attempts <= RETRY_DELAYS_SEC.length) {
      await env.DB.prepare('UPDATE push_outbox SET NextAt = ? WHERE ID = ?').bind(nowSec() + RETRY_DELAYS_SEC[row.Attempts - 1], row.ID).run();
      result.retry++;
    } else {
      await env.DB.prepare('DELETE FROM push_outbox WHERE ID = ?').bind(row.ID).run();
      if (kind === 'reject' && await recordReject(env, row.Endpoint)) result.removed++;
      result.failed++;
    }
  }));
  await appendAuditLog(env, 'push_send',
    '送信 ' + result.sent + ' / 失敗 ' + result.failed + ' / 宛先削除 ' + result.removed + ' / 再送待ち ' + result.retry, '', 'system');
  return result;
}

// 保存の直後・定期実行から呼ぶ。失敗しても例外を外へ出さない
export async function drainPushOutboxSafe(env, limit) {
  try {
    return await drainPushOutbox(env, limit);
  } catch (e) {
    console.error('push drain failed: ' + (e && e.stack || e));
    await appendAuditLog(env, 'push_fail', String((e && e.message) || e).slice(0, 300), '', 'system');
    return null;
  }
}

// ---- テスト通知 ----

// 自分の端末(登録済みの宛先)1 件だけに、送信待ちを通さず直接送る。1 端末 1 分に 1 回まで
export async function sendTestPush(env, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return { success: false, error: 'invalid_subscription' };
  const sub = await env.DB.prepare('SELECT Endpoint, P256dh, Auth FROM push_subscriptions WHERE Endpoint = ? AND Epoch = ?')
    .bind(endpoint, await getEpoch(env, 'member')).first();
  if (!sub) return { success: false, error: 'not_found' };
  const now = nowSec();
  const key = 'push_test:' + (await sha256Hex(endpoint)).slice(0, 32);
  const claimed = await env.DB.prepare(
    'INSERT INTO kv_cache (K, V, Exp) VALUES (?, \'1\', ?) ON CONFLICT(K) DO UPDATE SET V = \'1\', Exp = excluded.Exp WHERE kv_cache.Exp <= ? RETURNING K'
  ).bind(key, now + TEST_INTERVAL_SEC, now).first();
  if (!claimed) return { success: false, error: 'rate_limited' };
  const payload = JSON.stringify({ title: 'テスト通知', body: 'この端末に通知が届きます。', url: 'index.html', tag: 'test' });
  const status = await sendOne(env, sub, payload, 'test');
  const kind = status === -1 ? 'reject' : classify(status);
  if (kind === 'ok') { await recordSuccess(env, endpoint); return { success: true }; }
  if (kind === 'gone') { await removeSubscription(env, endpoint); return { success: false, error: 'not_found' }; }
  if (kind === 'reject') await recordReject(env, endpoint);
  return { success: false, error: 'push_failed', detail: '配信サービスが受け付けませんでした(' + status + ')' };
}

// ---- 毎日の整理(maintenance.js) ----

export async function purgePush(env) {
  const epoch = await getEpoch(env, 'member');
  const idleCutoff = jstIso(new Date(Date.now() - SUBSCRIPTION_MAX_IDLE_DAYS * 86400 * 1000));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_outbox WHERE CreatedAt < ?').bind(nowSec() - OUTBOX_MAX_AGE_SEC),
    env.DB.prepare('DELETE FROM push_outbox WHERE Endpoint IN (SELECT Endpoint FROM push_subscriptions WHERE Epoch <> ? OR LastSeenAt < ?)').bind(epoch, idleCutoff),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE Epoch <> ? OR LastSeenAt < ?').bind(epoch, idleCutoff)
  ]);
}
