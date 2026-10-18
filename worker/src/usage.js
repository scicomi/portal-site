// 利用量(Workers のリクエスト数、D1 の読み書き行数)。Cloudflare の GraphQL Analytics API(アカウント全体の合計)から読む。
// 必要なもの: Secret の CF_API_TOKEN に「Account Analytics: Read」(プランの判定に使う契約情報の読み取りと同じトークンでよい)と CF_ACCOUNT_ID。
// 無料プランは「今日(UTC。日本時間の 9 時にリセット)」、Workers Paid は「今月(UTC)」の合計を、プランに含まれる量と比べる。
// 失敗しても円グラフの他の部分は出す(null を返す)。結果は ACTIVITY_CACHE_SEC だけ覚える。

import { cacheGet, cachePut } from './cache.js';

const ACTIVITY_CACHE_SEC = 60 * 60;
const ACTIVITY_RETRY_SEC = 30 * 60;

// プランごとの量。無料は 1 日あたり、Paid は 1 か月に含まれる量。Cloudflare が変えたら、ここを直す
export const ACTIVITY_LIMITS = {
  free: { period: 'day', requests: 100000, rowsRead: 5000000, rowsWritten: 100000 },
  paid: { period: 'month', requests: 10000000, rowsRead: 25000000000, rowsWritten: 50000000 }
};

const QUERY = `query($acc: String!, $since: Time!, $until: Time!, $dSince: Date!, $dUntil: Date!) {
  viewer { accounts(filter: { accountTag: $acc }) {
    workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests } }
    d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $dSince, date_leq: $dUntil }) { sum { rowsRead rowsWritten } }
  } }
}`;

const sumOf = (rows, key) => (Array.isArray(rows) ? rows : []).reduce((a, r) => a + (Number(r && r.sum && r.sum[key]) || 0), 0);

// GraphQL の結果から合計を作る(単体テスト用に分けてある)
export function summarizeActivity(account) {
  const a = account || {};
  return { requests: sumOf(a.workers, 'requests'), rowsRead: sumOf(a.d1, 'rowsRead'), rowsWritten: sumOf(a.d1, 'rowsWritten') };
}

export function activityRange(period, now = new Date()) {
  const start = period === 'month'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { since: start.toISOString(), until: now.toISOString(), dSince: start.toISOString().slice(0, 10), dUntil: now.toISOString().slice(0, 10) };
}

export async function fetchActivity(env, plan) {
  const token = String(env.CF_API_TOKEN || '').trim();
  const account = String(env.CF_ACCOUNT_ID || '').trim();
  if (!plan || !token || !/^[0-9a-f]{32}$/i.test(account)) return null;
  const limits = ACTIVITY_LIMITS[plan];
  const key = 'activity_usage:' + plan;
  const cached = await cacheGet(env, key);
  let used = null;
  if (cached) {
    if (cached === 'unknown') return null;
    try { used = JSON.parse(cached); } catch (_) { used = null; }
  }
  if (!used) {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: Object.assign({ acc: account }, activityRange(limits.period)) }),
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error('graphql ' + res.status);
      const body = await res.json();
      const acc = body && body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0];
      if (!acc) throw new Error('graphql no data: ' + JSON.stringify((body && body.errors) || []).slice(0, 300));
      used = summarizeActivity(acc);
      await cachePut(env, key, JSON.stringify(used), ACTIVITY_CACHE_SEC);
    } catch (e) {
      console.error('activity fetch failed: ' + String((e && e.message) || e));
      await cachePut(env, key, 'unknown', ACTIVITY_RETRY_SEC);
      return null;
    }
  }
  return {
    period: limits.period,
    requests: { used: used.requests, limit: limits.requests },
    rowsRead: { used: used.rowsRead, limit: limits.rowsRead },
    rowsWritten: { used: used.rowsWritten, limit: limits.rowsWritten }
  };
}
