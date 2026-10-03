// 認証: 署名付きトークン(ステートレス)+ 共有パスワード(PBKDF2 ハッシュ)+ ログイン試行の制限
//
// トークンは「ペイロード(role|epoch|発行時刻).HMAC署名」。旧 GAS 時代と同じ形式。
// 署名鍵は Workers の Secret(TOKEN_SECRET)に固定保存する。読み込みに失敗しても鍵を作り直さない。
// パスワード変更時は role ごとの epoch(secrets テーブル)を +1 して既存トークンを即時失効させる。

import { b64urlEncode, b64urlDecode, toHex, fromHex, safeEqual, sleep } from './util.js';

const enc = new TextEncoder();

export const SESSION_TTL_MS = 180 * 86400 * 1000;        // メンバー
export const ADMIN_SESSION_TTL_MS = 180 * 86400 * 1000;  // 管理者(config.js の ADMIN_TOKEN_TTL_MS と一致させる)

// ---- HMAC ----

let _hmacKey = null;
let _hmacKeySecret = null;

async function getHmacKey(env) {
  const secret = env.TOKEN_SECRET;
  if (!secret || String(secret).length < 16) throw new Error('TOKEN_SECRET is not configured');
  if (!_hmacKey || _hmacKeySecret !== secret) {
    _hmacKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    _hmacKeySecret = secret;
  }
  return _hmacKey;
}

export async function hmacHex(env, message) {
  const key = await getHmacKey(env);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// ---- トークン ----

export async function getEpoch(env, role) {
  const row = await env.DB.prepare('SELECT Value FROM secrets WHERE Key = ?').bind('token_epoch_' + role).first();
  return (row && parseInt(row.Value, 10)) || 1;
}

export async function bumpEpoch(env, role) {
  const next = (await getEpoch(env, role)) + 1;
  await env.DB.prepare('INSERT INTO secrets (Key, Value) VALUES (?, ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value')
    .bind('token_epoch_' + role, String(next)).run();
}

export async function generateToken(env, role) {
  const payload = role + '|' + (await getEpoch(env, role)) + '|' + Date.now();
  const e = b64urlEncode(payload);
  return e + '.' + (await hmacHex(env, e));
}

export async function verifyToken(env, token, role) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  if (!safeEqual(await hmacHex(env, parts[0]), parts[1])) return false;   // 署名不一致
  let payload;
  try { payload = b64urlDecode(parts[0]); } catch (_) { return false; }
  const seg = payload.split('|');
  if (seg.length !== 3 || seg[0] !== role) return false;
  if ((parseInt(seg[1], 10) || 0) !== (await getEpoch(env, role))) return false; // 世代失効
  const issued = parseInt(seg[2], 10) || 0;
  const ttl = role === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  return Date.now() - issued <= ttl;                                            // 期限
}

export const checkAuth = (env, token) => verifyToken(env, token, 'member');
export const checkAdmin = (env, adminToken) => verifyToken(env, adminToken, 'admin');

// ---- パスワード ----

async function pbkdf2Hex(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, keyMaterial, 256);
  return toHex(bits);
}

function iterationsFromEnv(env) {
  return Math.max(1000, Math.min(100000, parseInt(env.PBKDF2_ITERATIONS, 10) || 100000));
}

// 'pbkdf2$反復回数$ソルト(hex)$ハッシュ(hex)'
export async function hashPassword(env, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iters = iterationsFromEnv(env);
  return 'pbkdf2$' + iters + '$' + toHex(salt) + '$' + (await pbkdf2Hex(password, salt, iters));
}

export async function verifyPassword(env, key, input) {
  const pw = String(input || '').trim();
  if (pw === '') return false;
  const row = await env.DB.prepare('SELECT Value FROM secrets WHERE Key = ?').bind('pwhash_' + key).first();
  if (!row || !row.Value) return false;
  const p = String(row.Value).split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const iters = parseInt(p[1], 10);
  if (!(iters >= 1000 && iters <= 100000)) return false;
  return safeEqual(await pbkdf2Hex(pw, fromHex(p[2]), iters), p[3]);
}

export async function hasPassword(env, key) {
  const row = await env.DB.prepare('SELECT Value FROM secrets WHERE Key = ?').bind('pwhash_' + key).first();
  return !!(row && row.Value);
}

export async function storePassword(env, key, password) {
  const hashed = await hashPassword(env, password);
  await env.DB.prepare('INSERT INTO secrets (Key, Value) VALUES (?, ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value')
    .bind('pwhash_' + key, hashed).run();
}

// ---- ログイン試行の制限(IP 単位) ----

const FAIL_WINDOW_S = 600;   // 10 分
const FAIL_LOCK_COUNT = 30;  // この回数を超えたら、その IP は一時的に拒否

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// パスワードを検証する「前」に試行を 1 件記録する。上限に達していれば記録せず { allowed:false } を返す。
// 件数の判定と記録を 1 つの SQL 文で行うので、並列に大量のリクエストを送っても上限を超えて検証まで進めない。
// 成功したら、返した id を clearAuthAttempt に渡してその 1 件だけ消す(残った記録 = 失敗した試行)。
// 同じ IP の失敗記録をまとめて消さないのは、login が幹部と一般を同じ 'member' スコープで判定するため。
// まとめて消すと、一般パスワードでの成功を挟むだけで幹部パスワードを上限なしに試せてしまう。
export async function beginAuthAttempt(env, scope, ip) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - FAIL_WINDOW_S;
  const row = await env.DB.prepare(
    'INSERT INTO auth_fail (Scope, Ip, Ts) SELECT ?1, ?2, ?3 ' +
    'WHERE (SELECT COUNT(*) FROM auth_fail WHERE Scope = ?1 AND Ip = ?2 AND Ts > ?4) < ?5 RETURNING Id'
  ).bind(scope, ip, now, since, FAIL_LOCK_COUNT).first();
  return { allowed: !!row, id: row ? row.Id : null };
}

// 失敗した試行の後に呼ぶ。失敗を重ねるほど最大 4 秒まで応答を遅らせる(記録は beginAuthAttempt で済んでいる)
export async function delayAfterAuthFail(env, scope, ip) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_fail WHERE Scope = ? AND Ip = ? AND Ts > ?')
    .bind(scope, ip, Math.floor(Date.now() / 1000) - FAIL_WINDOW_S).first();
  await sleep(Math.min(((row && row.n) || 1) * 300, 4000));
}

// 成功した試行の記録を消す(失敗の件数に数えない)。それ以前の失敗は、窓(10 分)が過ぎるまで残す
export async function clearAuthAttempt(env, attempt) {
  if (!attempt || attempt.id == null) return;
  await env.DB.prepare('DELETE FROM auth_fail WHERE Id = ?').bind(attempt.id).run();
}

export async function purgeOldAuthFail(env) {
  await env.DB.prepare('DELETE FROM auth_fail WHERE Ts < ?').bind(Math.floor(Date.now() / 1000) - FAIL_WINDOW_S * 6).run();
}
