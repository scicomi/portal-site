/**
 * SciComi Portal - GAS Backend API Client (v2)
 *
 * 3リソース対応: events / members / experiments
 *
 * 使い方:
 *   await api.auth(password)              → 認証
 *   await api.list('events')              → イベント一覧
 *   await api.list('members')             → メンバー一覧
 *   await api.list('experiments')         → 実験一覧
 *   await api.listAll()                   → 全部まとめて（ホーム用）
 *   await api.save('events', eventObj)    → 保存
 *   await api.delete('events', id)        → 削除
 */

const API_URL = 'https://script.google.com/macros/s/AKfycbwfR0LGJmGhCzBZIj7UXhYok11Kmt0ZAmnwv1SIeWFFUUUCk0H0wMFHiZuMmEBII8FA/exec';
const TOKEN_KEY = 'scicomi_portal_token';
const CACHE_KEY_PREFIX = 'scicomi_cache_';
const HOLIDAYS_CACHE_KEY = 'scicomi_holidays_cache';
const HOLIDAYS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

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
    } catch (_) {}
  },

  clearAllCache() {
    ['events', 'members', 'experiments'].forEach(r => {
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
    return {
      events: data.events || [],
      members: data.members || [],
      experiments: data.experiments || []
    };
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
    // GASが古いデプロイなど item を返さない場合のフォールバック
    if (!res.item) {
      console.warn('GAS did not return item; falling back to local item. Old GAS deployment?');
      return { ...item };
    }
    return res.item;
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
      throw new Error('GASレスポンスのパース失敗: ' + text.slice(0, 200));
    }
  }
};
