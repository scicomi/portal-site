/**
 * 設定ページ（管理者専用）
 */

document.addEventListener('DOMContentLoaded', () => {
    // アコーディオン見出しはマウスだけでなくキーボード（Enter / Space）でも開閉できるようにし、
    // 開閉状態を aria-expanded で支援技術へ伝える（見出しは role="button" tabindex="0"）。
    document.querySelectorAll('.settings-section-header').forEach(h => {
        const section = h.closest('.settings-section');
        h.setAttribute('aria-expanded', String(!(section && section.classList.contains('collapsed'))));
        h.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                toggleSettingsSection(h);
            }
        });
    });
    bootPage('settings', init);
});

// セクション見出しタップで開閉（見出し内のリンク・ボタン等の誤爆は無いのでシンプルに丸ごとトグル）
function toggleSettingsSection(headerEl) {
    const section = headerEl.closest('.settings-section');
    if (!section) return;
    const collapsed = section.classList.toggle('collapsed');
    headerEl.setAttribute('aria-expanded', String(!collapsed));
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
    updateSyncStatus('initial-loading');
    try {
        const cfg = await api.adminGetConfig();
        updateSyncStatus('fresh', Date.now());

        // 機密値はサーバーから返らない（設定済みかどうかだけ表示し、変更時のみ入力させる）
        document.getElementById('cfg-password-current').textContent = secretStatus(cfg.password_set);
        document.getElementById('cfg-admin-password-current').textContent = secretStatus(cfg.admin_password_set);

        // Gemini
        document.getElementById('cfg-gemini-key').placeholder = cfg.gemini_api_key_set ? '設定済み（変更する場合のみ入力）' : 'AIza...';
        const modelSel = document.getElementById('cfg-gemini-model');
        let cur = cfg.gemini_model || 'gemini-2.5-flash-lite';
        const opt = [...modelSel.options].find(o => o.value === cur);
        if (opt && opt.disabled) cur = 'gemini-2.5-flash-lite';
        if (![...modelSel.options].some(o => o.value === cur)) {
            modelSel.add(new Option(cur, cur));
        }
        modelSel.value = cur;


        // 書類期限ルール（サーバーに保存されていない場合はCONFIGのデフォルト値を使用）
        const kyokaDays = cfg.deadline_kyoka != null ? Math.abs(parseInt(cfg.deadline_kyoka)) : Math.abs(CONFIG.DEADLINE_RULES.kyoka);
        const houkokuDays = cfg.deadline_houkoku != null ? parseInt(cfg.deadline_houkoku) : CONFIG.DEADLINE_RULES.houkoku;
        document.getElementById('cfg-deadline-kyoka').value = kyokaDays;
        document.getElementById('cfg-deadline-houkoku').value = houkokuDays;

        // ゴミ箱の保管日数
        document.getElementById('cfg-trash-keep-days').value = cfg.trash_keep_days != null && cfg.trash_keep_days !== '' ? parseInt(cfg.trash_keep_days, 10) : 7;

        // 広報媒体
        document.getElementById('cfg-pr-channels').value = cfg.pr_channels || 'Twitter,Instagram,HP';

        // LINE通知
        document.getElementById('cfg-line-url').value = cfg.line_add_friend_url || '';
        document.getElementById('cfg-line-token').placeholder = cfg.line_channel_access_token_set ? '設定済み（変更する場合のみ入力）' : 'トークンを入力';

        // リンク集
        renderSiteLinkRows(parseSiteLinks(cfg.site_links));

        loading.style.display = 'none';
        content.style.display = 'block';
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
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
            toast('保存しました', 'success');
        } catch (e) {
            toast('保存失敗: ' + humanizeApiError(e), 'error');
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
            toast('保存失敗: ' + humanizeApiError(e), 'error');
        }
    });
}

function toggleVisibility(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
}

function secretStatus(isSet) {
    return isSet ? '設定済み' : '未設定';
}

