/**
 * SciComi Site - 一元設定ファイル（拡張性の土台）
 *
 * ◆ このファイルの役割
 *   サイト全体で使う「設定」と「定義」を1か所に集約する。
 *   新しいカテゴリの追加・色変更・項目追加は、原則ここだけ直せば全ページに反映される。
 *
 * ◆ よくある変更
 *   - APIのURLを変えた          → API_URL(Cloudflare Workers。worker/ を参照)
 *   - イベントカテゴリを増やす    → EVENT_CATEGORIES に1行足す
 *   - 実験のタブを増やす          → EXPERIMENT_CATEGORIES に1行足す
 *   - メンバーの役職を増やす      → MEMBER_ROLES に1行足す
 *   - 書類期限の日数を変える      → DEADLINE_RULES
 */

const CONFIG = {
  // ===== バックエンド =====
  API_URL: 'https://scicomi-portal.scicomi.workers.dev',   // Cloudflare Workers

  // ===== キャッシュ =====
  CACHE_PREFIX: 'scicomi_cache_',
  // キャッシュの中身の形式の版。形式を変えたら上げる（古い版のキャッシュは読み込み時に捨て、サーバーから取り直す）。
  // 2: イベントをサーバー形（DB の列名）だけで保存するようにした（旧 UI形 Date_End / Event_Time 等を廃止）
  CACHE_SCHEMA: 2,
  TOKEN_KEY: 'scicomi_portal_token',
  // ===== localStorage のキー(複数ファイルから使うもの。ログアウト時の掃除から漏れないよう、ここで一元管理) =====
  SITE_SETTINGS_KEY: 'scicomi_site_settings',
  WELCOME_MESSAGE_KEY: 'scicomi_welcome_message',
  SEARCH_HISTORY_PREFIX: 'scicomi_search_history_',
  HOLIDAYS_CACHE_KEY: 'scicomi_holidays_cache',
  HOLIDAYS_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30日

  // ===== 書類期限の自動計算ルール =====
  DEADLINE_RULES: {
    kyoka: -10,   // 許可願: イベント日の10日前
    houkoku: +7   // 報告書: イベント日の7日後
  },

  // 期限が「近い」と判定する日数（色分け用）
  DEADLINE_ALERT: {
    danger: 3,   // 3日前以内 → 赤
    warning: 7   // 7日前以内 → 黄
  },

  // ===== 書類（許可願・報告書）の提出ステータス =====
  // home / event-series で共用（以前は両ページに重複定義があり、片方だけ直すとズレていた）。
  // cssClass は style.css の .report-status-select.status-* に対応する色分けクラス。
  KYOKA_STATUS: {
    '':            { label: '未提出',                 cssClass: 'none' },
    'coordinator': { label: 'コーディネーター提出済', cssClass: 'coordinator' },
    'submitted':   { label: '提出済',                 cssClass: 'clc' }
  },
  REPORT_STATUS: {
    '':            { label: '未提出',                 cssClass: 'none' },
    'coordinator': { label: 'コーディネーター提出済', cssClass: 'coordinator' },
    'clc':         { label: 'CLC提出済',              cssClass: 'clc' }
  },

  // ===== Phase 2: ファイルアップロード =====
  FILE_UPLOAD: {
    maxSizeMB: 10
  },

  // ===== リソース名一覧（api.js が参照） =====
  RESOURCE_NAMES: ['events', 'members', 'experiments'],

  // ===== 管理者 =====
  ADMIN_TOKEN_KEY: 'scicomi_admin_token',
  ADMIN_TOKEN_TS_KEY: 'scicomi_admin_token_ts',
  ADMIN_TOKEN_TTL_MS: 180 * 24 * 60 * 60 * 1000, // 180日（サーバー側 worker/src/auth.js の ADMIN_SESSION_TTL_MS と一致させること）

  // ===== 機能フラグ =====
  // BOT: AI検索(Gemini)。無料枠は入力が学習に使われるため停止中。再開手順は docs/09_aibot_suspended.md。
  //      サーバー側の GEMINI_ENABLED(worker/wrangler.toml)も同時に切り替えること。
  //      こちらは画面を隠すだけで、実際の遮断はサーバー側が行う。
  FEATURES: {
    BOT: false
  },

  // ===== Gemini API (Bot用 — APIキー・モデルはサーバー側 Config で管理) =====
  // ※ 使用モデルはサーバーの設定（gemini_model。設定ページで変更）が正で、フロントでは持たない。
  GEMINI: {
    DAILY_LIMIT: 1500,  // API初回呼出前の表示用フォールバック。実際の上限はサーバー(GEMINI_DAILY_LIMIT)が正で、bot.js 起動時に上書きされる。
    USAGE_KEY: 'scicomi_bot_usage'
  },

  // ===== 広報媒体（サーバー設定 pr_channels から上書きされる） =====
  PR_CHANNELS: ['Twitter', 'Instagram', 'HP'],

  // ===== パスワード一覧カテゴリ =====
  PASSWORD_CATEGORIES: {
    sns:      { label: 'SNS・メールアドレス', color: '#e74c8b' },
    purchase: { label: '購買・印刷',         color: '#10b981' },
    server:   { label: 'サーバー・開発',     color: '#f59e0b' },
    other:    { label: 'その他',             color: '#8b8b8b' }
  },

  // ===== ログイン方法 =====
  // normal 以外はパスワード不要（外部アカウントで認証）
  // 新しいサービスを追加する場合はここに1行足すだけでよい
  LOGIN_TYPES: {
    normal:  { label: 'ID / パスワード',      social: false },
    google:  { label: 'Googleでログイン',     social: true,  color: '#db4437' },
    twitter: { label: 'X（Twitter）でログイン', social: true, color: '#000000' },
    apple:   { label: 'Appleでログイン',      social: true,  color: '#555555' },
    line:    { label: 'LINEでログイン',       social: true,  color: '#00b900' },
    other:   { label: 'その他（SSO等）',      social: true,  color: '#8b5cf6' }
  },

  // ===== ナビゲーション =====
  NAV_ITEMS: [
    { href: 'index.html',        label: 'ホーム',       page: 'home' },
    { href: 'events.html',       label: '予定',         page: 'events' },
    { href: 'event-series.html', label: 'イベント別',   page: 'series' },
    { href: 'members.html',      label: 'メンバー',     page: 'members' },
    { href: 'experiments.html', label: '実験ネタ',   page: 'experiments' },
    { href: 'bot.html',         label: 'AI検索',     page: 'bot', feature: 'BOT' },
    // group を持つ項目は、NAV_GROUPS の見出しのドロップダウンにまとまる（位置は最初の項目の場所）
    { href: 'guide.html',       label: 'ガイド',     page: 'guide', group: 'more' },
    { href: 'trash.html',       label: 'ゴミ箱',     page: 'trash', group: 'more' },
    // 管理者ログイン時のみ表示（セパレーター付き）
    { href: 'passwords.html',   label: 'パスワード', page: 'passwords', adminOnly: true, group: 'admin' },
    { href: 'settings.html',    label: '設定',       page: 'settings',  adminOnly: true, group: 'admin' }
  ],

  // ナビのドロップダウン見出し。adminFirst は手前に区切り線を入れる
  NAV_GROUPS: {
    more:  { label: 'その他' },
    admin: { label: '管理', adminFirst: true }
  },

  // ===== イベントカテゴリ =====
  EVENT_CATEGORIES: {
    normal:  { label: 'イベント',         short: 'イベント', bg: '#f8b4b4', text: '#7c2d2d', isMeeting: false },
    other:   { label: 'その他',           short: 'その他',   bg: '#86efac', text: '#14532d', isMeeting: false },
    general: { label: '全体ミーティング', short: '全体MTG', bg: '#93c5fd', text: '#1e3a5f', isMeeting: true },
    admin:   { label: '幹部ミーティング', short: '幹部MTG', bg: '#fde68a', text: '#78350f', isMeeting: true }
  },

  // ===== 実験カテゴリ（タブ） =====
  EXPERIMENT_CATEGORIES: {
    workshop: { label: '工作',       color: '#10b981' },
    show:     { label: '実験ショー', color: '#f59e0b' },
    other:    { label: 'その他',     color: '#8b5cf6' }
  },

  // ===== メンバー役職（統合表示） =====
  MEMBER_ROLES: [
    { value: 'アドバイザー',       color: '#f59e0b', category: 'adviser',     order: 0 },
    { value: 'コーディネーター',   color: '#10b981', category: 'coordinator', order: 1 },
    { value: 'プロジェクトリーダー', color: '#8b5cf6', category: 'member',    order: 2 },
  ]
};

// ---- ヘルパー（定義から派生する便利関数） ----

function getEventCategory(key) {
  return CONFIG.EVENT_CATEGORIES[key] || CONFIG.EVENT_CATEGORIES.normal;
}
// 全体会・幹部会などミーティング扱いのカテゴリか（書類期限・実験・担当の入力が要らない）
function isMeetingCategory(key) {
  const c = CONFIG.EVENT_CATEGORIES[key];
  return !!(c && c.isMeeting);
}
function getExperimentCategory(key) {
  return CONFIG.EXPERIMENT_CATEGORIES[key] || CONFIG.EXPERIMENT_CATEGORIES.other;
}
function getRoleDisplay(role) {
  if (!role) return null;
  const r = CONFIG.MEMBER_ROLES.find(x => x.value === role);
  if (r) return r;
  return { value: role, color: '#6b7280', category: 'member', order: 10 };
}
// 書類ステータスの select 色分けクラス（未知の値は「未提出」扱い）
function docStatusClass(def, value) {
  return (def[value] || def['']).cssClass || 'none';
}
