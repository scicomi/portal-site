// ファイル(R2)。アップロードは要ログイン、閲覧はログイン不要(推測されにくいランダムなキーの公開 URL)。
//
// クライアントとの互換のため、返すフィールド名は Drive 時代のまま(driveId = R2 のオブジェクトキー)。

import { getConfigInt, FILE_MAX_MB_LIMIT } from './config.js';
import { corsHeaders, ApiError } from './util.js';

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
  let bytes;
  try { bytes = decodeBase64(String(fileData.base64)); } catch (_) { throw new ApiError('invalid_file', 'ファイルデータが不正です'); }
  const maxMB = Math.min(await getConfigInt(env, 'file_max_mb', 10), FILE_MAX_MB_LIMIT);   // 上限より大きい値が保存されていても抑える
  if (bytes.length / (1024 * 1024) > maxMB) throw new ApiError('file_too_large', 'ファイルサイズが上限(' + maxMB + 'MB)を超えています');

  const key = crypto.randomUUID().replace(/-/g, '') + safeExt(fileData.name);
  // 種類は「type/subtype」の形だけ受け付ける(改行などを含む値は、配信のときにヘッダーに入れられず 500 になる)
  const rawType = String(fileData.mimeType || '').trim().toLowerCase();
  const mimeType = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(rawType) ? rawType : 'application/octet-stream';
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { name: encodeURIComponent(String(fileData.name)).slice(0, 500) }
  });
  const origin = new URL(request.url).origin;
  return { name: fileData.name, url: origin + '/files/' + key, driveId: key, size: bytes.length, uploadedAt: new Date().toISOString() };
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