// APIキー・トークンの保存。入力欄は常に空で始まるため、空のまま押しても既存値を消さない。
async function saveSecret(key, inputId, btn) {
    const el = document.getElementById(inputId);
    const value = el.value.trim();
    if (!value) {
        toast('新しい値を入力してください', 'error');
        el.focus();
        return;
    }
    await _withBusyBtn(btn, async () => {
        try {
            await api.adminSetConfig(key, value);
            el.value = '';
            el.type = 'password';
            el.placeholder = '設定済み（変更する場合のみ入力）';
            toast('保存しました', 'success');
        } catch (e) {
            toast('保存失敗: ' + humanizeApiError(e), 'error');
        }
    });
}

// --- パスワード変更 ---

const PASSWORD_MIN_LENGTH = 10; // worker/src/config.js の PASSWORD_MIN_LENGTH と一致させること(サーバーでも検証する)

async function savePassword(key, btn) {
    const inputId = key === 'password' ? 'cfg-password-new' : 'cfg-admin-password-new';
    const value = document.getElementById(inputId).value.trim();
    if (value.length < PASSWORD_MIN_LENGTH) {
        toast(`パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください`, 'error');
        document.getElementById(inputId).focus();
        return;
    }
    // 一般と幹部が同じ値かどうかはサーバー側で判定し、同じなら拒否される
    await _withBusyBtn(btn, async () => {
    try {
        await api.adminSetConfig(key, value);
        toast('パスワードを変更しました', 'success');
        document.getElementById(inputId).value = '';
        if (key === 'password') {
            document.getElementById('cfg-password-current').textContent = secretStatus(true);
            try { await api.auth(value); } catch (_) {}
        }
        if (key === 'admin_password') {
            document.getElementById('cfg-admin-password-current').textContent = secretStatus(true);
            api.adminLogout();
            toast('幹部パスワードが変更されました。再認証してください。', 'info', 5000);
            setTimeout(() => location.reload(), 2000);
        }
    } catch (e) {
        toast('変更失敗: ' + humanizeApiError(e), 'error');
    }
    });
}

// --- 書類期限ルール保存 ---

// 日数の許容範囲(settings.html の min/max と worker/src/config.js の validateConfigValue と同じ)
const DEADLINE_DAYS_MIN = 1;
const DEADLINE_DAYS_MAX = 90;

function _parseDeadlineDays(id) {
    const raw = String(document.getElementById(id).value || '').trim();
    if (!/^\d+$/.test(raw)) return NaN;   // 小数・負数・空は不可(parseInt の「10.5 → 10」を許さない)
    const n = parseInt(raw, 10);
    return (n >= DEADLINE_DAYS_MIN && n <= DEADLINE_DAYS_MAX) ? n : NaN;
}

async function saveDeadlineRules(btn) {
    const kyoka = _parseDeadlineDays('cfg-deadline-kyoka');
    const houkoku = _parseDeadlineDays('cfg-deadline-houkoku');
    if (isNaN(kyoka) || isNaN(houkoku)) {
        toast(`日数は${DEADLINE_DAYS_MIN}〜${DEADLINE_DAYS_MAX}の整数で入力してください`, 'error');
        return;
    }
    const prevKyoka = CONFIG.DEADLINE_RULES.kyoka;   // 片方だけ保存されたときの巻き戻し用
    await _withBusyBtn(btn, async () => {
        try {
            await api.adminSetConfig('deadline_kyoka', String(-kyoka));
        } catch (e) {
            toast('保存失敗(何も変更していません): ' + humanizeApiError(e), 'error');
            return;
        }
        try {
            await api.adminSetConfig('deadline_houkoku', String(houkoku));
        } catch (e) {
            // 許可願だけ保存された状態を残さないよう、許可願を元に戻す
            let rolledBack = false;
            try { await api.adminSetConfig('deadline_kyoka', String(prevKyoka)); rolledBack = true; } catch (_) {}
            invalidateSettingsCache();
            if (rolledBack) {
                toast('報告書の期限を保存できなかったため、許可願の期限も元に戻しました: ' + humanizeApiError(e), 'error');
            } else {
                CONFIG.DEADLINE_RULES.kyoka = -kyoka;
                toast(`許可願の期限(${kyoka}日前)だけ保存され、報告書の期限は保存できませんでした。もう一度保存してください: ` + humanizeApiError(e), 'error', 8000);
            }
            return;
        }
        invalidateSettingsCache();
        CONFIG.DEADLINE_RULES.kyoka = -kyoka;
        CONFIG.DEADLINE_RULES.houkoku = houkoku;
        toast('期限ルールを保存しました', 'success');
    });
}

