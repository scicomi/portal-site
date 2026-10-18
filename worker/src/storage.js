// ストレージの使用量(ホームの円グラフ用)。
//   D1: 書き込み結果の meta.size_after(データベースの大きさ)
//   R2: バケットの一覧の size を足し合わせる(backups/ 配下とそれ以外に分ける)
// 上限は Cloudflare のプランで変わるので、設定 storage_d1_limit_mb / storage_r2_limit_mb(MB)で決める。
// R2 の一覧は 1000 件ずつ(Class A 操作)なので、結果は kv_cache に STORAGE_CACHE_SEC 秒だけ覚える。

import { getConfigInt } from './config.js';
import { cacheGet, cachePut } from './cache.js';

const CACHE_KEY = 'storage_usage';
const STORAGE_CACHE_SEC = 600;
const MAX_LIST_PAGES = 50;   // 5 万件まで数える。超えたら truncated: true(実際はもっと多い)
const MB = 1024 * 1024;

async function d1Size(env) {
  const r = await env.DB.prepare('SELECT 1').run();
  const n = r && r.meta ? Number(r.meta.size_after) : NaN;
  return isFinite(n) ? n : null;
}

async function r2Size(env) {
  let files = 0, backups = 0, count = 0, cursor, pages = 0, truncated = false;
  do {
    const page = await env.FILES.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      count++;
      if (o.key.startsWith('backups/')) backups += o.size; else files += o.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor && ++pages >= MAX_LIST_PAGES) { truncated = true; break; }
  } while (cursor);
  return { files, backups, count, truncated };
}

export async function getStorageUsage(env) {
  const d1LimitMb = await getConfigInt(env, 'storage_d1_limit_mb', 500);
  const r2LimitMb = await getConfigInt(env, 'storage_r2_limit_mb', 10240);
  let base = null;
  const cached = await cacheGet(env, CACHE_KEY);
  if (cached) { try { base = JSON.parse(cached); } catch (_) { base = null; } }
  if (!base) {
    base = { d1Used: await d1Size(env), r2: await r2Size(env), measuredAt: new Date().toISOString() };
    await cachePut(env, CACHE_KEY, JSON.stringify(base), STORAGE_CACHE_SEC);
  }
  // 上限は保存済みの測定値と別に毎回読む(設定を変えたらすぐ反映する)
  return {
    d1: { used: base.d1Used, limit: d1LimitMb * MB },
    r2: { files: base.r2.files, backups: base.r2.backups, count: base.r2.count, truncated: base.r2.truncated, limit: r2LimitMb * MB },
    measuredAt: base.measuredAt
  };
}
