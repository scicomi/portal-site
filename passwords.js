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
    bindOverlayClose(document.getElementById('pw-modal-edit'), closePwModal);
    // 検索窓（デバウンスのみ。このページは検索語自体が機微なため履歴・サジェストは付けない）
    attachSearchBox(document.getElementById('pw-search'), {
        onSearch: (v) => {
            pwSearchKw = (v || '').trim();
            renderPasswords();
        }
    });
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
    let html = '<button class="pw-cat-tab active" data-cat="" aria-pressed="true" data-action="pw-cat-filter">すべて</button>';
    Object.keys(PW_CATS).forEach(key => {
        const cat = PW_CATS[key];
        html += `<button class="pw-cat-tab" data-cat="${escapeAttr(key)}" aria-pressed="false" data-action="pw-cat-filter" style="--cat-color:${cat.color}">${escapeHtml(cat.label)}</button>`;
    });
    container.innerHTML = html;
}

// 描画した data-action の受け口(onclick 属性に ID・URL を埋め込まない。app.js の registerActions 参照)。
// URL を開く操作は、カード全体の開閉(pw-toggle-card)と衝突しないよう、最も内側の data-action だけが処理される。
registerActions({
    'pw-cat-filter': el => setPwCatFilter(el.dataset.cat || ''),
    'pw-toggle-card': el => togglePwCard(el.dataset.id),
    'pw-open-url': el => { const u = safeHttpUrl(el.dataset.url); if (u) window.open(u, '_blank', 'noopener'); },
    'pw-copy': el => copyPwField(el.dataset.id, el.dataset.field, el),
    'pw-toggle-secret': el => toggleSecret(el.dataset.id, el),
    'pw-edit': el => editPwEntry(el.dataset.id),
    'pw-delete': el => deletePwEntry(el.dataset.id)
});
// リンク(role=link の span)は Enter でも開く
document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const el = e.target.closest && e.target.closest('[data-action="pw-open-url"]');
    if (!el) return;
    e.preventDefault();
    const u = safeHttpUrl(el.dataset.url);
    if (u) window.open(u, '_blank', 'noopener');
});

