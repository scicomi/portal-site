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

// ====== ナビゲーション ======

function renderHeader(activePage) {
  const header = document.querySelector('.app-header');
  if (!header) return;
  const isAdmin = api.isAdmin();
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
          ? `<span class="admin-badge">管理者</span>
             <button class="btn btn-text-light" onclick="showAdminSettingsModal()">管理</button>
             <button class="btn btn-text-light" onclick="doAdminLogout()">管理者解除</button>`
          : `<button class="btn btn-text-light" onclick="showAdminAuthModal()">管理者</button>`
        }
        <button class="btn btn-text-light" onclick="confirmLogout()">ログアウト</button>
      </div>
    </div>
    <nav class="app-nav">
      ${CONFIG.NAV_ITEMS.filter(item => !item.adminOnly || isAdmin).map(item => `
        <a href="${item.href}" class="nav-link ${item.page === activePage ? 'active' : ''}">
          ${item.label}
        </a>
      `).join('')}
    </nav>
  `;
}

function confirmLogout() {
  if (!confirm('ログアウトしますか？')) return;
  api.clearToken();
  api.clearAdminToken();
  api.clearAllCache();
  location.href = 'index.html';
}

function doAdminLogout() {
  api.adminLogout();
  toast('管理者モードを解除しました', 'info');
  location.reload();
}

// ====== 管理者認証モーダル ======

function showAdminAuthModal(onSuccess) {
  let existing = document.getElementById('admin-auth-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'admin-auth-modal';
  modal.innerHTML = `
    <div class="pw-overlay">
      <div class="pw-box">
        <h2>管理者認証</h2>
        <p>幹部パスワードを入力してください。</p>
        <input id="admin-pw-input" type="password" placeholder="幹部パスワード" autofocus>
        <div id="admin-pw-error" class="pw-error"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button id="admin-pw-cancel" class="btn btn-secondary">キャンセル</button>
          <button id="admin-pw-submit" class="btn btn-primary-solid">認証</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const input = modal.querySelector('#admin-pw-input');
  const errEl = modal.querySelector('#admin-pw-error');
  const submitBtn = modal.querySelector('#admin-pw-submit');
  const cancelBtn = modal.querySelector('#admin-pw-cancel');
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
      errEl.textContent = '通信エラー: ' + e.message;
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

// ====== 管理者設定モーダル ======

async function showAdminSettingsModal() {
  if (!api.isAdmin()) {
    showAdminAuthModal(() => showAdminSettingsModal());
    return;
  }

  let existing = document.getElementById('admin-settings-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'admin-settings-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:520px;">
      <div class="modal-header">
        <h2>管理者設定</h2>
        <button class="btn btn-text" onclick="document.getElementById('admin-settings-modal').remove()">閉じる</button>
      </div>
      <div class="modal-body" style="padding:16px 0;">
        <div id="admin-settings-loading" style="text-align:center;padding:24px;color:#888;">読み込み中...</div>
        <div id="admin-settings-content" style="display:none;">

          <div class="admin-settings-section">
            <h3>サービスパスワード</h3>
            <p class="admin-settings-desc">メンバー全員が使うログインパスワード</p>
            <div class="e1-group">
              <label class="e1-label">現在のパスワード</label>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" id="admin-cfg-password" class="e1-input" readonly style="flex:1;">
              </div>
            </div>
            <div class="e1-group">
              <label class="e1-label">新しいパスワード（変更する場合）</label>
              <div style="display:flex;gap:8px;">
                <input type="text" id="admin-cfg-password-new" class="e1-input" placeholder="変更しない場合は空欄" style="flex:1;">
                <button class="btn btn-primary-solid" onclick="adminSaveConfig('password')" style="width:auto;padding:8px 16px;">変更</button>
              </div>
            </div>
          </div>

          <div class="admin-settings-section">
            <h3>幹部パスワード</h3>
            <p class="admin-settings-desc">管理者認証に使うパスワード</p>
            <div class="e1-group">
              <label class="e1-label">現在の幹部パスワード</label>
              <input type="text" id="admin-cfg-admin-password" class="e1-input" readonly>
            </div>
            <div class="e1-group">
              <label class="e1-label">新しい幹部パスワード（変更する場合）</label>
              <div style="display:flex;gap:8px;">
                <input type="text" id="admin-cfg-admin-password-new" class="e1-input" placeholder="変更しない場合は空欄" style="flex:1;">
                <button class="btn btn-primary-solid" onclick="adminSaveConfig('admin_password')" style="width:auto;padding:8px 16px;">変更</button>
              </div>
            </div>
          </div>

          <div class="admin-settings-section">
            <h3>Gemini APIキー</h3>
            <p class="admin-settings-desc">Bot機能で使用。サーバー側で安全に管理されます。</p>
            <div class="e1-group">
              <label class="e1-label">APIキー</label>
              <div style="display:flex;gap:8px;">
                <input type="password" id="admin-cfg-gemini-key" class="e1-input" placeholder="AIza..." style="flex:1;">
                <button class="btn btn-secondary" onclick="toggleGeminiKeyVisibility()" style="width:auto;padding:8px 12px;" title="表示切替">👁</button>
                <button class="btn btn-primary-solid" onclick="adminSaveConfig('gemini_api_key')" style="width:auto;padding:8px 16px;">保存</button>
              </div>
            </div>
            <div class="e1-group">
              <label class="e1-label">使用モデル</label>
              <p class="admin-settings-desc" style="margin-top:0;">「レート制限」が頻発する場合、無料枠に余裕のあるモデルへ切り替えてください。</p>
              <div style="display:flex;gap:8px;">
                <select id="admin-cfg-gemini-model" class="e1-input" style="flex:1;">
                  <option value="gemini-2.0-flash-lite">gemini-2.0-flash-lite（無料枠 15 RPM・推奨）</option>
                  <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
                  <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                </select>
                <button class="btn btn-primary-solid" onclick="adminSaveConfig('gemini_model')" style="width:auto;padding:8px 16px;">保存</button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', handler); }
  });

  try {
    const cfg = await api.adminGetConfig();
    document.getElementById('admin-cfg-password').value = cfg.password || '';
    document.getElementById('admin-cfg-admin-password').value = cfg.admin_password || '';
    document.getElementById('admin-cfg-gemini-key').value = cfg.gemini_api_key || '';
    const modelSel = document.getElementById('admin-cfg-gemini-model');
    if (modelSel) {
      const cur = cfg.gemini_model || 'gemini-2.0-flash-lite';
      // 既存オプションに無いモデル名なら選択肢を追加してから選択
      if (![...modelSel.options].some(o => o.value === cur)) {
        modelSel.add(new Option(cur, cur));
      }
      modelSel.value = cur;
    }
    document.getElementById('admin-settings-loading').style.display = 'none';
    document.getElementById('admin-settings-content').style.display = 'block';
  } catch (e) {
    document.getElementById('admin-settings-loading').textContent = '読み込み失敗: ' + e.message;
  }
}

