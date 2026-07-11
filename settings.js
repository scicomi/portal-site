/**
 * 設定ページ（管理者専用）
 */

let _settingsPwValues = {};

document.addEventListener('DOMContentLoaded', () => {
    bootPage('settings', init);
});

// セクション見出しタップで開閉（見出し内のリンク・ボタン等の誤爆は無いのでシンプルに丸ごとトグル）
function toggleSettingsSection(headerEl) {
    headerEl.closest('.settings-section')?.classList.toggle('collapsed');
}

async function init() {
    if (!api.isAdmin()) {
        // 認証モーダルを閉じられても「読み込み中」が残らないよう、案内に置き換える
        const loading = document.getElementById('settings-loading');
        loading.classList.remove('loading-text');
        loading.innerHTML = `<div class="empty-state">
            <div class="empty-text">このページは管理者専用です</div>
            <div class="empty-hint">幹部パスワードで認証してください</div>
            <button type="button" class="btn btn-primary-solid" style="width:auto;padding:8px 20px;" onclick="showAdminAuthModal(() => location.reload())">管理者認証</button>
        </div>`;
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

        // パスワード（マスク表示。実値はメモリのみに保持）
        _settingsPwValues['cfg-password-current'] = cfg.password || '';
        _settingsPwValues['cfg-admin-password-current'] = cfg.admin_password || '';
        document.getElementById('cfg-password-current').textContent = maskPw(cfg.password);
        document.getElementById('cfg-admin-password-current').textContent = maskPw(cfg.admin_password);

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

        // ヘッダーのブランド表示
        document.getElementById('cfg-brand-icon').value = cfg.brand_icon || 'SC';
        document.getElementById('cfg-brand-name').value = cfg.brand_name || 'SciComi Portal';

        // 書類期限ルール（サーバーに保存されていない場合はCONFIGのデフォルト値を使用）
        const kyokaDays = cfg.deadline_kyoka != null ? Math.abs(parseInt(cfg.deadline_kyoka)) : Math.abs(CONFIG.DEADLINE_RULES.kyoka);
        const houkokuDays = cfg.deadline_houkoku != null ? parseInt(cfg.deadline_houkoku) : CONFIG.DEADLINE_RULES.houkoku;
        document.getElementById('cfg-deadline-kyoka').value = kyokaDays;
        document.getElementById('cfg-deadline-houkoku').value = houkokuDays;

        // 広報媒体
        document.getElementById('cfg-pr-channels').value = cfg.pr_channels || 'Twitter,Instagram,HP';

        // 設定キャッシュを更新（他ページで applySiteSettings が即座に反映できるように）
        localStorage.setItem('scicomi_site_settings', JSON.stringify({ data: cfg, ts: Date.now() }));

        loading.style.display = 'none';
        content.style.display = 'block';
    } catch (e) {
        if (e.handled) return;
        loading.classList.remove('loading-text');
        loading.innerHTML = `<div class="empty-state">
            <div class="empty-text">設定を読み込めませんでした</div>
            <div class="empty-hint">${escapeHtml(humanizeApiError(e))}</div>
            <button type="button" class="btn btn-secondary" onclick="location.reload()">再読み込み</button>
        </div>`;
    }
}

// 保存ボタン共通: 処理中は無効化して「保存中...」表示（二度押し防止）
async function _withBusyBtn(btn, fn) {
    if (!btn) return fn();
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '保存中...';
    try { return await fn(); }
    finally { btn.disabled = false; btn.textContent = orig; }
}

// --- 個別保存ヘルパー ---

async function saveSettingField(key, inputId, btn) {
    const value = document.getElementById(inputId).value.trim();
    await _withBusyBtn(btn, async () => {
        try {
            await api.adminSetConfig(key, value);
            invalidateSettingsCache();
            if (key === 'brand_icon') {
                const el = document.getElementById('header-brand-icon');
                if (el) el.textContent = value || 'SC';
            }
            if (key === 'brand_name') {
                const el = document.getElementById('header-brand-name');
                if (el) el.textContent = value || 'SciComi Portal';
            }
            toast('保存しました', 'success');
        } catch (e) {
            toast('保存失敗: ' + e.message, 'error');
        }
    });
}

