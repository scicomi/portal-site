/**
 * 実験内容ページ
 * カテゴリタブ（工作/実験ショー/その他）+ 検索。
 * 行クリックで詳細ページへ遷移。行ホバーで編集・削除ボタン表示。
 * 新規作成・編集はステップウィザード形式。
 */

let expData = [];
let expCurrentTab = 'workshop';
let expSearchKw = '';
let editingExpId = null;
let wizardStep = 0;

const EXP_WIZARD_STEPS = [
    { label: '基本情報', fields: ['name', 'category'] },
    { label: '準備', fields: ['materials', 'preparation'] },
    { label: '実施・その他', fields: ['flow', 'notes', 'slides'] }
];

document.addEventListener('DOMContentLoaded', () => {
    bootPage('experiments', init);
});

function _bindExpTableDelegation() {
    const tbody = document.getElementById('experiments-tbody');
    if (!tbody) return;
    tbody.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
            const action = actionEl.dataset.action;
            if (action === 'slides' || action === 'open') return; // <a> のデフォルト遷移に任せる
            e.stopPropagation();
            const row = actionEl.closest('tr[data-id]');
            if (!row) return;
            const id = row.dataset.id;
            if (action === 'edit') openExpWizard(id);
            else if (action === 'delete') confirmDeleteExp(id);
            return;
        }
        if (e.target.closest('[data-action-cell]')) return;
        const row = e.target.closest('tr[data-id]');
        if (row) goToDetail(row.dataset.id);
    });
}

