// 汎用の一時キャッシュ/カウンタ(D1 の kv_cache テーブル)。
// 毎分の制限のカウンタ、モデル一覧のキャッシュ、自動更新の 1 日の上限などに使う。期限(Exp)は UNIX 秒。

const nowSec = () => Math.floor(Date.now() / 1000);

export async function cacheGet(env, key) {
  const row = await env.DB.prepare('SELECT V FROM kv_cache WHERE K = ? AND Exp > ?').bind(key, nowSec()).first();
  return row ? row.V : null;
}

export async function cachePut(env, key, value, ttlSec) {
  await env.DB.prepare('INSERT INTO kv_cache (K, V, Exp) VALUES (?, ?, ?) ON CONFLICT(K) DO UPDATE SET V = excluded.V, Exp = excluded.Exp')
    .bind(key, value, nowSec() + ttlSec).run();
}

// 1 増やして、増やした後の値を返す(期限は最初に作ったときのまま延ばさない)
export async function cacheIncr(env, key, ttlSec) {
  const row = await env.DB.prepare(
    'INSERT INTO kv_cache (K, V, Exp) VALUES (?, \'1\', ?) ON CONFLICT(K) DO UPDATE SET V = CAST(V AS INTEGER) + 1 RETURNING V'
  ).bind(key, nowSec() + ttlSec).first();
  return row ? parseInt(row.V, 10) : 1;
}

export async function purgeExpiredCache(env) {
  await env.DB.prepare('DELETE FROM kv_cache WHERE Exp < ?').bind(nowSec()).run();
}