async function saveSettingDirect(key, inputId, btn) {
    const el = document.getElementById(inputId);
    const value = el.tagName === 'SELECT' ? el.value : el.value.trim();
    await _withBusyBtn(btn, async () => {
        try {
            await api.adminSetConfig(key, value);
            invalidateSettingsCache();
            toast('保存しました', 'success');
        } catch (e) {
            toast('保存失敗: ' + e.message, 'error');
        }
    });
}

function toggleVisibility(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
}

function maskPw(val) {
    if (!val) return '';
    return '•'.repeat(Math.min(val.length, 12));
}

function toggleSettingsPwVisibility(codeId) {
    const el = document.getElementById(codeId);
    if (!el) return;
    const revealed = el.getAttribute('data-revealed') === 'true';
    const realVal = _settingsPwValues[codeId] || '';
    if (revealed) {
        el.textContent = maskPw(realVal);
        el.setAttribute('data-revealed', 'false');
        el.nextElementSibling.textContent = '表示';
    } else {
        el.textContent = realVal;
        el.setAttribute('data-revealed', 'true');
        el.nextElementSibling.textContent = '隠す';
    }
}

// --- パスワード変更 ---

function savePassword(key, btn) {
    const inputId = key === 'password' ? 'cfg-password-new' : 'cfg-admin-password-new';
    const value = document.getElementById(inputId).value.trim();
    if (!value) {
        toast('新しいパスワードを入力してください', 'error');
        document.getElementById(inputId).focus();
        return;
    }

    const otherId = key === 'password' ? 'cfg-admin-password-current' : 'cfg-password-current';
    const otherVal = (_settingsPwValues[otherId] || '').trim();
    if (otherVal && value === otherVal) {
        // 重大な設定ミスになりうるため、共通の確認ダイアログで明示的に確認する
        const overlay = document.createElement('div');
        overlay.className = 'confirm-dialog-overlay';
        overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
        overlay.innerHTML = `
            <div class="confirm-dialog">
                <h3>パスワードが同一になります</h3>
                <p>一般パスワードと幹部パスワードが同じ値になります。ログインした全員が自動的に管理者権限を持ち、パスワード一覧も閲覧できてしまいます。本当にこのパスワードにしますか？</p>
                <div class="confirm-dialog-actions">
                    <button class="btn btn-secondary" onclick="this.closest('.confirm-dialog-overlay').remove()">キャンセル</button>
                    <button class="btn btn-danger" id="confirm-same-pw-btn">同一にする</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        bindModalEscape(overlay, () => overlay.remove());
        overlay.querySelector('#confirm-same-pw-btn').onclick = () => {
            overlay.remove();
            executeSavePassword(key, inputId, value, btn);
        };
        return;
    }
    executeSavePassword(key, inputId, value, btn);
}

async function executeSavePassword(key, inputId, value, btn) {
    await _withBusyBtn(btn, async () => {
    try {
        await api.adminSetConfig(key, value);
        toast('パスワードを変更しました', 'success');
        document.getElementById(inputId).value = '';
        if (key === 'password') {
            _settingsPwValues['cfg-password-current'] = value;
            document.getElementById('cfg-password-current').textContent = maskPw(value);
            document.getElementById('cfg-password-current').setAttribute('data-revealed', 'false');
            try { await api.auth(value); } catch (_) {}
        }
        if (key === 'admin_password') {
            _settingsPwValues['cfg-admin-password-current'] = value;
            document.getElementById('cfg-admin-password-current').textContent = maskPw(value);
            document.getElementById('cfg-admin-password-current').setAttribute('data-revealed', 'false');
            api.adminLogout();
            toast('幹部パスワードが変更されました。再認証してください。', 'info', 5000);
            setTimeout(() => location.reload(), 2000);
        }
    } catch (e) {
        toast('変更失敗: ' + e.message, 'error');
    }
    });
}

// --- 書類期限ルール保存 ---

async function saveDeadlineRules(btn) {
    const kyoka = parseInt(document.getElementById('cfg-deadline-kyoka').value);
    const houkoku = parseInt(document.getElementById('cfg-deadline-houkoku').value);
    if (isNaN(kyoka) || kyoka < 1 || isNaN(houkoku) || houkoku < 1) {
        toast('有効な日数を入力してください', 'error');
        return;
    }
    await _withBusyBtn(btn, async () => {
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
    });
}

// --- 管理者解除 ---

function doAdminLogoutFromSettings() {
    api.adminLogout();
    toast('管理者モードを解除しました', 'info');
    setTimeout(() => { location.href = 'index.html'; }, 1000);
}
