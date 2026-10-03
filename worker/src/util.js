// 共通ユーティリティ

export const CODE_VERSION = '2026-10-03-cloudflare-2';

const enc = new TextEncoder();

// ---- 応答・CORS ----

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.indexOf(origin) >= 0;
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  if (isAllowedOrigin(origin, env)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

export function jsonResponse(obj, request, env, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders(request, env))
  });
}

// クライアントに返してよい既知のエラー(error にコード、detail に利用者向けの説明)。
// これ以外の例外は内部情報を含み得るので、index.js で 'internal_error' に置き換えて返す。
export class ApiError extends Error {
  constructor(code, detail) { super(code); this.name = 'ApiError'; this.code = code; this.detail = detail || ''; }
}

// ---- 時刻(JST) ----

const JST_OFFSET_MS = 9 * 3600 * 1000;

// 'yyyy-MM-ddTHH:mm:ss'(JST)。監査ログの形式。
export function jstIso(d = new Date()) {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19);
}

export function jstDate(d = new Date()) {
  return jstIso(d).slice(0, 10);
}

// 'YYYY-MM-DD' の JST 当日 23:59:59.999 を epoch ms で返す。不正なら null。
export function endOfDayJst(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const t = Date.parse(m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') + 'T23:59:59.999+09:00');
  return isNaN(t) ? null : t;
}

// ---- 暗号・エンコード ----

export function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function b64urlEncode(str) {
  const bytes = enc.encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// 長さに依らず全文字を比較する(一致位置による応答時間差を作らない)
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// D1 の値を API 用の文字列に揃える(null/undefined は空文字)
export function str(v) {
  return v === null || v === undefined ? '' : String(v);
}
