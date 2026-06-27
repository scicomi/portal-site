/**
 * SciComi Portal - GAS Backend API Client (v3)
 *
 * スキーマ駆動: CONFIG.RESOURCE_NAMES に登録されたリソース名を自動認識。
 * Optimistic UI: save はローカルキャッシュを即更新し、GAS呼び出しは裏で実行。
 *
 * 使い方:
 *   await api.auth(password)              → 認証
 *   await api.list('events')              → イベント一覧
 *   await api.listAll()                   → 全リソース一括取得
 *   await api.save('events', eventObj)    → 保存（楽観的UI対応）
 *   await api.delete('events', id)        → 削除
 */

const API_URL = (typeof CONFIG !== 'undefined' && CONFIG.API_URL) || '';
const TOKEN_KEY = (typeof CONFIG !== 'undefined' && CONFIG.TOKEN_KEY) || 'scicomi_portal_token';
const CACHE_KEY_PREFIX = (typeof CONFIG !== 'undefined' && CONFIG.CACHE_PREFIX) || 'scicomi_cache_';
const HOLIDAYS_CACHE_KEY = (typeof CONFIG !== 'undefined' && CONFIG.HOLIDAYS_CACHE_KEY) || 'scicomi_holidays_cache';
const HOLIDAYS_CACHE_TTL_MS = (typeof CONFIG !== 'undefined' && CONFIG.HOLIDAYS_TTL_MS) || (30 * 24 * 60 * 60 * 1000);

const RESOURCE_NAMES = (typeof CONFIG !== 'undefined' && CONFIG.RESOURCE_NAMES)
  || ['events', 'members', 'experiments'];

const ADMIN_TOKEN_KEY = (typeof CONFIG !== 'undefined' && CONFIG.ADMIN_TOKEN_KEY) || 'scicomi_admin_token';
const ADMIN_TOKEN_TS_KEY = (typeof CONFIG !== 'undefined' && CONFIG.ADMIN_TOKEN_TS_KEY) || 'scicomi_admin_token_ts';
const ADMIN_TOKEN_TTL = (typeof CONFIG !== 'undefined' && CONFIG.ADMIN_TOKEN_TTL_MS) || (2 * 60 * 60 * 1000);

