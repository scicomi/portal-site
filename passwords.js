/**
 * パスワード一覧ページ（管理者専用）
 *
 * 外部サービス（モノタロウ等）のURL・ログインID・パスワードを管理。
 * - 閲覧/追加/編集/削除すべて管理者トークン必須（API側でもガード）。
 * - パスワードはトグル（👁）で表示。各項目はコピー可能。
 * - localStorage にはキャッシュしない（機密のため毎回サーバーから取得）。
 * - カテゴリ（SNS/購買・印刷/サーバーなど）でフィルタ・色分け。
 */

let pwData = [];
let pwSearchKw = '';
let pwCatFilter = '';   // '' = 全て
let editingPwId = null;
const expandedPw = new Set();

const PW_CATS = (typeof CONFIG !== 'undefined' && CONFIG.PASSWORD_CATEGORIES) || {};
const LOGIN_TYPES = (typeof CONFIG !== 'undefined' && CONFIG.LOGIN_TYPES) || { normal: { label: 'ID / パスワード', social: false } };

function isSocialLogin(loginType) {
    const t = LOGIN_TYPES[loginType || 'normal'];
    return t ? !!t.social : false;
}

document.addEventListener('DOMContentLoaded', () => {
    bootPage('passwords', init);
});

async function init() {
    if (!api.isAdmin()) {
        showAdminGate();
        showAdminAuthModal(async () => { location.reload(); });
        return;
    }
    showAdminBody();
    buildCategoryDropdown();
    buildLoginTypeDropdown();
    buildCategoryFilter();
    await refreshData();
}

function showAdminGate() {
    document.getElementById('pw-denied').style.display = 'block';
    document.getElementById('pw-admin-body').style.display = 'none';
}

function showAdminBody() {
    document.getElementById('pw-denied').style.display = 'none';
    document.getElementById('pw-admin-body').style.display = 'block';
}

// モーダル内のカテゴリ <select> を CONFIG から動的生成
function buildCategoryDropdown() {
    const sel = document.getElementById('pw-f-category');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(PW_CATS).forEach(key => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = PW_CATS[key].label;
        sel.appendChild(opt);
    });
}

// ログイン方法 <select> を CONFIG から動的生成
function buildLoginTypeDropdown() {
    const sel = document.getElementById('pw-f-logintype');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(LOGIN_TYPES).forEach(key => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = LOGIN_TYPES[key].label;
        sel.appendChild(opt);
    });
}

// ログイン方法が変わったらパスワード欄を表示/非表示
function onLoginTypeChange() {
    const val = document.getElementById('pw-f-logintype').value;
    const pwGroup = document.getElementById('pw-f-password-group');
    if (isSocialLogin(val)) {
        pwGroup.style.display = 'none';
        document.getElementById('pw-f-password').value = '';
    } else {
        pwGroup.style.display = '';
    }
}

// カテゴリフィルタタブを生成
function buildCategoryFilter() {
    const container = document.getElementById('pw-cat-filter');
    if (!container) return;
    let html = '<button class="pw-cat-tab active" data-cat="" onclick="setPwCatFilter(\'\')">すべて</button>';
    Object.keys(PW_CATS).forEach(key => {
        const cat = PW_CATS[key];
        html += `<button class="pw-cat-tab" data-cat="${key}" onclick="setPwCatFilter('${key}')" style="--cat-color:${cat.color}">${escapeHtml(cat.label)}</button>`;
    });
    container.innerHTML = html;
}

function setPwCatFilter(cat) {
    pwCatFilter = cat;
    document.querySelectorAll('.pw-cat-tab').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-cat') === cat);
    });
    renderPasswords();
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'initial-loading');
    try {
        pwData = await api.listPasswords();
        renderPasswords();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes('unauthorized')) {
            api.clearToken(); api.clearAllCache();
            location.reload();
            return;
        }
        if (msg.includes('ADMIN_REQUIRED')) {
            api.adminLogout();
            showAdminGate();
            showAdminAuthModal(() => location.reload());
            return;
        }
        updateSyncStatus('error', null, msg);
        document.getElementById('pw-list').innerHTML =
            `<div class="empty-state">読み込みに失敗しました: ${escapeHtml(msg)}</div>`;
    }
}

function onPwSearch() {
    pwSearchKw = (document.getElementById('pw-search').value || '').toLowerCase();
    renderPasswords();
}

function hostOf(url) {
    if (!url) return '';
    try { return new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).host; }
    catch (_) { return url; }
}

function catBadgeHtml(catKey) {
    const cat = PW_CATS[catKey];
    if (!cat) return '';
    return `<span class="pw-cat-badge" style="--cat-color:${cat.color}">${escapeHtml(cat.label)}</span>`;
}

function noteToHtml(note) {
    if (!note) return '';
    return escapeHtml(note).replace(/\n/g, '<br>');
}

