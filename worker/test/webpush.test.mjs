// 単体テスト: src/webpush.js の暗号化と署名。Worker を起動しなくても動く(Node の WebCrypto を使う)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, vapidJwt, vapidConfigured, b64uToBytes, bytesToB64u } from '../src/webpush.js';
import { decryptPushBody, verifyVapidJwt } from './push-helpers.mjs';

// RFC 8291 付録 A の値
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};

test('webpush: RFC 8291 付録 A と同じ暗号文になる', async () => {
  const out = await encryptPayload(RFC.plaintext, RFC.uaPublic, RFC.auth, { asPublic: RFC.asPublic, asPrivate: RFC.asPrivate, salt: RFC.salt });
  assert.equal(bytesToB64u(out), RFC.body);
});

test('webpush: 毎回の鍵で暗号化したものを、端末の鍵で復号できる', async () => {
  const text = JSON.stringify({ title: '新しいイベント', body: 'テスト / 11/3(日) 出欠を記入して下さい' });
  const out = await encryptPayload(text, RFC.uaPublic, RFC.auth);
  assert.equal(await decryptPushBody(out, RFC.uaPublic, RFC.uaPrivate, RFC.auth), text);
  // 同じ中身でも、暗号文は毎回変わる
  const again = await encryptPayload(text, RFC.uaPublic, RFC.auth);
  assert.notEqual(bytesToB64u(again), bytesToB64u(out));
});

test('webpush: 鍵の形式が不正・中身が大きすぎるときは例外', async () => {
  await assert.rejects(encryptPayload('x', 'AAAA', RFC.auth));
  await assert.rejects(encryptPayload('x', RFC.uaPublic, 'AAAA'));
  await assert.rejects(encryptPayload('x'.repeat(3001), RFC.uaPublic, RFC.auth));
});

test('webpush: VAPID の JWT は公開鍵で検証でき、aud・exp・sub が入る', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = bytesToB64u(await crypto.subtle.exportKey('raw', pair.publicKey));
  const d = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
  const env = { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: d, VAPID_SUBJECT: 'mailto:test@example.com' };
  assert.equal(vapidConfigured(env), true);
  assert.equal(vapidConfigured({ VAPID_PUBLIC_KEY: pub }), false);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = await vapidJwt(env, 'https://fcm.googleapis.com', exp);
  const claims = await verifyVapidJwt(jwt, pub);
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp, sub: 'mailto:test@example.com' });
  assert.equal(b64uToBytes(jwt.split('.')[2]).length, 64);
});
