/**
 * SciComi Portal - 一元設定ファイル（拡張性の土台）
 *
 * ◆ このファイルの役割
 *   サイト全体で使う「設定」と「定義」を1か所に集約する。
 *   新しいカテゴリの追加・色変更・項目追加は、原則ここだけ直せば全ページに反映される。
 *
 * ◆ よくある変更
 *   - GASのURLを変えた          → API_URL
 *   - イベントカテゴリを増やす    → EVENT_CATEGORIES に1行足す
 *   - 実験のタブを増やす          → EXPERIMENT_CATEGORIES に1行足す
 *   - メンバー区分を増やす        → MEMBER_CATEGORIES に1行足す
 *   - 書類期限の日数を変える      → DEADLINE_RULES
 *   - リマインダーの日数を変える  → REMINDER.days
 */

const CONFIG = {
  // ===== バックエンド =====
  API_URL: 'https://script.google.com/macros/s/AKfycbwfR0LGJmGhCzBZIj7UXhYok11Kmt0ZAmnwv1SIeWFFUUUCk0H0wMFHiZuMmEBII8FA/exec',

  // ===== キャッシュ =====
  CACHE_PREFIX: 'scicomi_cache_',
  TOKEN_KEY: 'scicomi_portal_token',
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

  // ===== Phase 4: リマインダーメール =====
  REMINDER: {
    days: [7, 3, 1],              // 期限の何日前に送信するか
    subjectPrefix: '[SciComi]'    // メール件名接頭辞
  },

  // ===== Phase 2: ファイルアップロード =====
  FILE_UPLOAD: {
    maxSizeMB: 10,
    retentionYears: 5
  },

  // ===== リソース名一覧（api.js が参照） =====
  RESOURCE_NAMES: ['events', 'members', 'experiments'],

  // ===== 管理者 =====
  ADMIN_TOKEN_KEY: 'scicomi_admin_token',
  ADMIN_TOKEN_TS_KEY: 'scicomi_admin_token_ts',
  ADMIN_TOKEN_TTL_MS: 2 * 60 * 60 * 1000, // 2時間

  // ===== Gemini API (Bot用 — APIキーはサーバー側管理) =====
  GEMINI: {
    MODEL: 'gemini-2.0-flash-lite',
    DAILY_LIMIT: 1500,
    USAGE_KEY: 'scicomi_bot_usage'
  },

  // ===== ナビゲーション =====
  NAV_ITEMS: [
    { href: 'index.html',       label: 'ホーム',   page: 'home' },
    { href: 'events.html',      label: 'イベント', page: 'events' },
    { href: 'members.html',     label: 'メンバー', page: 'members' },
    { href: 'experiments.html', label: '実験内容', page: 'experiments' },
    { href: 'bot.html',         label: 'Bot',      page: 'bot' },
    // 管理者ログイン時のみ表示（外部サービスの認証情報の一覧）
    { href: 'passwords.html',   label: 'パスワード一覧', page: 'passwords', adminOnly: true }
  ],

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

  // ===== メンバーカテゴリ =====
  // hasEmail: true のカテゴリにはメールアドレス欄が表示される
  MEMBER_CATEGORIES: {
    adviser:     { label: 'アドバイザー',     color: '#f59e0b', hasEmail: true },
    coordinator: { label: 'コーディネーター', color: '#10b981', hasEmail: true },
    member:      { label: 'メンバー',         color: '#6264a7', hasEmail: true }
  }
};

// ---- ヘルパー（定義から派生する便利関数） ----

function getEventCategory(key) {
  return CONFIG.EVENT_CATEGORIES[key] || CONFIG.EVENT_CATEGORIES.normal;
}
function getExperimentCategory(key) {
  return CONFIG.EXPERIMENT_CATEGORIES[key] || CONFIG.EXPERIMENT_CATEGORIES.other;
}
function getMemberCategory(key) {
  return CONFIG.MEMBER_CATEGORIES[key] || CONFIG.MEMBER_CATEGORIES.member;
}