async function init() {
    _bindExpTableDelegation();

    const cached = api.loadCache('experiments');
    if (cached && cached.items) {
        expData = cached.items;
        render();
        focusFromUrl();
    }
    updateSyncStatus(cached ? 'cached' : 'initial-loading', cached ? cached.timestamp : null);
    await refreshData();
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
    try {
        expData = await api.list('experiments');
        api.saveCache('experiments', expData);
        render();
        focusFromUrl();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
        // キャッシュも無く一覧が空のままなら、「読み込み中」を残さずエラー＋再試行を表示
        if (expData.length === 0) {
            const tbody = document.getElementById('experiments-tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="empty-state">
                <div class="empty-text">データを読み込めませんでした</div>
                <div class="empty-hint">${escapeHtml(humanizeApiError(e))}</div>
                <button type="button" class="btn btn-secondary" onclick="refreshData(true)">再読み込み</button>
            </td></tr>`;
        }
    }
}

let focusHandled = false;
function focusFromUrl() {
    if (focusHandled) return;
    const params = new URLSearchParams(location.search);

    const editId = params.get('edit');
    if (editId) {
        const match = expData.find(e => e.ID === editId);
        if (match) {
            focusHandled = true;
            switchExpTab(match.Category || 'other');
            openExpWizard(match.ID);
        }
        return;
    }

    const focusName = params.get('focus');
    if (!focusName) return;

    const match = expData.find(e => e.Name === focusName)
        || expData.find(e => (e.Name || '').toLowerCase() === focusName.toLowerCase());
    if (match) {
        focusHandled = true;
        // 詳細の閲覧は実験詳細ページへ一本化（行クリックと同じ導線）
        goToDetail(match.ID);
    } else {
        const searchEl = document.getElementById('exp-search');
        if (searchEl) {
            searchEl.value = focusName;
            onExpSearch();
            toast(`「${focusName}」に一致する実験が見つかりませんでした`, 'info', 4000);
            focusHandled = true;
        }
    }
}

function switchExpTab(cat) {
    expCurrentTab = cat;
    document.querySelectorAll('.filter-chip[data-cat]').forEach(t => {
        const isActive = t.dataset.cat === cat;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-pressed', String(isActive));
    });
    render();
}

function onExpSearch() {
    expSearchKw = (document.getElementById('exp-search').value || '').toLowerCase();
    render();
}

function render() {
    document.getElementById('tab-cnt-workshop').textContent = expData.filter(e => e.Category === 'workshop').length;
    document.getElementById('tab-cnt-show').textContent = expData.filter(e => e.Category === 'show').length;
    document.getElementById('tab-cnt-other').textContent = expData.filter(e => e.Category === 'other').length;

    let items;
    if (expSearchKw) {
        items = expData.filter(e => {
            const hay = [e.Name, e.Materials, e.Preparation, e.Flow, e.Notes, e.Reflections, e.Positives].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(expSearchKw);
        });
    } else {
        items = expData.filter(e => (e.Category || 'other') === expCurrentTab);
    }

    const tbody = document.getElementById('experiments-tbody');

    if (items.length === 0) {
        // 検索中とタブが空の場合で文言を分ける（検索は全カテゴリ横断のため）
        tbody.innerHTML = expSearchKw
            ? `<tr><td colspan="4" class="empty-state">
                <span class="empty-icon">&#x1F52C;</span>
                <span class="empty-text">該当する実験はありません</span>
                <span class="empty-hint">検索キーワードを変更してみてください</span>
            </td></tr>`
            : `<tr><td colspan="4" class="empty-state">
                <span class="empty-icon">&#x1F52C;</span>
                <span class="empty-text">このカテゴリには実験がまだありません</span>
                <span class="empty-hint">右下の＋ボタンから追加できます</span>
            </td></tr>`;
        return;
    }

    // 削除ボタンは全員に表示し、非管理者はタップ時に管理者認証を挟む（メンバーページと表示ルールを統一）
    tbody.innerHTML = items.map(e => {
        const snippet = (e.Materials || '').split('\n').slice(0, 2).join(', ') || '-';
        const safeSlides = safeHttpUrl(e.SlidesURL);
        const fbCount = countFeedback(e);
        return `
            <tr class="clickable-row" data-id="${escapeAttr(e.ID)}">
                <td class="cell-name">
                    <a href="experiment-detail.html?id=${encodeURIComponent(e.ID)}" data-action="open" style="color:inherit;text-decoration:none;">${escapeHtml(e.Name || '(無題)')}</a>
                    ${fbCount > 0 ? `<span class="badge-fb-count" title="振り返り ${fbCount}件">${fbCount}件</span>` : ''}
                </td>
                <td class="hide-mobile cell-snippet">${escapeHtml(snippet)}</td>
                <td class="hide-mobile">${safeSlides ? `<a href="${escapeAttr(safeSlides)}" target="_blank" rel="noopener" data-action="slides" class="tbl-link">資料を開く</a>` : '-'}</td>
                <td data-action-cell>
                    <div class="inline-actions">
                        <button class="inline-action-btn" data-action="edit" title="編集">&#9998;</button>
                        <button class="inline-action-btn danger" data-action="delete" title="削除">&#x2715;</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function goToDetail(id) {
    location.href = 'experiment-detail.html?id=' + encodeURIComponent(id);
}

function countFeedback(e) {
    const pos = parseFeedbackEntries(e.Positives);
    const ref = parseFeedbackEntries(e.Reflections);
    return pos.length + ref.length;
}

// ※ 簡易プレビューモーダルは廃止。詳細の閲覧は experiment-detail.html へ一本化した
//   （行クリック・?focus= のどちらも同じ導線になる）。

// ---- ウィザード形式の新規作成・編集 ----

function openExpWizard(editId) {
    editingExpId = editId || null;
    wizardStep = 0;

    const e = editingExpId ? expData.find(x => x.ID === editingExpId) : null;
    const isEdit = !!e;

    const overlay = document.createElement('div');
    overlay.id = 'exp-wizard-overlay';
    overlay.className = 'wizard-overlay';

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true">
            <div class="wizard-header">
                <h2 class="wizard-title">${isEdit ? '実験を編集' : '実験を追加'}</h2>
                <p class="wizard-subtitle">${isEdit ? e.Name : 'ステップに沿って入力してください'}</p>
            </div>
            <div class="wizard-progress">
                ${EXP_WIZARD_STEPS.map((s, i) => `
                    ${i > 0 ? '<div class="wizard-step-line" data-line="' + i + '"></div>' : ''}
                    <div class="wizard-step-dot${i === 0 ? ' active' : ''}" data-dot="${i}" title="${s.label}">${i + 1}</div>
                `).join('')}
            </div>
            <div class="wizard-body">
                <!-- Step 1: 基本情報 -->
                <div class="wizard-step active" data-step="0">
                    <div class="wizard-step-label">Step 1 / ${EXP_WIZARD_STEPS.length} &mdash; ${EXP_WIZARD_STEPS[0].label}</div>
                    <div class="e1-group">
                        <label class="e1-label">実験名 *</label>
                        <input id="wz-ex-name" class="e1-input" type="text" placeholder="例: スライム" value="${escapeAttr(e ? e.Name : '')}">
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">カテゴリ</label>
                        <select id="wz-ex-category" class="e1-input">
                            <option value="workshop" ${(e ? e.Category : expCurrentTab) === 'workshop' ? 'selected' : ''}>工作</option>
                            <option value="show" ${(e ? e.Category : expCurrentTab) === 'show' ? 'selected' : ''}>実験ショー</option>
                            <option value="other" ${(e ? e.Category : expCurrentTab) === 'other' ? 'selected' : ''}>その他</option>
                        </select>
                    </div>
                </div>

                <!-- Step 2: 準備 -->
                <div class="wizard-step" data-step="1">
                    <div class="wizard-step-label">Step 2 / ${EXP_WIZARD_STEPS.length} &mdash; ${EXP_WIZARD_STEPS[1].label}</div>
                    <div class="e1-group">
                        <label class="e1-label">使用物品（1行1つ）</label>
                        <textarea id="wz-ex-materials" class="e1-input" rows="5" placeholder="アルギン酸ナトリウム&#10;乳酸カルシウム&#10;...">${escapeHtml(e ? e.Materials : '')}</textarea>
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">事前準備</label>
                        <textarea id="wz-ex-preparation" class="e1-input" rows="4" placeholder="前日にやること、当日朝にやることなど">${escapeHtml(e ? e.Preparation : '')}</textarea>
                    </div>
                </div>

                <!-- Step 3: 実施・その他 -->
                <div class="wizard-step" data-step="2">
                    <div class="wizard-step-label">Step 3 / ${EXP_WIZARD_STEPS.length} &mdash; ${EXP_WIZARD_STEPS[2].label}</div>
                    <div class="e1-group">
                        <label class="e1-label">発表の流れ</label>
                        <textarea id="wz-ex-flow" class="e1-input" rows="4" placeholder="導入 → 説明 → 実演 → 体験">${escapeHtml(e ? e.Flow : '')}</textarea>
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">注意事項</label>
                        <textarea id="wz-ex-notes" class="e1-input" rows="3" placeholder="安全面で気をつけることなど">${escapeHtml(e ? e.Notes : '')}</textarea>
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">スライド/資料URL</label>
                        <input id="wz-ex-slides" class="e1-input" type="text" placeholder="https://..." value="${escapeAttr(e ? (e.SlidesURL || '') : '')}">
                    </div>
                </div>
            </div>
            <div class="wizard-footer">
                ${isEdit ? '<button class="btn btn-danger" onclick="deleteFromWizard()">削除</button>' : ''}
                <div class="wizard-footer-spacer"></div>
                <button class="btn btn-text" onclick="closeExpWizard()">キャンセル</button>
                <button id="wz-prev-btn" class="btn btn-secondary" onclick="wizardPrev()" style="display:none;">戻る</button>
                <button id="wz-next-btn" class="btn btn-primary" onclick="wizardNext()">次へ</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    // 領域外クリック・Esc は、入力に変更があれば破棄確認を挟む（誤タップで編集内容が消えないように）
    bindEditDismissGuard(overlay, closeExpWizard);
    trapFocus(overlay.querySelector('.wizard-panel'));
    // テキスト入力中に Enter で次のステップへ（textarea は改行を優先）
    overlay.querySelector('.wizard-body').addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || ev.isComposing) return;
        if (ev.target.tagName === 'TEXTAREA') return;
        ev.preventDefault();
        wizardNext();
    });
    setTimeout(() => document.getElementById('wz-ex-name').focus(), 80);
}

