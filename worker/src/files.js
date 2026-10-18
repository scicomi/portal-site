// ファイル(R2)。アップロードは要ログイン、閲覧はログイン不要(推測されにくいランダムなキーの公開 URL)。
//
// アップロードは 2 通り。画面は POST /upload(uploadFileRaw。生のバイナリを R2 に流す。上限 FILE_MAX_MB_LIMIT)を使う。
// action 'uploadFile'(uploadFile。base64 を JSON で送る)は、古い画面のために残している(上限 LEGACY_UPLOAD_MAX_MB)。
//
// クライアントとの互換のため、返すフィールド名は Drive 時代のまま(driveId = R2 のオブジェクトキー)。

import { getConfigInt, FILE_MAX_MB_LIMIT, DEFAULT_CONFIG } from './config.js';
import { corsHeaders, ApiError } from './util.js';

// base64 のアップロードの上限(MB)。base64 で約 1.34 倍になっても、index.js の MAX_REQUEST_BYTES(28MB)に収まる値
const LEGACY_UPLOAD_MAX_MB = 20;

// 設定 file_max_mb(上限より大きい値が保存されていても抑える)
async function fileMaxMB(env, cap) {
  return Math.min(await getConfigInt(env, 'file_max_mb', DEFAULT_CONFIG.file_max_mb), cap);
}

// 種類は「type/subtype」の形だけ受け付ける(改行などを含む値は、配信のときにヘッダーに入れられず 500 になる)
function safeMimeType(v) {
  const rawType = String(v || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(rawType) ? rawType : 'application/octet-stream';
}

function newFileKey(name) {
  return crypto.randomUUID().replace(/-/g, '') + safeExt(name);
}

function storedFile(request, name, key, size) {
  const origin = new URL(request.url).origin;
  return { name, url: origin + '/files/' + key, driveId: key, size, uploadedAt: new Date().toISOString() };
}

function putOptions(name, mimeType) {
  return {
    httpMetadata: { contentType: safeMimeType(mimeType) },
    customMetadata: { name: encodeURIComponent(String(name)).slice(0, 500) }
  };
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ファイル名から、キーに使える安全な拡張子だけを取り出す
function safeExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

export async function uploadFile(env, request, fileData) {
  if (!fileData || !fileData.base64 || !fileData.name) throw new ApiError('invalid_file', 'ファイルデータが不正です');
  const maxMB = await fileMaxMB(env, LEGACY_UPLOAD_MAX_MB);
  const tooLarge = () => new ApiError('file_too_large', 'ファイルサイズが上限(' + maxMB + 'MB)を超えています');
  // デコードの前に、base64 の長さ(元の大きさの約 4/3)で見積もって断る(大きなファイルを丸ごと展開してから断らないため)
  const b64 = String(fileData.base64);
  if (Math.floor(b64.length * 3 / 4) - 2 > maxMB * 1024 * 1024) throw tooLarge();
  let bytes;
  try { bytes = decodeBase64(b64); } catch (_) { throw new ApiError('invalid_file', 'ファイルデータが不正です'); }
  if (bytes.length / (1024 * 1024) > maxMB) throw tooLarge();

  const key = newFileKey(fileData.name);
  await env.FILES.put(key, bytes, putOptions(fileData.name, fileData.mimeType));
  return storedFile(request, fileData.name, key, bytes.length);
}

// POST /upload。本文がファイルそのもの。名前は X-File-Name(encodeURIComponent 済み)、種類は Content-Type。
// 認証(Authorization: Bearer <トークン>)は index.js が確かめてから呼ぶ。
// 本文はメモリに展開せず、長さを固定したストリームのまま R2 に渡す(宣言と実際の長さが違えば put が失敗する)
export async function uploadFileRaw(env, request) {
  let name = '';
  try { name = decodeURIComponent(request.headers.get('X-File-Name') || '').trim(); } catch (_) { name = ''; }
  if (!name) throw new ApiError('invalid_file', 'ファイル名がありません');
  name = name.slice(0, 300);
  const lenHeader = request.headers.get('Content-Length');
  if (!lenHeader || !/^\d+$/.test(lenHeader)) throw new ApiError('length_required', 'ファイルの大きさが分かりません');
  const length = parseInt(lenHeader, 10);
  if (length <= 0 || !request.body) throw new ApiError('invalid_file', 'ファイルが空です');
  const maxMB = await fileMaxMB(env, FILE_MAX_MB_LIMIT);
  if (length > maxMB * 1024 * 1024) throw new ApiError('file_too_large', 'ファイルサイズが上限(' + maxMB + 'MB)を超えています');

  const key = newFileKey(name);
  const { readable, writable } = new FixedLengthStream(length);
  const piping = request.body.pipeTo(writable);
  try {
    await env.FILES.put(key, readable, putOptions(name, request.headers.get('Content-Type')));
    await piping;
  } catch (e) {
    piping.catch(() => {});
    console.error('upload stream failed: ' + (e && e.stack || e));
    throw new ApiError('upload_failed', 'ファイルを受け取れませんでした。もう一度お試しください');
  }
  return storedFile(request, name, key, length);
}

export async function deleteFile(env, key) {
  if (!key || !/^[A-Za-z0-9._-]+$/.test(key)) return false;
  await env.FILES.delete(key);
  return true;
}

// GET /files/<key>
export async function serveFile(env, request) {
  const cors = corsHeaders(request, env);
  let key;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.slice('/files/'.length));
  } catch (_) {
    return new Response('Bad Request', { status: 400, headers: cors });   // 不正な % エスケープ
  }
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return new Response('Not Found', { status: 404, headers: cors });
  const obj = await env.FILES.get(key);
  if (!obj) return new Response('Not Found', { status: 404, headers: cors });

  const name = (obj.customMetadata && obj.customMetadata.name) ? obj.customMetadata.name : encodeURIComponent(key);
  // 画像・PDF・動画・音声・テキストだけをブラウザ内表示にする。HTML/SVG など、スクリプトを含み得る形式は
  // 必ずダウンロード扱いにして、アップロードされたファイルがこのオリジン上で実行されないようにする。
  const type = ((obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream').toLowerCase();
  // 種類の名前は最後まで一致させる(image/pngx などを inline にしない)。以前に保存された不正な値(改行など)は octet-stream で返す
  const inlineSafe = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|text\/plain)(;[\x20-\x7e]*)?$/.test(type);
  const headers = new Headers(cors);
  headers.set('Content-Type', inlineSafe ? type : 'application/octet-stream');
  headers.set('Content-Length', String(obj.size));
  headers.set('Content-Disposition', (inlineSafe ? 'inline' : 'attachment') + "; filename*=UTF-8''" + name);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');   // キーは内容ごとに一意なので長期キャッシュ可
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('ETag', obj.httpEtag);
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}