// --- ゴミ箱の保管日数 ---

async function saveTrashKeepDays(btn) {
    const raw = String(document.getElementById('cfg-trash-keep-days').value || '').trim();
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (isNaN(n) || n < 1 || n > 365) {
        toast('保管日数は1〜365の整数で入力してください', 'error');
        return;
    }
    await _withBusyBtn(btn, async () => {
        try {
            await api.adminSetConfig('trash_keep_days', String(n));
            toast('保管日数を保存しました', 'success');
        } catch (e) {
            toast('保存失敗: ' + humanizeApiError(e), 'error');
        }
    });
}

// --- リンク集（ホーム最下部に並ぶ外部リンク） ---

function renderSiteLinkRows(links) {
    const wrap = document.getElementById('cfg-links-rows');
    if (!wrap) return;
    wrap.innerHTML = '';
    // 未登録でも入力欄が1行は見えているほうが操作の起点になる
    const rows = links.length ? links : [{ label: '', url: '' }];
    rows.forEach(l => appendSiteLinkRow(l.label, l.url));
}

function appendSiteLinkRow(label, url) {
    const wrap = document.getElementById('cfg-links-rows');
    if (!wrap) return null;
    const row = document.createElement('div');
    row.className = 'cfg-link-row';
    row.innerHTML = `
        <input type="text" class="e1-input cfg-link-label" maxlength="40" placeholder="表示名（例: Instagram）" aria-label="リンクの表示名">
        <input type="text" class="e1-input cfg-link-url" placeholder="https://..." aria-label="リンクのURL">
        <button type="button" class="btn btn-secondary cfg-link-remove" aria-label="この行を削除">削除</button>
    `;
    row.querySelector('.cfg-link-label').value = label || '';
    row.querySelector('.cfg-link-url').value = url || '';
    row.querySelector('.cfg-link-remove').onclick = () => {
        row.remove();
        // 全部消すと追加の手がかりが無くなるため、最後の1行は空にして残す
        if (!wrap.querySelector('.cfg-link-row')) appendSiteLinkRow('', '');
    };
    wrap.appendChild(row);
    return row;
}

function addSiteLinkRow() {
    const row = appendSiteLinkRow('', '');
    if (row) row.querySelector('.cfg-link-label').focus();
}

async function saveSiteLinks(btn) {
    const rows = [...document.querySelectorAll('#cfg-links-rows .cfg-link-row')];
    const links = [];
    for (const row of rows) {
        const labelEl = row.querySelector('.cfg-link-label');
        const urlEl = row.querySelector('.cfg-link-url');
        const label = labelEl.value.trim();
        const raw = urlEl.value.trim();
        if (!label && !raw) continue;   // 空行は捨てる
        if (!label || !raw) {
            toast('表示名とURLの両方を入力してください', 'error');
            (label ? urlEl : labelEl).focus();
            return;
        }
        // javascript: など http(s) 以外のスキームは safeHttpUrl が空文字を返す
        const url = safeHttpUrl(raw);
        if (!url) {
            toast(`URLの形式が正しくありません: ${label}`, 'error');
            urlEl.focus();
            return;
        }
        links.push({ label, url });
    }
    await _withBusyBtn(btn, async () => {
        try {
            await api.adminSetConfig('site_links', JSON.stringify(links));
            invalidateSettingsCache();
            toast('リンク集を保存しました', 'success');
        } catch (e) {
            toast('保存失敗: ' + humanizeApiError(e), 'error');
        }
    });
}
