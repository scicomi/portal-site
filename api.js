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
    if (!res.success) {
      console.error('save failed, response:', res);
      throw new Error((res.error || 'save failed') + (res.debug ? ' | debug: ' + JSON.stringify(res.debug) : ''));
    }
    return res.event;
  },

  async delete(id) {
    const res = await this._post({
      action: 'delete',
      token: this.getToken(),
      id
    });
    if (!res.success) {
      console.error('delete failed, response:', res);
      throw new Error((res.error || 'delete failed') + (res.debug ? ' | debug: ' + JSON.stringify(res.debug) : ''));
    }
    return true;
  },

  // ---- 内部: text/plain POST（CORS preflight 回避）----
  async _post(payload) {
    // text/plain（charsetなし）でpreflightを確実に回避
    // GASはリダイレクト後にCORSヘッダーを付けるので redirect:'follow' が必須
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
