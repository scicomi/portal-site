/**
 * SciComi Portal - 共通ロジック
 *
 * 全ページで読み込まれる（config.js の後に読み込む前提）:
 *   - 共通ユーティリティ（escapeHtml / 日付ヘルパー）
 *   - パスワード認証モーダル
 *   - ヘッダー＋ナビゲーション描画
 *   - 同期ステータス表示
 *   - トースト通知
 */

// ====== 振り返りフィードバック ユーティリティ ======

function parseFeedbackEntries(raw) {
  if (!raw || (typeof raw === 'string' && !raw.trim())) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch (_) {}
    }
    return [{ id: 'legacy_' + Date.now(), date: '', eventId: '', eventTitle: '', text: trimmed }];
  }
  return [];
}

function stringifyFeedbackEntries(entries) {
  if (!entries || entries.length === 0) return '';
  return JSON.stringify(entries);
}

function getFiscalYear(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-').map(Number);
  if (parts.length < 2) return null;
  return parts[1] >= 4 ? parts[0] : parts[0] - 1;
}

function genFeedbackId() {
  return 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// ====== 共通ユーティリティ ======

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseISODate(str) {
  if (!str) return null;
  const parts = String(str).split('-');
  if (parts.length < 3) return new Date(str);
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
}

function todayISO() {
  return toISODate(new Date());
}

function dayOfWeekJP(str) {
  const d = parseISODate(str);
  if (!d) return '';
  return ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
}

function shortDate(str) {
  const parts = String(str || '').split('-');
  if (parts.length < 3) return str || '';
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

function daysBetween(aISO, bISO) {
  const a = parseISODate(aISO), b = parseISODate(bISO);
  if (!a || !b) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function genId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// リンク href に使える URL だけを返す（http/https 以外＝javascript: 等は空にして無害化）。
// escapeAttr は引用符しかエスケープせずスキームを検証しないため、URL は必ずこれを通す。
function safeHttpUrl(u) {
  u = String(u === null || u === undefined ? '' : u).trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

// PartsList を新旧どちらの形式でも {name, presenters:[]} の配列に正規化する（読み取り専用用途）。
//   旧形式: [{partName:"一部", items:[{name, presenter}]}]
//   新形式: [{name, presenters:[]}]
// ※ 編集UIで使う script.js の parsePartsList は空時に空行プレースホルダを返す仕様のため別物。
//   集計・表示（bot 等）はこちらを使う。空・不正は [] を返す。
function normalizeParts(raw) {
  let data = raw;
  if (data === null || data === undefined || data === '') return [];
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return []; }
  }
  if (!Array.isArray(data)) return [];
  if (data[0] && data[0].partName !== undefined) {
    const flat = [];
    data.forEach(p => (p.items || []).forEach(it => {
      if (!it.name && !it.presenter) return;
      flat.push({ name: it.name || '', presenters: it.presenter ? [it.presenter] : [] });
    }));
    return flat;
  }
  return data.map(it => ({
    name: it.name || '',
    presenters: Array.isArray(it.presenters) ? it.presenters : (it.presenter ? [it.presenter] : [])
  }));
}

// ====== ナビゲーション ======

function renderHeader(activePage) {
  const header = document.querySelector('.app-header');
  if (!header) return;
  const isAdmin = api.isAdmin();

  const navItems = CONFIG.NAV_ITEMS.filter(item => !item.adminOnly || isAdmin);
  let navHtml = '';
  navItems.forEach(item => {
    if (item.adminFirst) navHtml += '<span class="nav-separator"></span>';
    navHtml += `<a href="${item.href}" class="nav-link ${item.page === activePage ? 'active' : ''}">${item.label}</a>`;
  });

  header.innerHTML = `
    <div class="header-top">
      <div class="header-brand">
        <a href="index.html" style="color:inherit;text-decoration:none;display:flex;align-items:center;gap:8px;">
          <span class="brand-icon">SC</span>
          <span class="brand-name">SciComi Portal</span>
        </a>
      </div>
      <div class="header-actions">
        <div id="sync-status" class="sync-status" title="クリックで再読込" onclick="if(window.refreshData)refreshData(true)"></div>
        ${isAdmin
          ? `<span class="admin-badge">管理者</span>`
          : `<button class="btn btn-text-light" onclick="showAdminAuthModal()">管理者</button>`
        }
        <button class="btn btn-text-light" id="logout-btn" onclick="handleLogout(this)">ログアウト</button>
      </div>
    </div>
    <nav class="app-nav">
      ${navHtml}
    </nav>
  `;
}

function handleLogout(btn) {
  if (btn.dataset.confirming) {
    api.clearToken();
    api.clearAdminToken();
    api.clearAllCache();
    location.href = 'index.html';
    return;
  }
  btn.dataset.confirming = '1';
  btn.textContent = 'ログアウトする？';
  btn.style.color = '#e74c3c';
  setTimeout(() => {
    if (btn.dataset.confirming) {
      delete btn.dataset.confirming;
      btn.textContent = 'ログアウト';
      btn.style.color = '';
    }
  }, 3000);
}

// ====== モーダル アクセシビリティ ======

function trapFocus(modal) {
  const focusable = modal.querySelectorAll('input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

function bindModalEscape(modal, closeFn) {
  const handler = (e) => {
    if (e.key === 'Escape') { closeFn(); document.removeEventListener('keydown', handler); }
  };
  document.addEventListener('keydown', handler);
}

// ====== 管理者認証モーダル ======

function showAdminAuthModal(onSuccess) {
  let existing = document.getElementById('admin-auth-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'admin-auth-modal';
  modal.innerHTML = `
    <div class="pw-overlay">
      <div class="pw-box" role="dialog" aria-modal="true" aria-labelledby="admin-auth-title">
        <h2 id="admin-auth-title">管理者認証</h2>
        <p>幹部パスワードを入力してください。</p>
        <input id="admin-pw-input" type="password" placeholder="幹部パスワード" autofocus>
        <div id="admin-pw-error" class="pw-error" role="alert"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button id="admin-pw-cancel" class="btn btn-secondary">キャンセル</button>
          <button id="admin-pw-submit" class="btn btn-primary-solid">認証</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const box = modal.querySelector('.pw-box');
  const input = modal.querySelector('#admin-pw-input');
  const errEl = modal.querySelector('#admin-pw-error');
  const submitBtn = modal.querySelector('#admin-pw-submit');
  const cancelBtn = modal.querySelector('#admin-pw-cancel');
  trapFocus(box);
  bindModalEscape(modal, () => modal.remove());
  setTimeout(() => input.focus(), 50);

  const tryAdminLogin = async () => {
    errEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = '認証中...';
    try {
      const ok = await api.adminAuth(input.value);
      if (ok) {
        modal.remove();
        toast('管理者モードに切り替えました', 'success');
        if (onSuccess) {
          await onSuccess();
        } else {
          location.reload();
        }
      } else {
        errEl.textContent = 'パスワードが違います';
        submitBtn.disabled = false;
        submitBtn.textContent = '認証';
        input.select();
      }
    } catch (e) {
      errEl.textContent = humanizeApiError(e);
      submitBtn.disabled = false;
      submitBtn.textContent = '認証';
    }
  };

  submitBtn.addEventListener('click', tryAdminLogin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryAdminLogin(); });
  cancelBtn.addEventListener('click', () => modal.remove());
  modal.querySelector('.pw-overlay').addEventListener('click', (e) => {
    if (e.target === modal.querySelector('.pw-overlay')) modal.remove();
  });
}


// ====== 認証ゲート ======

async function requireAuth(onReady) {
  if (!api.getToken()) {
    showPasswordModal(onReady);
    return;
  }
  await onReady();
}

function showPasswordModal(onSuccess) {
  const modal = document.createElement('div');
  modal.id = 'pw-modal';
  modal.innerHTML = `
    <div class="pw-overlay">
      <div class="pw-box" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title">
        <h2 id="pw-modal-title">ログイン</h2>
        <p>パスワードを入力してください。<br>
          <span style="font-size:0.8rem;color:#888;">幹部パスワードを入力すると、自動的に管理者モードになります。</span>
        </p>
        <input id="pw-input" type="password" placeholder="パスワード" autofocus>
        <div id="pw-error" class="pw-error" role="alert"></div>
        <button id="pw-submit" class="btn btn-primary-solid">ログイン</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const box = modal.querySelector('.pw-box');
  const input = modal.querySelector('#pw-input');
  const errEl = modal.querySelector('#pw-error');
  const submitBtn = modal.querySelector('#pw-submit');
  trapFocus(box);
  setTimeout(() => input.focus(), 50);

  const tryLogin = async () => {
    errEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = '認証中...';
    try {
      const result = await api.login(input.value);
      if (result.ok) {
        modal.remove();
        toast(result.role === 'admin' ? '管理者としてログインしました' : 'ログインしました', 'success');
        await onSuccess();
      } else {
        errEl.textContent = 'パスワードが違います';
        submitBtn.disabled = false;
        submitBtn.textContent = 'ログイン';
        input.select();
      }
    } catch (e) {
      errEl.textContent = humanizeApiError(e);
      submitBtn.disabled = false;
      submitBtn.textContent = 'ログイン';
    }
  };

  submitBtn.addEventListener('click', tryLogin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
}

// ====== 同期ステータス ======

function updateSyncStatus(state, timestamp, errMsg) {
  const el = document.getElementById('sync-status');
  if (!el) return;

  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  };

  const labels = {
    'initial-loading': '<span class="sync-dot loading"></span>読み込み中...',
    'syncing-bg':      '<span class="sync-dot loading"></span>同期中...',
    'syncing':         '<span class="sync-dot loading"></span>更新中...',
    'fresh':           `<span class="sync-dot fresh"></span>${fmtTime(timestamp)} 同期済`,
    'cached':          `<span class="sync-dot cached"></span>キャッシュ表示 ${fmtTime(timestamp)}`,
    'error':           `<span class="sync-dot error"></span>同期エラー`
  };
  el.innerHTML = labels[state] || '';
  // エラー詳細（ツールチップ）は既知のコードを日本語へ変換して表示する
  if (state === 'error') {
    el.title = errMsg
      ? (typeof humanizeApiError === 'function' ? humanizeApiError({ code: errMsg, message: errMsg }) : errMsg)
      : '';
  }
}

// ====== トースト通知 ======

function toast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, duration);
}

function toastUndo(message, onUndo, onCommit, delay = 5000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast toast-undo';
  t.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button class="toast-undo-btn">元に戻す</button>
    <div class="toast-progress"></div>
  `;
  container.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);

  let undone = false;
  const undoBtn = t.querySelector('.toast-undo-btn');
  undoBtn.addEventListener('click', () => {
    undone = true;
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
    onUndo();
  });

  const progress = t.querySelector('.toast-progress');
  progress.style.transition = `width ${delay}ms linear`;
  setTimeout(() => { progress.style.width = '0%'; }, 10);

  setTimeout(async () => {
    if (undone) return;
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
    try { await onCommit(); } catch (e) { toast('削除失敗: ' + e.message, 'error'); }
  }, delay);
}

// ====== サーバー設定の反映 ======

async function applySiteSettings() {
    const SETTINGS_CACHE_KEY = 'scicomi_site_settings';
    const SETTINGS_TTL = 10 * 60 * 1000; // 10分
    try {
        const cached = localStorage.getItem(SETTINGS_CACHE_KEY);
        if (cached) {
            const obj = JSON.parse(cached);
            if (Date.now() - obj.ts < SETTINGS_TTL) {
                _applyCfg(obj.data);
                return;
            }
        }
    } catch (_) {}
    try {
        // 管理者は全設定、一般メンバーは公開設定（表示系のみ）を取得。
        // どちらも期限ルール・アラート閾値・挨拶メッセージをクライアントへ反映できる。
        const cfg = api.isAdmin() ? await api.adminGetConfig() : await api.getPublicConfig();
        _applyCfg(cfg);
        localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ data: cfg, ts: Date.now() }));
    } catch (_) {}
}

function _applyCfg(cfg) {
    if (!cfg) return;
    if (cfg.deadline_kyoka != null && cfg.deadline_kyoka !== '') CONFIG.DEADLINE_RULES.kyoka = parseInt(cfg.deadline_kyoka);
    if (cfg.deadline_houkoku != null && cfg.deadline_houkoku !== '') CONFIG.DEADLINE_RULES.houkoku = parseInt(cfg.deadline_houkoku);
    if (cfg.deadline_alert_danger != null && cfg.deadline_alert_danger !== '') CONFIG.DEADLINE_ALERT.danger = parseInt(cfg.deadline_alert_danger);
    if (cfg.deadline_alert_warning != null && cfg.deadline_alert_warning !== '') CONFIG.DEADLINE_ALERT.warning = parseInt(cfg.deadline_alert_warning);
    if (cfg.reminder_days) {
        const days = String(cfg.reminder_days).split(/[,\s]+/).map(Number).filter(n => n > 0);
        if (days.length) CONFIG.REMINDER.days = days;
    }
    // 挨拶メッセージは空なら削除（管理者がクリアしたら既定文へ戻す）
    if (cfg.welcome_message !== undefined) {
        if (cfg.welcome_message) localStorage.setItem('scicomi_welcome_message', cfg.welcome_message);
        else localStorage.removeItem('scicomi_welcome_message');
    }
}

// ====== 起動共通 ======

async function bootPage(activePage, onAuthReady) {
  renderHeader(activePage);
  await requireAuth(async () => {
    await applySiteSettings();
    await onAuthReady();
  });
}
