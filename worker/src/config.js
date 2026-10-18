// 設定(config テーブル)と機密値(secrets テーブル)
//
// キーの定義はここに一元化する。1 キー足すだけで、取得(adminGetConfig)・書き込み許可(adminSetConfig)・
// 公開設定(getPublicConfig)が揃う。機密キーの値は API では絶対に返さない(設定済みかどうかだけ返す)。

import { bumpEpoch, verifyPassword, hasPassword, storePassword } from './auth.js';
import { vapidConfigured } from './webpush.js';

// Teams への通知が使えるか。送信先の URL(Secret の TEAMS_WEBHOOK_URL)が https のときだけ有効(空なら機能ごと無効)。
// ローカルの試験だけ、TEAMS_ALLOW_LOCAL_URL=true で http://127.0.0.1 / localhost を許す(本番には設定しない)
export function teamsConfigured(env) {
  const u = String((env && env.TEAMS_WEBHOOK_URL) || '').trim();
  if (/^https:\/\/[^\s/]+/.test(u)) return true;
  return !!env && String(env.TEAMS_ALLOW_LOCAL_URL) === 'true' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u);
}

export const GEMINI_MODEL = 'gemini-2.5-flash-lite';
export const GEMINI_DAILY_LIMIT = 1500;
// 新しく設定するときだけ検証する(既存のパスワードはそのまま使える)。
// settings.js の PASSWORD_MIN_LENGTH と scripts/set-password.mjs の MIN_LENGTH も同じ値にすること
const PASSWORD_MIN_LENGTH = 10;
// 書類期限の日数の範囲(settings.js の DEADLINE_DAYS_MIN/MAX と settings.html の min/max も同じ値にすること)
const DEADLINE_DAYS_MIN = 1;
const DEADLINE_DAYS_MAX = 90;
// 整数の設定の範囲 [最小, 最大]。trash_keep_days の画面(settings.js)は 1〜365 だが、
// 0(削除した瞬間に期限切れ)は結合テストが期限切れの処理を確かめるのに使うので API では受け付ける
// アップロードの上限(MB)の最大値。生のバイナリで送る POST /upload(files.js の uploadFileRaw)の上限。
// Cloudflare の無料プランはリクエスト本文が 100MB までなので、余裕を見た値。base64 の action 'uploadFile' は別に 20MB で抑える
export const FILE_MAX_MB_LIMIT = 95;

const INT_CONFIG_RANGES = {
  deadline_alert_danger: [0, 365],
  deadline_alert_warning: [0, 365],
  backup_keep_count: [1, 365],
  audit_keep_days: [1, 3650],
  trash_keep_days: [0, 365]
};

export const DEFAULT_CONFIG = {
  password: '',            // 機密(ハッシュのみ保存)
  admin_password: '',      // 機密(ハッシュのみ保存)
  gemini_api_key: '',      // 機密
  gemini_model: GEMINI_MODEL,
  file_max_mb: 50,
  backup_keep_count: 14,
  audit_keep_days: 365,
  trash_keep_days: 7,         // ゴミ箱に入れたものを完全に削除するまでの日数
  // --- 表示・運用カスタム(settings.js が読み書き。一部はメンバーにも公開) ---
  welcome_message: '',
  deadline_kyoka: -10,        // イベント日の10日前
  deadline_houkoku: 7,        // イベント日の7日後
  deadline_alert_danger: 3,
  deadline_alert_warning: 7,
  experiment_recruit_url: '',
  experiment_recruit_note: '',
  pr_channels: 'Twitter,Instagram,HP',
  site_links: '[]',
  push_events_enabled: 'true',   // イベント・ミーティングの追加と編集をプッシュ通知する('false' で止める)
  reflection_summary_auto: 'true'   // 振り返りの要約を自動で作り直す('false' で止める。「再生成」ボタンは使える。全体の停止は GEMINI_ENABLED)
};

// メンバー(非管理者)にも公開してよい表示系設定(getPublicConfig)。機密値は含めない。
export const PUBLIC_CONFIG_KEYS = [
  'welcome_message', 'deadline_kyoka', 'deadline_houkoku',
  'deadline_alert_danger', 'deadline_alert_warning',
  'experiment_recruit_url', 'experiment_recruit_note',
  'pr_channels', 'site_links',
  'file_max_mb'   // フロントのアップロード前チェックをサーバーの上限に合わせるため
];

export const SECRET_CONFIG_KEYS = ['password', 'admin_password', 'gemini_api_key'];
export const PASSWORD_CONFIG_KEYS = ['password', 'admin_password'];

export const isSecretKey = k => SECRET_CONFIG_KEYS.indexOf(k) >= 0;
export const isPasswordKey = k => PASSWORD_CONFIG_KEYS.indexOf(k) >= 0;

// ---- 読み書き ----

export async function loadConfigMap(env) {
  const { results } = await env.DB.prepare('SELECT Key, Value FROM config').all();
  const map = {};
  (results || []).forEach(r => { map[r.Key] = String(r.Value); });
  return map;
}

export async function getConfig(env, key) {
  const row = await env.DB.prepare('SELECT Value FROM config WHERE Key = ?').bind(key).first();
  return row ? String(row.Value) : '';
}

async function upsert(env, table, key, value) {
  await env.DB.prepare('INSERT INTO ' + table + ' (Key, Value) VALUES (?, ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value')
    .bind(key, value).run();
}

export async function getConfigInt(env, key, fallback) {
  const v = parseInt(await getConfig(env, key), 10);
  return isFinite(v) ? v : fallback;
}

