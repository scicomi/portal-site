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

const api = {

  // ---- 認証 ----
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
    const url = `${API_URL}?action=list&resource=${resource}&token=${encodeURIComponent(this.getToken())}`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'list failed');
    return data.items || [];
  },

  async listAll() {
    const url = `${API_URL}?action=listAll&token=${encodeURIComponent(this.getToken())}`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'listAll failed');
    const result = {};
    RESOURCE_NAMES.forEach(r => { result[r] = data[r] || []; });
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

  /**
   * Optimistic Save: キャッシュを即更新し、GAS保存はPromiseで返す。
   * 呼び出し元は await せずにUIを先に更新できる。
   * 失敗時はキャッシュをロールバックする。
   *
   * @param {string} resource
   * @param {object} item
   * @param {Array} localList - 現在のローカルデータ配列（直接変更される）
   * @param {Function} onRollback - GAS保存失敗時に呼ぶUI復元コールバック
   * @returns {Promise<object>} GASが返した保存済みアイテム
   */
  async saveOptimistic(resource, item, localList, onRollback) {
    const existingIdx = item.ID ? localList.findIndex(x => x.ID === item.ID) : -1;
    const backup = existingIdx >= 0 ? { ...localList[existingIdx] } : null;

    const optimistic = { ...item, _pending: true };
    if (!optimistic.ID) optimistic.ID = '_tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    if (existingIdx >= 0) {
      localList[existingIdx] = optimistic;
    } else {
      localList.push(optimistic);
    }
    this.saveCache(resource, localList);

    try {
      const saved = await this.save(resource, item);
      const idx = localList.findIndex(x => x.ID === optimistic.ID);
      if (idx >= 0) {
        localList[idx] = saved;
      }
      this.saveCache(resource, localList);
      return saved;
    } catch (e) {
      if (backup && existingIdx >= 0) {
        localList[existingIdx] = backup;
      } else {
        const idx = localList.findIndex(x => x.ID === optimistic.ID);
        if (idx >= 0) localList.splice(idx, 1);
      }
      this.saveCache(resource, localList);
      if (onRollback) onRollback();
      throw e;
    }
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
      driveId
    });
    if (!res.success) throw new Error(res.error || 'delete file failed');
    return true;
  },

  async delete(resource, id) {
    const res = await this._post({
      action: 'delete', resource,
      token: this.getToken(), id
    });
    if (!res.success) {
      console.error('delete failed:', res);
      throw new Error(res.error || 'delete failed');
    }
    return true;
  },

  async _post(payload) {
    const res = await fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error('GAS response parse error: ' + text.slice(0, 200));
    }
  }
};