function renderPasswords() {
    const list = document.getElementById('pw-list');
    if (!list) return;

    let items = pwData.slice();

    // カテゴリフィルタ
    if (pwCatFilter) {
        items = items.filter(p => (p.Category || 'other') === pwCatFilter);
    }

    // テキスト検索
    if (pwSearchKw) {
        items = items.filter(p => {
            const catLabel = (PW_CATS[p.Category] || {}).label || '';
            const hay = [p.SiteName, p.URL, p.LoginID, p.Note, catLabel].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(pwSearchKw);
        });
    }
    items.sort((a, b) => (a.SiteName || '').localeCompare(b.SiteName || '', 'ja'));

    if (items.length === 0) {
        list.innerHTML = '<div class="empty-state">' +
            (pwData.length === 0 ? 'まだ登録がありません。「+ 追加」から登録してください。' : '該当する項目がありません') +
            '</div>';
        return;
    }

    list.innerHTML = items.map(p => {
        const open = expandedPw.has(p.ID);
        const host = hostOf(p.URL);
        const urlHref = p.URL ? (/^https?:\/\//i.test(p.URL) ? p.URL : 'https://' + p.URL) : '';
        return `
        <div class="pw-card ${open ? 'open' : ''}" data-id="${p.ID}">
            <div class="pw-card-head" onclick="togglePwCard('${p.ID}')">
                <div class="pw-card-title">
                    ${catBadgeHtml(p.Category)}
                    <span class="pw-card-name">${escapeHtml(p.SiteName || '(名称未設定)')}</span>
                    ${host ? `<span class="pw-card-host">${escapeHtml(host)}</span>` : ''}
                </div>
                <span class="pw-card-chevron">${open ? '▲' : '▼'}</span>
            </div>
            <div class="pw-card-body" ${open ? '' : 'style="display:none;"'}>
                ${urlHref ? `
                <div class="pw-row">
                    <span class="pw-row-label">URL</span>
                    <a class="pw-row-value tbl-link" href="${escapeAttr(urlHref)}" target="_blank" rel="noopener">${escapeHtml(p.URL)}</a>
                </div>` : ''}
                <div class="pw-row">
                    <span class="pw-row-label">ID / メール</span>
                    <span class="pw-row-value pw-mono">${escapeHtml(p.LoginID || '—')}</span>
                    ${p.LoginID ? `<button class="pw-copy-btn" onclick="copyPwField('${escapeAttr(p.ID)}', 'LoginID', this)" title="コピー">コピー</button>` : ''}
                </div>
                ${isSocialLogin(p.LoginType) ? `
                <div class="pw-row">
                    <span class="pw-row-label">ログイン方法</span>
                    <span class="pw-login-type-badge" style="--lt-color:${LOGIN_TYPES[p.LoginType] ? LOGIN_TYPES[p.LoginType].color : '#888'}">${escapeHtml((LOGIN_TYPES[p.LoginType] || {}).label || p.LoginType)}</span>
                </div>` : `
                <div class="pw-row">
                    <span class="pw-row-label">パスワード</span>
                    <span class="pw-row-value pw-mono pw-secret" id="pw-secret-${p.ID}" data-revealed="false">${p.Password ? '••••••••' : '—'}</span>
                    ${p.Password ? `
                    <button class="pw-copy-btn" onclick="toggleSecret('${p.ID}', this)" title="表示切替">👁 表示</button>
                    <button class="pw-copy-btn" onclick="copyPwField('${escapeAttr(p.ID)}', 'Password', this)" title="コピー">コピー</button>` : ''}
                </div>`}
                ${p.Note ? `<div class="pw-row pw-row-note"><span class="pw-row-label">メモ</span><span class="pw-row-value pw-note-body">${noteToHtml(p.Note)}</span></div>` : ''}
                <div class="pw-card-actions">
                    <button class="tbl-btn" onclick="editPwEntry('${p.ID}')">編集</button>
                    <button class="tbl-btn tbl-btn-danger" onclick="deletePwEntry('${p.ID}')">削除</button>
                </div>
            </div>
        </div>`;
    }).join('');
}

function togglePwCard(id) {
    if (expandedPw.has(id)) expandedPw.delete(id);
    else expandedPw.add(id);
    renderPasswords();
}

function toggleSecret(id, btn) {
    const el = document.getElementById('pw-secret-' + id);
    if (!el) return;
    const p = pwData.find(x => x.ID === id);
    if (!p) return;
    const revealed = el.getAttribute('data-revealed') === 'true';
    if (revealed) {
        el.textContent = '••••••••';
        el.setAttribute('data-revealed', 'false');
        btn.textContent = '👁 表示';
    } else {
        el.textContent = p.Password || '';
        el.setAttribute('data-revealed', 'true');
        btn.textContent = '🙈 隠す';
    }
}

// シークレットは HTML 属性に出さず、ID と項目名から pwData を引いてコピーする。
// （以前は onclick に値を直書きしており、値に ' を含むと JS 文字列を抜け出して壊れる/実行される問題があった）
async function copyPwField(id, field, btn) {
    const p = pwData.find(x => x.ID === id);
    if (!p) return;
    const value = p[field] || '';
    try {
        await navigator.clipboard.writeText(value);
        const orig = btn.textContent;
        btn.textContent = '✓ コピー済';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch (_) {
        toast('コピーに失敗しました', 'error');
    }
}

function togglePwField(inputId, btn) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
    btn.textContent = el.type === 'password' ? '👁' : '🙈';
}

// ---- 追加 / 編集 モーダル ----

function openPwModal() {
    editingPwId = null;
    document.getElementById('pw-modal-title').textContent = 'パスワードを追加';
    document.getElementById('pw-f-category').value = 'other';
    document.getElementById('pw-f-logintype').value = 'normal';
    ['pw-f-name', 'pw-f-url', 'pw-f-loginid', 'pw-f-password', 'pw-f-note'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('pw-f-password').type = 'password';
    document.getElementById('pw-f-password-group').style.display = '';
    document.getElementById('pw-modal-edit').classList.remove('hidden');
    setTimeout(() => document.getElementById('pw-f-name').focus(), 50);
}

function editPwEntry(id) {
    const p = pwData.find(x => x.ID === id);
    if (!p) return;
    editingPwId = id;
    document.getElementById('pw-modal-title').textContent = 'パスワードを編集';
    document.getElementById('pw-f-category').value = p.Category || 'other';
    document.getElementById('pw-f-logintype').value = p.LoginType || 'normal';
    document.getElementById('pw-f-name').value = p.SiteName || '';
    document.getElementById('pw-f-url').value = p.URL || '';
    document.getElementById('pw-f-loginid').value = p.LoginID || '';
    document.getElementById('pw-f-password').value = p.Password || '';
    document.getElementById('pw-f-password').type = 'password';
    document.getElementById('pw-f-note').value = p.Note || '';
    // ソーシャルログインの場合はパスワード欄を非表示
    document.getElementById('pw-f-password-group').style.display = isSocialLogin(p.LoginType) ? 'none' : '';
    document.getElementById('pw-modal-edit').classList.remove('hidden');
}

function closePwModal() {
    document.getElementById('pw-modal-edit').classList.add('hidden');
}

async function savePwEntry() {
    const name = document.getElementById('pw-f-name').value.trim();
    if (!name) { toast('サービス名を入力してください', 'error'); return; }

    const existing = editingPwId ? pwData.find(p => p.ID === editingPwId) : null;
    const item = {
        ID: editingPwId || '',
        Category: document.getElementById('pw-f-category').value || 'other',
        SiteName: name,
        URL: document.getElementById('pw-f-url').value.trim(),
        LoginID: document.getElementById('pw-f-loginid').value.trim(),
        LoginType: document.getElementById('pw-f-logintype').value || 'normal',
        Password: isSocialLogin(document.getElementById('pw-f-logintype').value) ? '' : document.getElementById('pw-f-password').value,
        Note: document.getElementById('pw-f-note').value.trim()
    };
    if (editingPwId && existing) item._baseUpdatedAt = existing.UpdatedAt || '';

    try {
        const saved = await api.savePassword(item);
        if (editingPwId) {
            const idx = pwData.findIndex(p => p.ID === editingPwId);
            if (idx >= 0) pwData[idx] = saved;
        } else {
            pwData.push(saved);
            if (saved.ID) expandedPw.add(saved.ID);
        }
        renderPasswords();
        closePwModal();
        toast('保存しました', 'success');
    } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes('ADMIN_REQUIRED')) {
            toast('管理者認証が必要です', 'error');
            closePwModal();
            api.adminLogout();
            showAdminAuthModal(() => location.reload());
            return;
        }
        if (msg.includes('conflict')) {
            toast('他の人がこの項目を編集しました。最新を読み込みます。', 'error', 5000);
            closePwModal();
            await refreshData();
            return;
        }
        toast('保存失敗: ' + msg, 'error');
    }
}

async function deletePwEntry(id) {
    const p = pwData.find(x => x.ID === id);
    if (!p) return;
    if (!confirm(`「${p.SiteName}」を削除しますか？`)) return;

    const idx = pwData.findIndex(x => x.ID === id);
    const backup = pwData[idx];
    pwData.splice(idx, 1);
    expandedPw.delete(id);
    renderPasswords();

    try {
        await api.deletePassword(id);
        toast('削除しました', 'success', 2000);
    } catch (e) {
        pwData.splice(idx, 0, backup);
        renderPasswords();
        const msg = String(e.message || e);
        if (msg.includes('ADMIN_REQUIRED')) {
            toast('管理者認証が必要です', 'error');
            api.adminLogout();
            showAdminAuthModal(() => location.reload());
            return;
        }
        toast('削除失敗: ' + msg, 'error');
    }
}