function setPwCatFilter(cat) {
    pwCatFilter = cat;
    document.querySelectorAll('.pw-cat-tab').forEach(el => {
        const isActive = el.getAttribute('data-cat') === cat;
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-pressed', String(isActive));
    });
    renderPasswords();
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'initial-loading');
    // 機密のためキャッシュしない＝毎回サーバー取得なので、取得中であることを明示する
    document.getElementById('pw-list').innerHTML = '<div class="loading-text">読み込み中</div>';
    try {
        pwData = await api.listPasswords();
        renderPasswords();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        const msg = String(e.message || e);
        if (msg.includes('ADMIN_REQUIRED')) {
            api.adminLogout();
            showAdminGate();
            showAdminAuthModal(() => location.reload());
            return;
        }
        updateSyncStatus('error', null, msg);
        document.getElementById('pw-list').innerHTML = `<div class="empty-state">
            <div class="empty-text">データを読み込めませんでした</div>
            <div class="empty-hint">${escapeHtml(humanizeApiError(e))}</div>
            <button type="button" class="btn btn-secondary" onclick="refreshData(true)">再読み込み</button>
        </div>`;
    }
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
    // かな・全角半角の揺れ吸収 + AND/-除外/"フレーズ" で照合する（search.js）
    const pq = pwSearchKw ? parseSearchQuery(pwSearchKw) : null;
    if (pq) {
        items = items.filter(p => {
            const catLabel = (PW_CATS[p.Category] || {}).label || '';
            const hay = searchNormalize([p.SiteName, p.URL, p.LoginID, p.Note, catLabel].filter(Boolean).join(' '));
            return matchesParsedQuery(hay, pq);
        });
    }
    items.sort((a, b) => (a.SiteName || '').localeCompare(b.SiteName || '', 'ja'));

    if (items.length === 0) {
        list.innerHTML = pwData.length === 0
            ? `<div class="empty-state">
                <div class="empty-text">まだ登録がありません</div>
                <div class="empty-hint">右上の「＋ 追加」から登録できます</div>
            </div>`
            : `<div class="empty-state">
                <div class="empty-text">該当する項目がありません</div>
                <div class="empty-hint">検索キーワードやカテゴリを変更してみてください</div>
            </div>`;
        return;
    }

    list.innerHTML = items.map(p => {
        const open = expandedPw.has(p.ID);
        const host = hostOf(p.URL);
        const urlHref = safeHttpUrl(p.URL);
        const photos = parseJsonArray(p.Photos);
        const photo = photos.length > 0 ? photos[0] : null;
        const photoSrc = photo ? safeHttpUrl(fileImageUrl(photo, 200)) : '';   // http(s) 以外は表示しない
        return `
        <div class="pw-card ${open ? 'open' : ''}" data-id="${escapeAttr(p.ID)}">
            <button type="button" class="pw-card-head" aria-expanded="${open}" data-action="pw-toggle-card" data-id="${escapeAttr(p.ID)}">
                <div class="pw-card-title">
                    ${catBadgeHtml(p.Category)}
                    <span class="pw-card-name">${escapeHtml(p.SiteName || '(名称未設定)')}</span>
                    ${urlHref ? `<span class="pw-card-link" role="link" tabindex="0" title="${escapeAttr(host || p.URL)} を開く"
                        data-action="pw-open-url" data-url="${escapeAttr(urlHref)}">&#x2197;</span>` : ''}
                </div>
                <span class="pw-card-chevron">${open ? '▲' : '▼'}</span>
            </button>
            <div class="pw-card-body" ${open ? '' : 'style="display:none;"'}>
                <div class="pw-row">
                    <span class="pw-row-label">ID / メール</span>
                    <span class="pw-row-value pw-mono">${escapeHtml(p.LoginID || '—')}</span>
                    ${p.LoginID ? `<button class="pw-copy-btn" data-action="pw-copy" data-id="${escapeAttr(p.ID)}" data-field="LoginID" title="コピー">コピー</button>` : ''}
                </div>
                ${isSocialLogin(p.LoginType) ? `
                <div class="pw-row">
                    <span class="pw-row-label">ログイン方法</span>
                    <span class="pw-login-type-badge" style="--lt-color:${LOGIN_TYPES[p.LoginType] ? LOGIN_TYPES[p.LoginType].color : '#888'}">${escapeHtml((LOGIN_TYPES[p.LoginType] || {}).label || p.LoginType)}</span>
                </div>` : `
                <div class="pw-row">
                    <span class="pw-row-label">パスワード</span>
                    <span class="pw-row-value pw-mono pw-secret" id="pw-secret-${escapeAttr(p.ID)}" data-revealed="false">${p.Password ? '••••••••' : '—'}</span>
                    ${p.Password ? `
                    <button class="pw-copy-btn" data-action="pw-toggle-secret" data-id="${escapeAttr(p.ID)}" title="表示切替">表示</button>
                    <button class="pw-copy-btn" data-action="pw-copy" data-id="${escapeAttr(p.ID)}" data-field="Password" title="コピー">コピー</button>` : ''}
                </div>`}
                ${p.Note ? `<div class="pw-row pw-row-note"><span class="pw-row-label">メモ</span><span class="pw-row-value pw-note-body">${noteToHtml(p.Note)}</span></div>` : ''}
                ${photoSrc ? `<div class="pw-row pw-row-photo">
                    <span class="pw-row-label">写真</span>
                    ${safeHttpUrl(photo.url) ? `<a href="${escapeAttr(safeHttpUrl(photo.url))}" target="_blank" rel="noopener" title="${escapeAttr(photo.name || '')}">` : '<span>'}
                        <img class="pw-photo-thumb" src="${escapeAttr(photoSrc)}" alt="${escapeAttr(photo.name || '')}" loading="lazy" referrerpolicy="no-referrer">
                    ${safeHttpUrl(photo.url) ? '</a>' : '</span>'}
                </div>` : ''}
                <div class="pw-card-actions">
                    <button class="tbl-btn" data-action="pw-edit" data-id="${escapeAttr(p.ID)}">編集</button>
                    <button class="tbl-btn tbl-btn-danger" data-action="pw-delete" data-id="${escapeAttr(p.ID)}">削除</button>
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
        btn.textContent = '表示';
    } else {
        el.textContent = p.Password || '';
        el.setAttribute('data-revealed', 'true');
        btn.textContent = '隠す';
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
    btn.textContent = el.type === 'password' ? '表示' : '隠す';
}

// ---- 追加 / 編集 モーダル（Step 1: 基本情報 / Step 2: 認証情報・写真） ----

let pwWizardStep = 0;
let pwEditingPhotos = []; // [{name,url,driveId}] 最大1枚
// R2 の孤児を残さないための管理（モーダルを開くたびに初期化）
let pwSessionUploads = [];  // このモーダルでアップロードして、まだ保存していないファイルの driveId
let pwPhotosToDelete = [];  // 保存済みの写真を外した分。保存に成功してから R2 の実体を消す
let pwModalSession = 0;     // モーダルを開いた回数。アップロード中に閉じられたかの判定用

function pwWizardSetStep(step) {
    pwWizardStep = step;
    document.querySelectorAll('#pw-modal-edit [data-pw-step]').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.pwStep, 10) === step);
    });
    document.querySelectorAll('#pw-modal-edit [data-pw-dot]').forEach(el => {
        const i = parseInt(el.dataset.pwDot, 10);
        el.classList.toggle('active', i === step);
        el.classList.toggle('done', i < step);
    });
    document.querySelectorAll('#pw-modal-edit [data-pw-line]').forEach(el => {
        el.classList.toggle('done', step >= 1);
    });
    document.getElementById('pw-f-back-btn').style.display = step > 0 ? '' : 'none';
    document.getElementById('pw-f-next-btn').textContent = step === 1 ? '保存' : '次へ';
}

