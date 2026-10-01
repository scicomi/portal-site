// 定期実行(Cron Trigger: 毎日 03:00 JST)
//   1) D1 の全データを JSON にして R2 の backups/ に保存し、古い世代を削除
//   2) 監査ログ・ログイン失敗記録・一時キャッシュの整理
//
// バックアップに含めないもの: secrets(パスワードのハッシュ・API キー)、auth_fail、kv_cache。
// R2 の backups/ 配下は /files/ からは配信されない(キーに '/' を含むため)。

import { getConfigInt } from './config.js';
import { trimAuditLog } from './data.js';
import { purgeOldAuthFail } from './auth.js';
import { purgeExpiredCache } from './gemini.js';
import { jstDate } from './util.js';

const BACKUP_TABLES = ['events', 'members', 'experiments', 'guides', 'passwords', 'event_votes', 'config', 'audit_log', 'gemini_usage'];
const BACKUP_PREFIX = 'backups/';

export async function backupToR2(env) {
  const snapshot = { createdAt: new Date().toISOString(), tables: {} };
  const out = await env.DB.batch(BACKUP_TABLES.map(t => env.DB.prepare('SELECT * FROM ' + t)));
  BACKUP_TABLES.forEach((t, i) => { snapshot.tables[t] = out[i].results || []; });
  const key = BACKUP_PREFIX + jstDate() + '.json';
  await env.FILES.put(key, JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } });

  // 古い世代を削除(新しい順に backup_keep_count 件だけ残す)
  const keep = Math.max(1, await getConfigInt(env, 'backup_keep_count', 14));
  const listed = await env.FILES.list({ prefix: BACKUP_PREFIX });
  const keys = listed.objects.map(o => o.key).sort().reverse();
  const stale = keys.slice(keep);
  if (stale.length) await env.FILES.delete(stale);
  return { key, kept: Math.min(keys.length, keep), deleted: stale.length };
}

export async function runMaintenance(env) {
  const steps = [
    ['backup', () => backupToR2(env)],
    ['trimAuditLog', async () => trimAuditLog(env, await getConfigInt(env, 'audit_keep_days', 365))],
    ['purgeAuthFail', () => purgeOldAuthFail(env)],
    ['purgeCache', () => purgeExpiredCache(env)]
  ];
  // 個々の処理が失敗しても他に影響しないよう個別に try/catch する
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { console.error('maintenance ' + name + ' failed: ' + e); }
  }
}