function closeExpWizard() {
    const overlay = document.getElementById('exp-wizard-overlay');
    if (overlay) overlay.remove();
    editingExpId = null;
    wizardStep = 0;
}

function updateWizardUI() {
    const total = EXP_WIZARD_STEPS.length;
    const isLast = wizardStep === total - 1;

    document.querySelectorAll('#exp-wizard-overlay .wizard-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === wizardStep);
    });

    document.querySelectorAll('#exp-wizard-overlay .wizard-step-dot').forEach(el => {
        const i = parseInt(el.dataset.dot);
        el.classList.toggle('active', i === wizardStep);
        el.classList.toggle('done', i < wizardStep);
    });
    document.querySelectorAll('#exp-wizard-overlay .wizard-step-line').forEach(el => {
        const i = parseInt(el.dataset.line);
        el.classList.toggle('done', i <= wizardStep);
    });

    const prevBtn = document.getElementById('wz-prev-btn');
    const nextBtn = document.getElementById('wz-next-btn');
    if (prevBtn) prevBtn.style.display = wizardStep > 0 ? '' : 'none';
    if (nextBtn) nextBtn.textContent = isLast ? '保存' : '次へ';
}

function wizardPrev() {
    if (wizardStep > 0) {
        wizardStep--;
        updateWizardUI();
    }
}