// 進捗ドットのクリックで任意のステップへ移動（イベントウィザードと同様、入力チェックはしない）
function pwWizardGoto(step) {
    pwWizardSetStep(step);
}

function pwWizardNext() {
    if (pwWizardStep === 0) {
        const name = document.getElementById('pw-f-name').value.trim();
        if (!name) { toast('サービス名を入力してください', 'error'); document.getElementById('pw-f-name').focus(); return; }
        pwWizardSetStep(1);
    } else {
        savePwEntry();
    }
}

function pwWizardBack() {
    pwWizardSetStep(0);
}

function renderPwPhotoPreview() {
    const wrap = document.getElementById('pw-f-photo-preview');
    const img = document.getElementById('pw-f-photo-img');
    const btn = document.getElementById('pw-f-photo-btn');
    const has = pwEditingPhotos.length > 0;
    wrap.classList.toggle('hidden', !has);
    if (has) {
        const p = pwEditingPhotos[0];
        img.src = fileImageUrl(p, 400);
    }
    btn.classList.toggle('hidden', has);
}

async function handlePwPhotoSelect(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > getFileMaxMB() * 1024 * 1024) { toast(file.name + ' は' + getFileMaxMB() + 'MBを超えています', 'error'); return; }
    toast('アップロード中: ' + file.name, 'info', 2000);
    const session = pwModalSession;
    try {
        const result = await api.uploadFile(file);
        if (session !== pwModalSession || document.getElementById('pw-modal-edit').classList.contains('hidden')) {
            // アップロード中にモーダルが閉じられた（または開き直された）。結果は捨て、実体も消す
            deleteStoredFiles([result.driveId]);
            return;
        }
        pwEditingPhotos = [{ name: file.name, url: result.url, driveId: result.driveId }];
        if (result.driveId) pwSessionUploads.push(result.driveId);
        renderPwPhotoPreview();
    } catch (e) {
        if (session === pwModalSession) toast('アップロード失敗: ' + e.message, 'error');
    }
}

function removePwPhoto() {
    pwEditingPhotos.forEach(p => {
        if (!p.driveId) return;
        const si = pwSessionUploads.indexOf(p.driveId);
        if (si >= 0) {
            // このモーダルでアップロードしたばかりの写真は、その場で実体も消す
            pwSessionUploads.splice(si, 1);
            deleteStoredFiles([p.driveId]);
        } else {
            // 保存済みの写真は、保存に成功してから実体を消す（キャンセルすれば元に戻るため）
            pwPhotosToDelete.push(p.driveId);
        }
    });
    pwEditingPhotos = [];
    renderPwPhotoPreview();
}

