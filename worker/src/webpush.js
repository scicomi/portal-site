// Web Push の送信(暗号化と署名)。外部ライブラリを使わず、WebCrypto だけで書く。
//
//   暗号化: RFC 8291(Message Encryption for Web Push)+ RFC 8188 の aes128gcm
//   署名  : RFC 8292(VAPID)。ES256 の JWT を Authorization ヘッダーに付ける
//
// 鍵: VAPID_PUBLIC_KEY(wrangler.toml の [vars]。非圧縮の P-256 公開鍵 65 バイトの base64url)と
//     VAPID_PRIVATE_KEY(Secret。秘密鍵 d 32 バイトの base64url)。作り方は scripts/gen-vapid.mjs。
// このファイルは Node の結合テスト(test/webpush.test.mjs)からも直接読み込むので、Worker 固有の API は使わない。

const enc = new TextEncoder();

// ---- base64url(バイト列) ----

export function bytesToB64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uToBytes(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(t)) throw new Error('invalid base64url');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// 非圧縮の P-256 公開鍵(0x04 || x || y、65 バイト)なら true
export function isP256PublicKey(bytes) {
  return bytes instanceof Uint8Array && bytes.length === 65 && bytes[0] === 0x04;
}

// 公開鍵(65 バイト)と秘密鍵 d(32 バイト)から JWK を作る(WebCrypto は生の秘密鍵を読み込めないため)
function p256Jwk(publicBytes, dBytes) {
  const jwk = { kty: 'EC', crv: 'P-256', x: bytesToB64u(publicBytes.slice(1, 33)), y: bytesToB64u(publicBytes.slice(33, 65)), ext: true };
  if (dBytes) jwk.d = bytesToB64u(dBytes);
  return jwk;
}

// ---- 暗号化(RFC 8291 / aes128gcm) ----

const RECORD_SIZE = 4096;
// 通知の中身(JSON)の上限。aes128gcm の 1 レコード(4096)から、ヘッダー 86・タグ 16・区切り 1 を引いた値より小さくする
export const MAX_PLAINTEXT_BYTES = 3000;

async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

// plaintext(文字列)を端末の鍵で暗号化し、送信する本文(バイト列)を返す。
// opts.asPublic / opts.asPrivate(d)/ opts.salt はテスト用(RFC 8291 付録 A の値で確かめる)。通常は毎回作る
export async function encryptPayload(plaintext, uaPublicB64u, authB64u, opts = {}) {
  const uaPublic = b64uToBytes(uaPublicB64u);
  const authSecret = b64uToBytes(authB64u);
  if (!isP256PublicKey(uaPublic) || authSecret.length !== 16) throw new Error('invalid subscription keys');
  const body = enc.encode(plaintext);
  if (body.length > MAX_PLAINTEXT_BYTES) throw new Error('payload too large');

  let asPublic, asPrivateKey;
  if (opts.asPublic && opts.asPrivate) {
    asPublic = b64uToBytes(opts.asPublic);
    asPrivateKey = await crypto.subtle.importKey('jwk', p256Jwk(asPublic, b64uToBytes(opts.asPrivate)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    asPrivateKey = pair.privateKey;
  }
  const salt = opts.salt ? b64uToBytes(opts.salt) : crypto.getRandomValues(new Uint8Array(16));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 256);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 96);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 最後(唯一)のレコードの区切りは 0x02
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(body, new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

// ---- 署名(VAPID / RFC 8292) ----

let _signKey = null;
let _signKeyFor = '';

async function vapidSigningKey(env) {
  const id = env.VAPID_PUBLIC_KEY + '|' + env.VAPID_PRIVATE_KEY;
  if (!_signKey || _signKeyFor !== id) {
    const jwk = p256Jwk(b64uToBytes(env.VAPID_PUBLIC_KEY), b64uToBytes(env.VAPID_PRIVATE_KEY));
    _signKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    _signKeyFor = id;
  }
  return _signKey;
}

// 鍵の組が設定されていて、形式が正しいか
export function vapidConfigured(env) {
  try {
    return isP256PublicKey(b64uToBytes(env.VAPID_PUBLIC_KEY)) && b64uToBytes(env.VAPID_PRIVATE_KEY).length === 32;
  } catch (_) {
    return false;
  }
}

// 配信基盤(audience = 宛先のオリジン)ごとの JWT。exp は 24 時間以内にする決まり
export async function vapidJwt(env, audience, expSec) {
  const b64json = o => bytesToB64u(enc.encode(JSON.stringify(o)));
  const unsigned = b64json({ typ: 'JWT', alg: 'ES256' }) + '.'
    + b64json({ aud: audience, exp: expSec, sub: env.VAPID_SUBJECT || 'mailto:sc.tokai@gmail.com' });
  // WebCrypto の ECDSA の署名は r || s(64 バイト)で、JWT の ES256 と同じ形
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(env), enc.encode(unsigned));
  return unsigned + '.' + bytesToB64u(sig);
}

// ---- 送信 ----

// 1 件送る。sub: { Endpoint, P256dh, Auth }、jwt: 宛先のオリジン用の vapidJwt。
// 戻り値は配信基盤の HTTP ステータス(通信に失敗したら 0)。opts.topic は配信基盤側で未配達の同じ topic を置き換える(32 文字以内の base64url 文字)
export async function sendPush(env, sub, payloadText, jwt, opts = {}) {
  const body = await encryptPayload(payloadText, sub.P256dh, sub.Auth);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(opts.ttl || 86400),
    Urgency: 'normal',
    Authorization: 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC_KEY
  };
  if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
  try {
    const res = await fetch(sub.Endpoint, { method: 'POST', headers, body });
    // 本文は使わないが、読み切って接続を解放する
    try { await res.arrayBuffer(); } catch (_) {}
    return res.status;
  } catch (_) {
    return 0;
  }
}
