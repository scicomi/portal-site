/**
 * 設定ページ（管理者専用）
 */

document.addEventListener('DOMContentLoaded', () => {
    bootPage('settings', init);
});

async function init() {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => {
            location.reload();
        });
        return;
    }
    await loadSettings();
}

async function loadSettings() {
    const loading = document.getElementById('settings-loading');
    const content = document.getElementById('settings-content');
    try {
        const cfg = await api.adminGetConfig();

        // パスワード
        document.getElementById('cfg-password-current').textContent = cfg.password || '';
        document.getElementById('cfg-admin-password-current').textContent = cfg.admin_password || '';

        // Gemini
        document.getElementById('cfg-gemini-key').value = cfg.gemini_api_key || '';
        const modelSel = document.getElementById('cfg-gemini-model');
        let cur = cfg.gemini_model || 'gemini-2.5-flash-lite';
        const opt = [...modelSel.options].find(o => o.value === cur);
        if (opt && opt.disabled) cur = 'gemini-2.5-flash-lite';
        if (![...modelSel.options].some(o => o.value === cur)) {
            modelSel.add(new Option(cur, cur));
        }
        modelSel.value = cur;

        // 挨拶メッセージ
        document.getElementById('cfg-welcome-message').value = cfg.welcome_message || '';

        // 書類期限ルール（サーバーに保存されていない場合はCONFIGのデフォルト値を使用）
        const kyokaDays = cfg.deadline_kyoka != null ? Math.abs(parseInt(cfg.deadline_kyoka)) : Math.abs(CONFIG.DEADLINE_RULES.kyoka);
        const houkokuDays = cfg.deadline_houkoku != null ? parseInt(cfg.deadline_houkoku) : CONFIG.DEADLINE_RULES.houkoku;
        document.getElementById('cfg-deadline-kyoka').value = kyokaDays;
        document.getElementById('cfg-deadline-houkoku').value = houkokuDays;

        // 設定キャッシュを更新（他ページで applySiteSettings が即座に反映できるように）
        localStorage.setItem('scicomi_site_settings', JSON.stringify({ data: cfg, ts: Date.now() }));

        loading.style.display = 'none';
        content.style.display = 'block';
    } catch (e) {
        loading.textContent = '読み込み失敗: ' + e.message;
    }
}

function invalidateSettingsCache() {
    localStorage.removeItem('scicomi_site_settings');
}

// --- 個別保存ヘルパー ---

async function saveSettingField(key, inputId) {
    const value = document.getElementById(inputId).value.trim();
    try {
        await api.adminSetConfig(key, value);
        invalidateSettingsCache();
        if (key === 'welcome_message') {
            if (value) {
                localStorage.setItem('scicomi_welcome_message', value);
            } else {
                localStorage.removeItem('scicomi_welcome_message');
            }
        }
        toast('保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
    }
}

async function saveSettingDirect(key, inputId) {
    const el = document.getElementById(inputId);
    const value = el.tagName === 'SELECT' ? el.value : el.value.trim();
    try {
        await api.adminSetConfig(key, value);
        invalidateSettingsCache();
        toast('保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
    }
}

function toggleVisibility(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
}

// --- パスワード変更 ---

async function savePassword(key) {
    const inputId = key === 'password' ? 'cfg-password-new' : 'cfg-admin-password-new';
    const value = document.getElementById(inputId).value.trim();
    if (!value) {
        toast('新しいパスワードを入力してください', 'error');
        return;
    }

    // 幹部=一般 が同一になると、ログインした全員が自動的に管理者になる事故を防ぐ
    const otherId = key === 'password' ? 'cfg-admin-password-current' : 'cfg-password-current';
    const otherVal = (document.getElementById(otherId).textContent || '').trim();
    if (otherVal && value === otherVal) {
        const ok = confirm(
            '一般パスワードと幹部パスワードが同一になります。\n' +
            'この場合、ログインした全員が自動的に管理者権限を持ち、パスワード一覧も閲覧できてしまいます。\n' +
            '本当にこのパスワードにしますか？'
        );
        if (!ok) return;
    }

    try {
        await api.adminSetConfig(key, value);
        toast('パスワードを変更しました', 'success');
        document.getElementById(inputId).value = '';
        if (key === 'password') {
            document.getElementById('cfg-password-current').textContent = value;
            // 自分の現在のメンバートークンは epoch 失効した。新パスワードで取り直して
            // ログアウトされないようにする（管理者トークンは有効なまま）。
            try { await api.auth(value); } catch (_) {}
        }
        if (key === 'admin_password') {
            document.getElementById('cfg-admin-password-current').textContent = value;
            api.adminLogout();
            toast('幹部パスワードが変更されました。再認証してください。', 'info', 5000);
            setTimeout(() => location.reload(), 2000);
        }
    } catch (e) {
        toast('変更失敗: ' + e.message, 'error');
    }
}

// --- 書類期限ルール保存 ---

async function saveDeadlineRules() {
    const kyoka = parseInt(document.getElementById('cfg-deadline-kyoka').value);
    const houkoku = parseInt(document.getElementById('cfg-deadline-houkoku').value);
    if (isNaN(kyoka) || kyoka < 1 || isNaN(houkoku) || houkoku < 1) {
        toast('有効な日数を入力してください', 'error');
        return;
    }
    try {
        await api.adminSetConfig('deadline_kyoka', String(-kyoka));
        await api.adminSetConfig('deadline_houkoku', String(houkoku));
        invalidateSettingsCache();
        CONFIG.DEADLINE_RULES.kyoka = -kyoka;
        CONFIG.DEADLINE_RULES.houkoku = houkoku;
        toast('期限ルールを保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
    }
}

// --- 管理者解除 ---

function doAdminLogoutFromSettings() {
    api.adminLogout();
    toast('管理者モードを解除しました', 'info');
    setTimeout(() => { location.href = 'index.html'; }, 1000);
}
