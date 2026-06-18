/**
 * SciComi Portal - GAS Backend API Client
 *
 * 使い方:
 *   1. API_URL に GAS の Web App URL を貼る
 *   2. api.auth(password) → 認証＆トークン保存
 *   3. api.list() / api.save(event) / api.delete(id) で CRUD
 */

const API_URL = 'https://script.google.com/macros/s/AKfycbwfR0LGJmGhCzBZIj7UXhYok11Kmt0ZAmnwv1SIeWFFUUUCk0H0wMFHiZuMmEBII8FA/exec';
const TOKEN_KEY = 'scicomi_portal_token';

const api = {

  // ---- 認証 ----
  getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  },

  setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  },

  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },

  async auth(password) {
    const res = await this._post({ action: 'auth', password });
    if (res.success && res.token) {
      this.setToken(res.token);
      return true;
    }
    return false;
  },

  // ---- CRUD ----
  async list() {
    const url = `${API_URL}?action=list&token=${encodeURIComponent(this.getToken())}`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'list failed');
    return data.events || [];
  },

  async save(eventObj) {
    const res = await this._post({
      action: 'save',
      token: this.getToken(),
      event: eventObj
    });
    if (!res.success) throw new Error(res.error || 'save failed');
    return res.event;
  },

  async delete(id) {
    const res = await this._post({
      action: 'delete',
      token: this.getToken(),
      id
    });
    if (!res.success) throw new Error(res.error || 'delete failed');
    return true;
  },

  // ---- 内部: text/plain POST（CORS preflight 回避）----
  async _post(payload) {
    const res = await fetch(API_URL, {
      method: 'POST',
      // 重要: text/plain を使うことで preflight (OPTIONS) を回避する
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  }
};
