/**
 * SciComi Portal - API Client (Cloudflare Workers)
 *
 * スキーマ駆動: CONFIG.RESOURCE_NAMES に登録されたリソース名を自動認識。
 * Optimistic UI: save はローカルキャッシュを即更新し、サーバー呼び出しは裏で実行。
 *
 * 使い方:
 *   await api.auth(password)              → 認証
 *   await api.list('events')              → イベント一覧
 *   await api.listAll()                   → 全リソース一括取得
 *   await api.save('events', eventObj)    → 保存（楽観的UI対応）
 *   await api.delete('events', id)        → 削除
 */

// 接続先 API。通常は config.js の API_URL。
// 切り替え前の試験運用用に、URL に ?api=https://xxx.workers.dev を付けて開くと、そのブラウザだけ接続先を切り替えられる
// (localStorage に保存。?api=reset で解除)。フィッシング対策として、workers.dev と localhost 以外は受け付けない。
const API_URL_OVERRIDE_KEY = 'scicomi_api_url_override';
function resolveApiUrl() {
  const base = (typeof CONFIG !== 'undefined' && CONFIG.API_URL) || '';
  const OK = /^(https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q === 'reset') localStorage.removeItem(API_URL_OVERRIDE_KEY);
    else if (q && OK.test(q.replace(/\/$/, ''))) localStorage.setItem(API_URL_OVERRIDE_KEY, q.replace(/\/$/, ''));
    const saved = localStorage.getItem(API_URL_OVERRIDE_KEY);
    if (saved && OK.test(saved)) { console.info('[api] 接続先を切り替えています: ' + saved); return saved; }
  } catch (_) {}
  return base;
}
const API_URL = resolveApiUrl();

// アップロード済みファイル(画像)の表示用 URL。
// 現在は Worker(R2)の公開 URL をそのまま使う。旧 Google Drive の閲覧ページ URL は <img> で表示できないため、
// サムネイル直リンクに変換する(Drive の既存ファイルが残っている場合の互換)。
function fileImageUrl(file, size) {
  const url = (file && file.url) || '';
  if (/drive\.google\.com/.test(url)) {
    const m = url.match(/\/d\/([-\w]{20,})/) || url.match(/[?&]id=([-\w]{20,})/);
    if (m) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w' + (size || 400);
  }
  return url;
}
const TOKEN_KEY = (typeof CONFIG !== 'undefined' && CONFIG.TOKEN_KEY) || 'scicomi_portal_token';
const CACHE_KEY_PREFIX = (typeof CONFIG !== 'undefined' && CONFIG.CACHE_PREFIX) || 'scicomi_cache_';
const CACHE_SCHEMA = CONFIG.CACHE_SCHEMA;
const HOLIDAYS_CACHE_KEY = (typeof CONFIG !== 'undefined' && CONFIG.HOLIDAYS_CACHE_KEY) || 'scicomi_holidays_cache';
const HOLIDAYS_CACHE_TTL_MS = (typeof CONFIG !== 'undefined' && CONFIG.HOLIDAYS_TTL_MS) || (30 * 24 * 60 * 60 * 1000);

const RESOURCE_NAMES = (typeof CONFIG !== 'undefined' && CONFIG.RESOURCE_NAMES)
  || ['events', 'members', 'experiments'];

// API 呼び出しのタイムアウト（ms）。通常は 30 秒、uploadFile（最大 10MB の base64）は 120 秒。
const API_TIMEOUT_MS = 30 * 1000;
const API_UPLOAD_TIMEOUT_MS = 120 * 1000;