const api = {

  // ---- メンバー認証 ----
  getToken() { return localStorage.getItem(TOKEN_KEY) || ''; },
  setToken(t) { localStorage.setItem(TOKEN_KEY, t); },
  clearToken() { localStorage.removeItem(TOKEN_KEY); },

  async auth(password) {
    const res = await this._post({ action: 'auth', password });
    if (res.success && res.token) {
      this.setToken(res.token);
      return true;
    }
    return false;
  },

  // 統合ログイン: 入力パスワードからロールを判別。
  // 幹部パスワードなら管理者トークンも受け取り、自動で管理者モードになる。
  // 戻り値: { ok: boolean, role: 'admin' | 'member' | null }
  async login(password) {
    const res = await this._post({ action: 'login', password });
    if (res.success && res.token) {
      this.setToken(res.token);
      if (res.adminToken) this.setAdminToken(res.adminToken);
      return { ok: true, role: res.role || 'member' };
    }
    // 旧バックエンド（login 未対応）では従来の auth にフォールバックして、
    // GAS 再デプロイ前でもメンバーログインが止まらないようにする。
    if (res.error && String(res.error).indexOf('unknown action') >= 0) {
      const ok = await this.auth(password);
      return { ok, role: ok ? 'member' : null };
    }
    return { ok: false, role: null };
  },

  // ---- 管理者認証 ----
  getAdminToken() {
    const ts = parseInt(localStorage.getItem(ADMIN_TOKEN_TS_KEY)) || 0;
    if (Date.now() - ts > ADMIN_TOKEN_TTL) {
      this.clearAdminToken();
      return '';
    }
    return localStorage.getItem(ADMIN_TOKEN_KEY) || '';
  },
  setAdminToken(t) {
    localStorage.setItem(ADMIN_TOKEN_KEY, t);
    localStorage.setItem(ADMIN_TOKEN_TS_KEY, String(Date.now()));
  },
  clearAdminToken() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_TOKEN_TS_KEY);
  },
  isAdmin() { return !!this.getAdminToken(); },

  async adminAuth(adminPassword) {
    const res = await this._post({ action: 'adminAuth', admin_password: adminPassword, token: this.getToken() });
    if (res.success && res.adminToken) {
      this.setAdminToken(res.adminToken);
      return true;
    }
    return false;
  },

  adminLogout() { this.clearAdminToken(); },

  async adminGetConfig() {
    const res = await this._post({ action: 'adminGetConfig', token: this.getToken(), adminToken: this.getAdminToken() });
    if (!res.success) throw new Error(res.error || 'failed');
    return res.config;
  },

  // 公開設定（表示系のみ）。管理者でなくても取得できる＝全メンバーへ反映するために使う。
  async getPublicConfig() {
    const res = await this._post({ action: 'getPublicConfig', token: this.getToken() });
    if (!res.success) throw new Error(res.error || 'failed');
    return res.config;
  },

  async adminSetConfig(key, value) {
    const res = await this._post({ action: 'adminSetConfig', token: this.getToken(), adminToken: this.getAdminToken(), key, value });
    // invalid_value のときはサーバーの日本語 detail を優先して見せる
    if (!res.success) throw new Error(res.detail || res.error || 'failed');
    return true;
  },

  // ---- キャッシュ ----
  loadCache(resource) {
    try {
      const raw = localStorage.getItem(CACHE_KEY_PREFIX + resource);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  },

  saveCache(resource, items) {
    try {
      localStorage.setItem(CACHE_KEY_PREFIX + resource, JSON.stringify({
        items,
        timestamp: Date.now()
      }));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        this._evictOldestCache();
        try {
          localStorage.setItem(CACHE_KEY_PREFIX + resource, JSON.stringify({
            items, timestamp: Date.now()
          }));
        } catch (_) {}
      }
    }
  },

  _evictOldestCache() {
    let oldest = null;
    let oldestTs = Infinity;
    RESOURCE_NAMES.forEach(r => {
      const cached = this.loadCache(r);
      if (cached && cached.timestamp < oldestTs) {
        oldestTs = cached.timestamp;
        oldest = r;
      }
    });
    if (oldest) localStorage.removeItem(CACHE_KEY_PREFIX + oldest);
  },

  clearAllCache() {
    RESOURCE_NAMES.forEach(r => {
      localStorage.removeItem(CACHE_KEY_PREFIX + r);
    });
  },

  async loadHolidaysCached() {
    try {
      const raw = localStorage.getItem(HOLIDAYS_CACHE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (Date.now() - obj.timestamp < HOLIDAYS_CACHE_TTL_MS) return obj.data;
      }
    } catch (_) {}
    try {
      const res = await fetch('https://holidays-jp.github.io/api/v1/date.json');
      const data = await res.json();
      localStorage.setItem(HOLIDAYS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      return data;
    } catch (_) { return {}; }
  },

  // ---- CRUD ----
  async list(resource) {
    const res = await this._post({ action: 'list', resource, token: this.getToken() });
    if (!res.success) throw new Error(res.error || 'list failed');
    return res.items || [];
  },

  async listAll() {
    const res = await this._post({ action: 'listAll', token: this.getToken() });
    if (!res.success) throw new Error(res.error || 'listAll failed');
    const result = {};
    RESOURCE_NAMES.forEach(r => { result[r] = res[r] || []; });
    return result;
  },

  async save(resource, item) {
    const res = await this._post({
      action: 'save', resource,
      token: this.getToken(), item
    });
    if (!res.success) {
      console.error('save failed:', res);
      throw new Error(res.error || 'save failed');
    }
    if (!res.item) {
      console.warn('GAS did not return item; falling back to local item.');
      return { ...item };
    }
    return res.item;
  },

  async uploadFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = reader.result.split(',')[1];
          const res = await this._post({
            action: 'uploadFile',
            token: this.getToken(),
            file: { name: file.name, mimeType: file.type || 'application/octet-stream', base64 }
          });
          if (!res.success) throw new Error(res.error || 'upload failed');
          resolve(res.file);
        } catch (e) { reject(e); }
      };
      reader.onerror = () => reject(new Error('ファイル読み込みエラー'));
      reader.readAsDataURL(file);
    });
  },

  async deleteFile(driveId) {
    const res = await this._post({
      action: 'deleteFile',
      token: this.getToken(),
      adminToken: this.getAdminToken(),
      driveId
    });
    if (!res.success) {
      if (res.error === 'admin_required') throw new Error('ADMIN_REQUIRED');
      throw new Error(res.error || 'delete file failed');
    }
    return true;
  },

  async delete(resource, id) {
    const res = await this._post({
      action: 'delete', resource,
      token: this.getToken(),
      adminToken: this.getAdminToken(),
      id
    });
    if (!res.success) {
      if (res.error === 'admin_required') throw new Error('ADMIN_REQUIRED');
      console.error('delete failed:', res);
      throw new Error(res.error || 'delete failed');
    }
    return true;
  },

  // ---- パスワード一覧（管理者専用リソース） ----
  // 閲覧・追加・編集・削除すべてに管理者トークンを添付する。
  async listPasswords() {
    const res = await this._post({
      action: 'list', resource: 'passwords',
      token: this.getToken(), adminToken: this.getAdminToken()
    });
    if (!res.success) {
      if (res.error === 'admin_required') throw new Error('ADMIN_REQUIRED');
      throw new Error(res.error || 'list passwords failed');
    }
    return res.items || [];
  },

  async savePassword(item) {
    const res = await this._post({
      action: 'save', resource: 'passwords',
      token: this.getToken(), adminToken: this.getAdminToken(), item
    });
    if (!res.success) {
      if (res.error === 'admin_required') throw new Error('ADMIN_REQUIRED');
      if (res.error === 'conflict') throw new Error('conflict');
      throw new Error(res.error || 'save password failed');
    }
    return res.item || { ...item };
  },

  async deletePassword(id) {
    // delete アクションは既に管理者トークンを送る
    return this.delete('passwords', id);
  },

  // ---- Gemini プロキシ ----
  // systemPrompt はサーバー側で固定生成されるため送信しない（APIキー悪用防止）
  async geminiProxy(message) {
    const res = await this._post({
      action: 'geminiProxy',
      token: this.getToken(),
      message
    });
    if (!res.success) {
      // retrySec / detail / scope を例外に載せてクライアント側で活用できるようにする
      const err = new Error(res.error || 'gemini proxy failed');
      err.retrySec = res.retrySec;
      err.detail = res.detail;
      err.scope = res.scope;
      throw err;
    }
    return res;
  },

  // 文章生成（要約など）。instruction=依頼文 / context=要約対象の本文（個人情報を除いた実験・イベント内容）。
  async geminiGenerate(instruction, context) {
    const res = await this._post({
      action: 'geminiGenerate',
      token: this.getToken(),
      instruction,
      context
    });
    if (!res.success) {
      const err = new Error(res.error || 'gemini generate failed');
      err.retrySec = res.retrySec;
      err.detail = res.detail;
      err.scope = res.scope;
      throw err;
    }
    return res; // { success, text, usage, limit }
  },

  async _post(payload) {
    let res, text;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });
      text = await res.text();
    } catch (e) {
      const err = new Error('NETWORK_UNREACHABLE');
      err.code = 'NETWORK_UNREACHABLE';
      throw err;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success && parsed.error === 'unauthorized') {
        this.clearToken();
        this.clearAllCache();
        if (typeof showPasswordModal === 'function') {
          showPasswordModal(() => location.reload());
        } else {
          location.reload();
        }
        const err = new Error('unauthorized');
        err.code = 'unauthorized';
        err.handled = true;
        throw err;
      }
      return parsed;
    } catch (e) {
      if (e.code === 'unauthorized') throw e;
      const looksHtml = /^\s*<(!doctype|html)/i.test(text || '');
      const looksLogin = /accounts\.google\.com|ServiceLogin|ウェブ ワープロ|docs\.google\.com/i.test(text || '')
        || (res && res.url && /accounts\.google\.com|ServiceLogin/i.test(res.url));
      if (looksHtml || looksLogin) {
        const err = new Error('GAS_NOT_PUBLIC');
        err.code = 'GAS_NOT_PUBLIC';
        throw err;
      }
      const err = new Error('BAD_RESPONSE');
      err.code = 'BAD_RESPONSE';
      err.detail = (text || '').slice(0, 120);
      throw err;
    }
  }
};

// ---- API エラーを人間向けの日本語に変換（UI 表示用） ----
function humanizeApiError(e) {
  const code = (e && (e.code || e.message)) || '';
  switch (code) {
    case 'GAS_NOT_PUBLIC':
      return 'サーバー(GAS)がログイン画面を返しました。多くの場合 API_URL の問題です。'
        + '①config.js の API_URL が「/exec」で終わっているか（「/dev」はログイン必須のため不可）'
        + '②「デプロイを管理→アクセスできるユーザー＝全員」か'
        + '③ブラウザの強制再読込（Ctrl+Shift+R）で古い設定が残っていないか、を確認してください。';
    case 'NETWORK_UNREACHABLE':
      return 'ネットワークに接続できません。通信環境を確認してください。';
    case 'unauthorized':
      return 'セッションの有効期限が切れました。再ログインしてください。';
    case 'BAD_RESPONSE':
      return 'サーバーからの応答を解釈できませんでした。' + (e.detail ? '（' + e.detail + '…）' : '');
    default:
      return (e && e.message) ? e.message : String(e);
  }
}