function toggleGeminiKeyVisibility() {
  const el = document.getElementById('admin-cfg-gemini-key');
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

async function adminSaveConfig(key) {
  const map = {
    password: 'admin-cfg-password-new',
    admin_password: 'admin-cfg-admin-password-new',
    gemini_api_key: 'admin-cfg-gemini-key',
    gemini_model: 'admin-cfg-gemini-model'
  };
  const inputId = map[key];
  if (!inputId) return;
  const value = document.getElementById(inputId).value.trim();

  if ((key === 'password' || key === 'admin_password') && !value) {
    toast('新しいパスワードを入力してください', 'error');
    return;
  }

  try {
    await api.adminSetConfig(key, value);
    toast('保存しました', 'success');
    if (key === 'password') {
      document.getElementById('admin-cfg-password').value = value;
      document.getElementById('admin-cfg-password-new').value = '';
    }
    if (key === 'admin_password') {
      document.getElementById('admin-cfg-admin-password').value = value;
      document.getElementById('admin-cfg-admin-password-new').value = '';
      api.adminLogout();
      toast('幹部パスワードが変更されました。再認証してください。', 'info', 5000);
      document.getElementById('admin-settings-modal').remove();
    }
  } catch (e) {
    toast('保存失敗: ' + e.message, 'error');
  }
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
      <div class="pw-box">
        <h2>ログイン</h2>
        <p>パスワードを入力してください。<br>
          <span style="font-size:0.8rem;color:#888;">幹部パスワードを入力すると、自動的に管理者モードになります。</span>
        </p>
        <input id="pw-input" type="password" placeholder="パスワード" autofocus>
        <div id="pw-error" class="pw-error"></div>
        <button id="pw-submit" class="btn btn-primary-solid">ログイン</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const input = modal.querySelector('#pw-input');
  const errEl = modal.querySelector('#pw-error');
  const submitBtn = modal.querySelector('#pw-submit');
  setTimeout(() => input.focus(), 50);

  const tryLogin = async () => {
    errEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = '認証中...';
    try {
      const result = await api.login(input.value);
      if (result.ok) {
        modal.remove();
        if (result.role === 'admin') {
          // 幹部パスワード → 自動で管理者モード。パスワード一覧ページへ。
          toast('管理者としてログインしました', 'success');
          location.href = 'passwords.html';
        } else {
          await onSuccess();
        }
      } else {
        errEl.textContent = 'パスワードが違います';
        submitBtn.disabled = false;
        submitBtn.textContent = 'ログイン';
        input.select();
      }
    } catch (e) {
      errEl.textContent = '通信エラー: ' + e.message;
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
  if (state === 'error') el.title = errMsg || '';
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

// ====== 起動共通 ======

async function bootPage(activePage, onAuthReady) {
  renderHeader(activePage);
  await requireAuth(async () => {
    await onAuthReady();
  });
}