function openPwModal() {
    editingPwId = null;
    pwEditingPhotos = [];
    pwSessionUploads = [];
    pwPhotosToDelete = [];
    pwModalSession++;
    document.getElementById('pw-modal-title').textContent = 'パスワードを追加';
    document.getElementById('pw-f-category').value = 'other';
    document.getElementById('pw-f-logintype').value = 'normal';
    ['pw-f-name', 'pw-f-url', 'pw-f-loginid', 'pw-f-password', 'pw-f-note'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('pw-f-password').type = 'password';
    document.getElementById('pw-f-password-group').style.display = '';
    renderPwPhotoPreview();
    pwWizardSetStep(0);
    const modal = document.getElementById('pw-modal-edit');
    modal.classList.remove('hidden');
    bindModalEscape(modal, closePwModal);
    // Tab がモーダル外へ抜けないよう閉じ込める（静的モーダルなので一度だけ束縛）
    if (!modal._trapBound) { trapFocus(modal.querySelector('.wizard-panel')); modal._trapBound = true; }
    setTimeout(() => document.getElementById('pw-f-name').focus(), 50);
}

function editPwEntry(id) {
    const p = pwData.find(x => x.ID === id);
    if (!p) return;
    editingPwId = id;
    pwEditingPhotos = parseJsonArray(p.Photos);
    pwSessionUploads = [];
    pwPhotosToDelete = [];
    pwModalSession++;
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
    renderPwPhotoPreview();
    pwWizardSetStep(0);
    const modal = document.getElementById('pw-modal-edit');
    modal.classList.remove('hidden');
    bindModalEscape(modal, closePwModal);
    // 編集時はこれまでフォーカスがモーダル外に残っていたので、内側へ移し Tab も閉じ込める
    if (!modal._trapBound) { trapFocus(modal.querySelector('.wizard-panel')); modal._trapBound = true; }
    setTimeout(() => document.getElementById('pw-f-name').focus(), 50);
}

// 保存せずに閉じたときは、このモーダルでアップロードした未保存の写真を R2 から消す（保存成功時は空になっている）。
function closePwModal() {
    document.getElementById('pw-modal-edit').classList.add('hidden');
    if (pwSessionUploads.length > 0) deleteStoredFiles(pwSessionUploads);
    pwSessionUploads = [];
    pwPhotosToDelete = [];
}

async function savePwEntry() {
    const name = document.getElementById('pw-f-name').value.trim();
    if (!name) { toast('サービス名を入力してください', 'error'); document.getElementById('pw-f-name').focus(); return; }

    const saveBtn = document.getElementById('pw-f-next-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

    const existing = editingPwId ? pwData.find(p => p.ID === editingPwId) : null;
    const item = {
        ID: editingPwId || '',
        Category: document.getElementById('pw-f-category').value || 'other',
        SiteName: name,
        URL: document.getElementById('pw-f-url').value.trim(),
        LoginID: document.getElementById('pw-f-loginid').value.trim(),
        LoginType: document.getElementById('pw-f-logintype').value || 'normal',
        Password: isSocialLogin(document.getElementById('pw-f-logintype').value) ? '' : document.getElementById('pw-f-password').value,
        Note: document.getElementById('pw-f-note').value.trim(),
        Photos: JSON.stringify(pwEditingPhotos)
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
        // 保存できたので、残した写真は消さない。外した保存済みの写真は、サーバーがゴミ箱へ移す（実体は期限まで残る）
        pwSessionUploads = [];
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
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
    }
}

function deletePwEntry(id) {
    const p = pwData.find(x => x.ID === id);
    if (!p) return;
    // 他ページと同じ確認ダイアログ（ネイティブ confirm は使わない）
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <h3>「${escapeHtml(p.SiteName || '(名称未設定)')}」を削除</h3>
            <p>このログイン情報を削除しますか？この操作は取り消せません。</p>
            <div class="confirm-dialog-actions">
                <button class="btn btn-secondary" onclick="this.closest('.confirm-dialog-overlay').remove()">キャンセル</button>
                <button class="btn btn-danger" id="confirm-pw-del-btn">削除する</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    bindModalEscape(overlay, () => overlay.remove());
    overlay.querySelector('#confirm-pw-del-btn').onclick = () => {
        overlay.remove();
        executeDeletePwEntry(id);
    };
}

async function executeDeletePwEntry(id) {
    const idx = pwData.findIndex(x => x.ID === id);
    if (idx < 0) return;
    const backup = pwData[idx];
    pwData.splice(idx, 1);
    expandedPw.delete(id);
    renderPasswords();

    try {
        await api.deletePassword(id);
        toast('ゴミ箱に移動しました（管理者の「ゴミ箱」から戻せます）', 'success', 3000);
        // 添付の写真（QR・スクリーンショット等）は、ゴミ箱の期限まで R2 に残る（公開 URL のまま）。今すぐ消すにはゴミ箱から完全に削除する
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