// 機密値(API キーなど)。パスワードはハッシュのみで、ここでは扱わない。
export async function getSecret(env, key) {
  const row = await env.DB.prepare('SELECT Value FROM secrets WHERE Key = ?').bind('secret_' + key).first();
  return row ? String(row.Value) : '';
}

export async function hasSecret(env, key) {
  if (isPasswordKey(key)) return hasPassword(env, key);
  return !!(await getSecret(env, key));
}

export async function setConfig(env, key, value) {
  const v = String(value === null || value === undefined ? '' : value);
  if (isPasswordKey(key)) {
    const t = v.trim();
    if (t === '') await env.DB.prepare('DELETE FROM secrets WHERE Key = ?').bind('pwhash_' + key).run();
    else await storePassword(env, key, t);
    return;
  }
  if (isSecretKey(key)) {
    const t = v.trim();
    if (t === '') await env.DB.prepare('DELETE FROM secrets WHERE Key = ?').bind('secret_' + key).run();
    else await upsert(env, 'secrets', 'secret_' + key, t);
    return;
  }
  await upsert(env, 'config', key, v);
}

// ---- 公開設定・管理者設定 ----

function withDefault(map, k) {
  const v = map[k];
  return (v === '' || v === null || v === undefined) ? String(DEFAULT_CONFIG[k]) : v;
}

export async function publicConfig(env) {
  const map = await loadConfigMap(env);
  const cfg = {};
  PUBLIC_CONFIG_KEYS.forEach(k => { cfg[k] = withDefault(map, k); });
  cfg.gemini_daily_limit = String(GEMINI_DAILY_LIMIT);
  // プッシュ通知の公開鍵(秘密ではない)。鍵の組が未設定なら空で、画面は通知の案内を出さない
  cfg.push_public_key = vapidConfigured(env) ? String(env.VAPID_PUBLIC_KEY) : '';
  // Teams への通知が使えるか(送信先の URL は返さない。画面はボタンを出すかどうかだけに使う)
  cfg.teams_enabled = teamsConfigured(env) ? 'true' : 'false';
  return cfg;
}

export async function adminConfig(env) {
  const map = await loadConfigMap(env);
  const out = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (isSecretKey(k)) { out[k + '_set'] = await hasSecret(env, k); continue; }
    out[k] = withDefault(map, k);
  }
  return out;
}

// ---- バリデーション(不正値の永続化を防ぐ) ----
// 問題なければ '' を、エラーなら日本語メッセージを返す。

export function validateConfigValue(key, value) {
  const v = (value === null || value === undefined) ? '' : String(value);
  switch (key) {
    case 'deadline_kyoka':      // イベント日からの日数。許可願は「前」なので負の値で保存する(settings.js が符号を付ける)
    case 'deadline_houkoku': {
      if (!/^-?\d+$/.test(v.trim())) return '整数を指定してください';
      const days = Math.abs(parseInt(v.trim(), 10));
      return days >= DEADLINE_DAYS_MIN && days <= DEADLINE_DAYS_MAX ? '' : '日数は' + DEADLINE_DAYS_MIN + '〜' + DEADLINE_DAYS_MAX + 'で指定してください';
    }
    case 'file_max_mb': {       // 0 にすると全アップロードが拒否されるため 1 以上。上限は Cloudflare のリクエスト本文の上限に収まる値
      const n = /^\d+$/.test(v.trim()) ? parseInt(v.trim(), 10) : NaN;
      return n >= 1 && n <= FILE_MAX_MB_LIMIT ? '' : '1〜' + FILE_MAX_MB_LIMIT + 'の整数を指定してください';
    }
    case 'deadline_alert_danger':
    case 'deadline_alert_warning':
    case 'backup_keep_count':
    case 'audit_keep_days':
    case 'trash_keep_days': {
      // 上限が無いと、巨大な値で日付の計算(new Date(...).toISOString())が例外になり、削除や定期処理が全部失敗する
      const [min, max] = INT_CONFIG_RANGES[key];
      const n = /^\d+$/.test(v.trim()) ? parseInt(v.trim(), 10) : NaN;
      return n >= min && n <= max ? '' : min + '〜' + max + 'の整数を指定してください';
    }
    case 'push_events_enabled':
    case 'reflection_summary_auto':
      return ['true', 'false'].indexOf(v) >= 0 ? '' : 'true か false を指定してください';
    case 'password':
    case 'admin_password':
      return v.trim().length >= PASSWORD_MIN_LENGTH ? '' : 'パスワードは' + PASSWORD_MIN_LENGTH + '文字以上にしてください';
    default:
      return '';
  }
}

// adminSetConfig の本体。{ success, error?, detail? } を返す。
export async function adminSetConfig(env, key, value) {
  if (Object.keys(DEFAULT_CONFIG).indexOf(key) < 0) return { success: false, error: 'forbidden_key' };
  // 値は文字列だけ(オブジェクトや配列が来ると '[object Object]' などの文字列で保存されてしまう。パスワードも同じ)
  if (value !== undefined && value !== null && typeof value !== 'string') return { success: false, error: 'invalid_value', detail: '文字列で指定してください' };
  const vErr = validateConfigValue(key, value);
  if (vErr) return { success: false, error: 'invalid_value', detail: vErr };
  // 一般と幹部が同じだと、ログインした全員が管理者になるため拒否する
  if (isPasswordKey(key) && await verifyPassword(env, key === 'password' ? 'admin_password' : 'password', value)) {
    return { success: false, error: 'invalid_value', detail: '一般パスワードと幹部パスワードは別の値にしてください' };
  }
  await setConfig(env, key, value || '');
  if (key === 'password') await bumpEpoch(env, 'member');
  if (key === 'admin_password') await bumpEpoch(env, 'admin');
  return { success: true };
}
