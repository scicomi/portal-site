// ストレージの使用量(ホームの円グラフ用)。
//   D1: 書き込み結果の meta.size_after(データベースの大きさ)
//   R2: バケットの一覧の size を足し合わせる(backups/ 配下とそれ以外に分ける)
// R2 の一覧は 1000 件ずつ(Class A 操作)なので、結果は kv_cache に STORAGE_CACHE_SEC 秒だけ覚える。
//
// 上限は Cloudflare のプランで決まる。決め方(優先順):
//   1. 設定 storage_d1_limit_mb / storage_r2_limit_mb(MB)に数字があれば、それ(手動。空欄が自動)
//   2. Secret の CF_API_TOKEN と CF_ACCOUNT_ID があれば、Cloudflare の API でプランを読み、PLAN_LIMITS_MB の表で決める(1 日 1 回)
//   3. 読めなければ、無料プランの上限(安全側)。画面に「自動で取得できない」と出す

import { getConfig, GEMINI_DAILY_LIMIT } from './config.js';
import { cacheGet, cachePut } from './cache.js';
import { fetchActivity } from './usage.js';
import { geminiUsageGet } from './gemini.js';
import { jstDate } from './util.js';

const CACHE_KEY = 'storage_usage';
const PLAN_CACHE_KEY = 'storage_plan';
const STORAGE_CACHE_SEC = 6 * 60 * 60;   // 使用量は急には変わらないので 6 時間
const PLAN_CACHE_SEC = 24 * 60 * 60;     // プランが変わっても、1 日以内に追従する
const PLAN_RETRY_SEC = 60 * 60;          // 取得に失敗したときは、1 時間あけて取り直す(API を叩き続けない)
const MAX_LIST_PAGES = 50;   // 5 万件まで数える。超えたら truncated: true(実際はもっと多い)
const MB = 1024 * 1024;

// プランごとの上限(MB)。Cloudflare が上限を変えたら、ここを直す。
// D1 は 1 データベースの上限(無料 500MB / Workers Paid 10GB)。R2 は含まれる量(10GB)。Paid は超えた分が従量課金で、止まりはしない
export const PLAN_LIMITS_MB = {
  free: { d1: 500, r2: 10240 },
  paid: { d1: 10240, r2: 10240 }
};

// GET /accounts/{id}/subscriptions の結果から、Workers Paid かどうかを判定する(rate_plan.id に workers と paid/standard/bundled を含む契約があるか)
export function detectPlan(subscriptions) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  const paid = list.some(s => {
    const id = String((s && s.rate_plan && s.rate_plan.id) || '').toLowerCase();
    const state = String((s && s.state) || '').toLowerCase();
    return /workers/.test(id) && /(paid|standard|bundled)/.test(id) && state !== 'cancelled' && state !== 'expired';
  });
  return paid ? 'paid' : 'free';
}

async function fetchPlan(env) {
  const token = String(env.CF_API_TOKEN || '').trim();
  const account = String(env.CF_ACCOUNT_ID || '').trim();
  if (!token || !/^[0-9a-f]{32}$/i.test(account)) return null;
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts/' + account + '/subscriptions', {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error('subscriptions ' + res.status);
  const body = await res.json();
  if (!body || body.success !== true) throw new Error('subscriptions failed');
  return detectPlan(body.result);
}

// 'free' | 'paid' | null(取得できない・未設定)。結果は覚える
export async function currentPlan(env) {
  const cached = await cacheGet(env, PLAN_CACHE_KEY);
  if (cached) return cached === 'unknown' ? null : cached;
  let plan = null;
  try {
    plan = await fetchPlan(env);
  } catch (e) {
    console.error('plan detection failed: ' + String((e && e.message) || e));
  }
  await cachePut(env, PLAN_CACHE_KEY, plan || 'unknown', plan ? PLAN_CACHE_SEC : PLAN_RETRY_SEC);
  return plan;
}

async function manualLimitMb(env, key) {
  const n = parseInt(await getConfig(env, key), 10);
  return n >= 1 ? n : null;
}

async function resolveLimits(env) {
  const d1Manual = await manualLimitMb(env, 'storage_d1_limit_mb');
  const r2Manual = await manualLimitMb(env, 'storage_r2_limit_mb');
  let plan = null;
  if (d1Manual === null || r2Manual === null) plan = await currentPlan(env);
  const table = PLAN_LIMITS_MB[plan || 'free'];
  const source = (d1Manual !== null && r2Manual !== null) ? 'manual' : plan ? 'auto' : 'fallback';
  return { d1Mb: d1Manual ?? table.d1, r2Mb: r2Manual ?? table.r2, plan, source };
}

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

// Gemini の今日(日本時間)の呼び出し回数。アプリ側の 1 日の上限(GEMINI_DAILY_LIMIT)に対する数。取れなければ null
async function geminiToday(env) {
  try {
    return { used: await geminiUsageGet(env, jstDate()), limit: GEMINI_DAILY_LIMIT, enabled: env.GEMINI_ENABLED === 'true' };
  } catch (e) {
    console.error('gemini usage read failed: ' + String((e && e.message) || e));
    return null;
  }
}

export async function getStorageUsage(env) {
  let base = null;
  const cached = await cacheGet(env, CACHE_KEY);
  if (cached) { try { base = JSON.parse(cached); } catch (_) { base = null; } }
  if (!base) {
    base = { d1Used: await d1Size(env), r2: await r2Size(env), measuredAt: new Date().toISOString() };
    await cachePut(env, CACHE_KEY, JSON.stringify(base), STORAGE_CACHE_SEC);
  }
  // 上限は測定の覚えとは別に毎回決める(設定を変えたらすぐ反映する。プランは 1 日覚える)
  const lim = await resolveLimits(env);
  return {
    activity: await fetchActivity(env, lim.plan),   // null = 取得できない(トークン未登録など)
    gemini: await geminiToday(env),   // null = 取得できない
    d1: { used: base.d1Used, limit: lim.d1Mb * MB },
    r2: { files: base.r2.files, backups: base.r2.backups, count: base.r2.count, truncated: base.r2.truncated, limit: lim.r2Mb * MB },
    limitSource: lim.source,   // 'manual'(設定の数字) | 'auto'(プランから) | 'fallback'(取得できず無料プランの上限)
    plan: lim.plan,            // 'free' | 'paid' | null
    measuredAt: base.measuredAt
  };
}
