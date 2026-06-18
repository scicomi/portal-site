/**
 * SciComi Portal - 共通ロジック
 *
 * 全ページで読み込まれる:
 *   - パスワード認証モーダル
 *   - ヘッダー＋ナビゲーション描画
 *   - 同期ステータス表示
 *   - トースト通知
 */

// ====== ナビゲーション ======

const NAV_ITEMS = [
  { href: 'index.html',       label: '🏠 ホーム',    page: 'home' },
  { href: 'events.html',      label: '📅 イベント',  page: 'events' },
  { href: 'members.html',     label: '👥 メンバー',  page: 'members' },
  { href: 'experiments.html', label: '🧪 実験内容',  page: 'experiments' }
];

function renderHeader(activePage) {
  const header = document.querySelector('.app-header');
  if (!header) return;
  header.innerHTML = `
    <div class="header-top">
      <div class="header-brand">
        <span class="brand-icon">🔬</span>
        <span class="brand-name">SciComi Portal</span>
      </div>
      <div class="header-actions">
        <div id="sync-status" class="sync-status" title="クリックで再読込" onclick="if(window.refreshData)refreshData(true)"></div>
        <button class="btn btn-text-light" onclick="confirmLogout()">ログアウト</button>
      </div>
    </div>
    <nav class="app-nav">
      ${NAV_ITEMS.map(item => `
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
  api.clearAllCache();
  location.href = 'index.html';
}

// ====== 認証ゲート ======
// 各ページのDOMContentLoadedで呼ぶ。tokenなしならログインモーダル→ログイン後にコールバック実行

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
        <h2>🔒 ログイン</h2>
        <p>サークルメンバー共通パスワードを入力してください。</p>
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
      const ok = await api.auth(input.value);
      if (ok) {
        modal.remove();
        await onSuccess();
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
  const icons = { success: '✅', error: '⚠️', info: 'ℹ️' };
  t.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
  container.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// 削除UNDO付きトースト
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
    <span>🗑️ ${message}</span>
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
// 各ページから呼ぶ。activePage は 'home' / 'events' / 'members' / 'experiments'
async function bootPage(activePage, onAuthReady) {
  renderHeader(activePage);
  await requireAuth(async () => {
    await onAuthReady();
  });
}
