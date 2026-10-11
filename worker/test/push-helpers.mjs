// テスト用: 端末(ブラウザ)側の処理の代わり。通知の復号と、VAPID の署名の検証。

import { b64uToBytes, bytesToB64u } from '../src/webpush.js';

const enc = new TextEncoder();

async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

function jwkFor(publicBytes, d) {
  return { kty: 'EC', crv: 'P-256', x: bytesToB64u(publicBytes.slice(1, 33)), y: bytesToB64u(publicBytes.slice(33, 65)), d };
}

// 端末の鍵の組を作る(subscribe の代わり)。{ publicKey, privateKey(d), auth } はすべて base64url
export async function makeClientKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    publicKey: bytesToB64u(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d,
    auth: bytesToB64u(crypto.getRandomValues(new Uint8Array(16)))
  };
}

// aes128gcm の本文を復号して文字列を返す(RFC 8291)
export async function decryptPushBody(body, uaPublicB64u, uaPrivateD, authB64u) {
  const buf = body instanceof Uint8Array ? body : new Uint8Array(body);
  const salt = buf.slice(0, 16);
  const idLen = buf[20];
  const asPublic = buf.slice(21, 21 + idLen);
  const cipher = buf.slice(21 + idLen);
  const uaPublic = b64uToBytes(uaPublicB64u);
  const uaPriv = await crypto.subtle.importKey('jwk', jwkFor(uaPublic, uaPrivateD), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPriv, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(secret, b64uToBytes(authB64u), info, 256);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 96);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;   // 詰め物の 0 を除く
  if (plain[end] !== 2) throw new Error('bad record delimiter');
  return new TextDecoder().decode(plain.slice(0, end));
}

// JWT(ES256)を公開鍵で検証し、中身(claims)を返す。検証に失敗したら例外
export async function verifyVapidJwt(jwt, publicKeyB64u) {
  const [h, p, s] = String(jwt).split('.');
  const key = await crypto.subtle.importKey('raw', b64uToBytes(publicKeyB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64uToBytes(s), enc.encode(h + '.' + p));
  if (!ok) throw new Error('bad VAPID signature');
  const header = JSON.parse(new TextDecoder().decode(b64uToBytes(h)));
  if (header.alg !== 'ES256') throw new Error('bad alg');
  return JSON.parse(new TextDecoder().decode(b64uToBytes(p)));
}