function wizardNext() {
    const total = EXP_WIZARD_STEPS.length;

    if (wizardStep === 0) {
        const name = document.getElementById('wz-ex-name').value.trim();
        if (!name) {
            toast('実験名を入力してください', 'error');
            document.getElementById('wz-ex-name').focus();
            return;
        }
    }

    if (wizardStep < total - 1) {
        wizardStep++;
        updateWizardUI();
        const step = document.querySelector('#exp-wizard-overlay .wizard-step.active');
        if (step) {
            const firstInput = step.querySelector('input, textarea, select');
            if (firstInput) setTimeout(() => firstInput.focus(), 100);
        }
    } else {
        saveExp();
    }
}

async function saveExp() {
    const name = document.getElementById('wz-ex-name').value.trim();
    if (!name) { toast('実験名を入力してください', 'error'); return; }

    const existing = editingExpId ? expData.find(x => x.ID === editingExpId) : null;
    const isNew = !editingExpId;
    const item = {
        ID: editingExpId || genId('ex_'),
        Name: name,
        Category: document.getElementById('wz-ex-category').value,
        Materials: document.getElementById('wz-ex-materials').value,
        Preparation: document.getElementById('wz-ex-preparation').value,
        Flow: document.getElementById('wz-ex-flow').value,
        Notes: document.getElementById('wz-ex-notes').value,
        SlidesURL: document.getElementById('wz-ex-slides').value.trim(),
        Positives: existing ? existing.Positives : '',
        Reflections: existing ? existing.Reflections : '',
        Active: existing ? (existing.Active || 'true') : 'true'
    };

    if (editingExpId && existing) item._baseUpdatedAt = existing.UpdatedAt || '';

    const snapshot = JSON.parse(JSON.stringify(expData));

    if (isNew) {
        expData.push({ ...item });
    } else {
        const idx = expData.findIndex(x => x.ID === editingExpId);
        if (idx >= 0) expData[idx] = { ...expData[idx], ...item };
    }
    api.saveCache('experiments', expData);
    render();
    closeExpWizard();
    toast('保存しました', 'success');

    api.save('experiments', item).then(saved => {
        const idx = expData.findIndex(x => x.ID === item.ID);
        if (idx >= 0) expData[idx] = saved;
        api.saveCache('experiments', expData);
    }).catch(e => {
        expData.splice(0, expData.length, ...snapshot);
        api.saveCache('experiments', expData);
        render();
        if (String(e.message).includes('conflict')) {
            toast('他の人がこの実験を編集しました。最新を読み込みます。', 'error', 5000);
            refreshData();
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    });
}

// ---- 削除（ウィザード内から） ----
function deleteFromWizard() {
    if (!editingExpId) return;
    const id = editingExpId;
    closeExpWizard();
    confirmDeleteExp(id);
}

// ---- 削除（確認ダイアログ） ----
function confirmDeleteExp(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => confirmDeleteExp(id));
        return;
    }
    const e = expData.find(x => x.ID === id);
    if (!e) return;
    showConfirmDialog({
        title: `「${e.Name}」を削除`,
        message: 'この操作は元に戻せます（削除直後のみ）。',
        okLabel: '削除する',
        danger: true,
        onOk: () => deleteExp(id)
    });
}

async function deleteExp(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => deleteExp(id));
        return;
    }
    const idx = expData.findIndex(x => x.ID === id);
    if (idx < 0) return;
    const backup = expData[idx];

    expData.splice(idx, 1);
    api.saveCache('experiments', expData);
    render();

    try {
        await api.delete('experiments', id);
    } catch (e) {
        expData.splice(idx, 0, backup);
        api.saveCache('experiments', expData);
        render();
        toast('削除失敗: ' + e.message, 'error');
        return;
    }

    toastUndo(
        `「${backup.Name}」を削除しました`,
        async () => {
            try {
                const saved = await api.save('experiments', backup);
                expData.push(saved);
                api.saveCache('experiments', expData);
                render();
                toast('元に戻しました', 'success', 2000);
            } catch (e) {
                toast('復元に失敗しました: ' + e.message, 'error');
            }
        },
        () => {},
        5000
    );
}