const ADMIN_TOKEN_KEY = (typeof CONFIG !== 'undefined' && CONFIG.ADMIN_TOKEN_KEY) || 'scicomi_admin_token';
const ADMIN_TOKEN_TS_KEY = (typeof CONFIG !== 'undefined' && CONFIG.ADMIN_TOKEN_TS_KEY) || 'scicomi_admin_token_ts';
const ADMIN_TOKEN_TTL = (typeof CONFIG !== 'undefined' && CONFIG.ADMIN_TOKEN_TTL_MS) || (180 * 24 * 60 * 60 * 1000);

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
      // 一般パスワードでのログインなら、前回の幹部ログインの管理者トークンを残さない
      if (res.adminToken) this.setAdminToken(res.adminToken);
      else this.clearAdminToken();
      return { ok: true, role: res.role || 'member' };
    }
    return { ok: false, role: null };
  },

  // ---- 管理者認証 ----
  getAdminToken() {
    const ts = parseInt(localStorage.getItem(ADMIN_TOKEN_TS_KEY), 10) || 0;
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
      const cached = JSON.parse(raw);
      // 形式の版が違う（古い JS が書いた）キャッシュは使わない。呼び出し側はキャッシュ無しとして取り直す
      if (!cached || cached.schema !== CACHE_SCHEMA) return null;
      return cached;
    } catch (_) { return null; }
  },

  saveCache(resource, items) {
    try {
      localStorage.setItem(CACHE_KEY_PREFIX + resource, JSON.stringify({
        items,
        timestamp: Date.now(),
        schema: CACHE_SCHEMA
      }));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        this._evictOldestCache();
        try {
          localStorage.setItem(CACHE_KEY_PREFIX + resource, JSON.stringify({
            items, timestamp: Date.now(), schema: CACHE_SCHEMA
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

  // CACHE_KEY_PREFIX で始まるキャッシュをすべて消す（RESOURCE_NAMES 以外の votes なども含む）。
  // ログアウト・セッション切れのときに、出欠などのデータが端末に残らないようにするため。
  clearAllCache() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(CACHE_KEY_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
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
    // 出欠投票も同じレスポンスで受け取る（追加往復の削減）。
    result.votes = Array.isArray(res.votes) ? res.votes : [];
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
      console.warn('server did not return item; falling back to local item.');
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
          if (!res.success) throw new Error(res.detail || res.error || 'upload failed');   // detail: サーバーの説明(サイズ超過など)
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

  // 本日のGemini使用量だけを取得（実際にAPIを呼ばないため、ページ表示時のゲージ初期化に使う）
  async geminiUsage() {
    const res = await this._post({
      action: 'geminiUsage',
      token: this.getToken()
    });
    return res; // { success, usage, limit }
  },

  // ---- イベント投票 ----
  async getEventVotes(eventId) {
    const res = await this._post({
      action: 'getEventVotes',
      token: this.getToken(),
      eventId
    });
    if (!res.success) throw new Error(res.error || 'getEventVotes failed');
    return res.votes || [];
  },

  // 全イベントの投票を一括取得（ホームの出欠一括回答・イベント一覧の参加人数バッジ用）。
  async listVotes() {
    const res = await this._post({
      action: 'listVotes',
      token: this.getToken()
    });
    if (!res.success) throw new Error(res.error || 'listVotes failed');
    return res.votes || [];
  },

  async submitVote(vote) {
    const payload = {
      action: 'submitVote',
      token: this.getToken(),
      vote
    };
    // 締切後の修正は管理者のみ許可されるため、持っていれば管理者トークンも添える
    const adminToken = this.getAdminToken();
    if (adminToken) payload.adminToken = adminToken;
    const res = await this._post(payload);
    if (!res.success) throw new Error(res.error || 'submitVote failed');
    return res.vote;
  },

  // 読み取り系のみ、一時的な障害（通信断・サーバーの HTML エラーページ・不正応答）を自動リトライする。
  // 書き込み系は二重実行や conflict 誤判定を避けるためリトライしない。
  async _post(payload) {
    const retryable = ['list', 'listAll', 'listVotes', 'getEventVotes', 'getPublicConfig'].indexOf(payload && payload.action) >= 0;
    const maxAttempts = retryable ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this._postOnce(payload);
      } catch (e) {
        const transient = e && (e.code === 'NETWORK_UNREACHABLE' || e.code === 'HTML_RESPONSE' || e.code === 'BAD_RESPONSE');
        if (!transient || attempt >= maxAttempts) throw e;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  },

  // 同期エラーの原因調査用ログ（直近30件を localStorage に保持。api.getErrorLog() / api.errorLogText() で確認）
  _logErr(payload, code, info) {
    try {
      const list = JSON.parse(localStorage.getItem('scicomi_err_log') || '[]');
      list.push(Object.assign({
        t: new Date().toISOString(),
        action: payload && payload.action,
        code,
        online: navigator.onLine,
        ua: navigator.userAgent.slice(0, 120)
      }, info));
      localStorage.setItem('scicomi_err_log', JSON.stringify(list.slice(-30)));
    } catch (_) {}
  },
  getErrorLog() {
    try { return JSON.parse(localStorage.getItem('scicomi_err_log') || '[]'); } catch (_) { return []; }
  },
  errorLogText() { return JSON.stringify(this.getErrorLog(), null, 1); },

  async _postOnce(payload) {
    let res, text;
    const started = Date.now();
    // 回線が半死のときに応答待ちで固まらないよう、タイムアウトを設ける（通常 30 秒、ファイルアップロードは 120 秒）。
    // タイムアウトは通信断（NETWORK_UNREACHABLE）と同じ扱い。読み取り系は自動リトライされる。
    const timeoutMs = (payload && payload.action === 'uploadFile') ? API_UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      text = await res.text();
    } catch (e) {
      const timedOut = controller.signal.aborted;
      this._logErr(payload, 'NETWORK_UNREACHABLE', {
        ms: Date.now() - started, status: res && res.status,
        exc: timedOut ? ('timeout ' + timeoutMs + 'ms') : String(e && e.message || e).slice(0, 80)
      });
      const err = new Error('NETWORK_UNREACHABLE');
      err.code = 'NETWORK_UNREACHABLE';
      if (timedOut) err.timedOut = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success && parsed.error === 'unauthorized') {
        this._logErr(payload, 'unauthorized', { ms: Date.now() - started });
        this.clearToken();
        this.clearAdminToken();   // メンバーとして失効したなら管理者モードも引き継がない
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
      this._logErr(payload, looksHtml ? 'HTML_RESPONSE' : 'BAD_RESPONSE', {
        ms: Date.now() - started, status: res && res.status, finalUrl: res && res.url && res.url.slice(0, 80),
        body: (text || '').replace(/\s+/g, ' ').slice(0, 150)
      });
      if (looksHtml) {
        const err = new Error('HTML_RESPONSE');
        err.code = 'HTML_RESPONSE';
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
    case 'HTML_RESPONSE':
      return 'サーバーが HTML を返しました。一時的な混雑の場合は、少し待って再読み込みしてください。続く場合は、'
        + '①config.js の API_URL が正しいか'
        + '②サーバー（Cloudflare Workers）が動いているか（https://www.cloudflarestatus.com/ も参照）'
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
