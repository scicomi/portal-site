/**
 * 実験内容ページ
 * カテゴリタブ（工作/実験ショー/その他）+ 検索。
 * 行クリックで詳細モーダルを開く。
 * 各実験に反省点・良かった点を記録可能。
 */

let expData = [];
let expCurrentTab = 'workshop';
let expSearchKw = '';
let currentExpId = null;
let editingExpId = null;

document.addEventListener('DOMContentLoaded', () => {
    bootPage('experiments', init);
});

async function init() {
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
        if (String(e).includes('unauthorized')) {
            api.clearToken(); api.clearAllCache();
            location.reload();
            return;
        }
        updateSyncStatus('error', null, e.message);
    }
}

let focusHandled = false;
function focusFromUrl() {
    if (focusHandled) return;
    const params = new URLSearchParams(location.search);
    const focusName = params.get('focus');
    if (!focusName) return;

    const match = expData.find(e => e.Name === focusName)
        || expData.find(e => (e.Name || '').toLowerCase() === focusName.toLowerCase());
    if (match) {
        focusHandled = true;
        switchExpTab(match.Category || 'other');
        viewExp(match.ID);
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
    document.querySelectorAll('.filter-chip[data-cat]').forEach(t =>
        t.classList.toggle('active', t.dataset.cat === cat)
    );
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

    let items = expData.filter(e => (e.Category || 'other') === expCurrentTab);

    if (expSearchKw) {
        items = items.filter(e => {
            const hay = [e.Name, e.Materials, e.Preparation, e.Flow, e.Notes, e.Reflections, e.Positives].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(expSearchKw);
        });
    }

    const tbody = document.getElementById('experiments-tbody');

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">該当する実験はありません</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(e => {
        const snippet = (e.Materials || '').split('\n').slice(0, 2).join(', ') || '-';
        const hasSlides = e.SlidesURL && e.SlidesURL.trim();
        const hasReview = (e.Reflections && e.Reflections.trim()) || (e.Positives && e.Positives.trim());
        return `
            <tr class="clickable-row" onclick="viewExp('${e.ID}')">
                <td class="cell-name">
                    ${escapeHtml(e.Name || '(無題)')}
                    ${hasReview ? '<span style="color:#10b981;margin-left:4px;font-size:0.75rem;" title="振り返りあり">memo</span>' : ''}
                </td>
                <td class="hide-mobile cell-snippet">${escapeHtml(snippet)}</td>
                <td class="hide-mobile">${hasSlides ? `<a href="${escapeAttr(e.SlidesURL)}" target="_blank" onclick="event.stopPropagation()" class="tbl-link">資料を開く</a>` : '-'}</td>
                <td class="cell-actions" onclick="event.stopPropagation()">
                    <button class="tbl-btn" onclick="editExp('${e.ID}')">編集</button>
                    <button class="tbl-btn tbl-btn-danger" onclick="deleteExp('${e.ID}')">削除</button>
                </td>
            </tr>
        `;
    }).join('');
}

// ---- 詳細モーダル ----
function viewExp(id) {
    const e = expData.find(x => x.ID === id);
    if (!e) return;
    currentExpId = id;

    document.getElementById('exp-detail-title').textContent = e.Name || '(無題)';
    const body = document.getElementById('exp-detail-body');

    const section = (title, content, isList) => {
        if (!content || !content.trim()) return '';
        const items = content.split('\n').map(s => s.trim()).filter(Boolean);
        const inner = isList
            ? `<ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
            : `<div class="exp-text">${escapeHtml(content)}</div>`;
        return `<div class="exp-detail-section"><h3>${title}</h3>${inner}</div>`;
    };

    const cat = getExperimentCategory(e.Category);
    body.innerHTML = `
        <div style="margin-bottom:12px;">
            <span class="cat-badge" style="background:${cat.color};">${escapeHtml(cat.label)}</span>
            ${e.SlidesURL ? ` &nbsp;<a class="tbl-link" href="${escapeAttr(e.SlidesURL)}" target="_blank">資料を開く</a>` : ''}
        </div>
        ${section('使用物品', e.Materials, true)}
        ${section('事前準備', e.Preparation, true)}
        ${section('発表の流れ', e.Flow, true)}
        ${section('注意事項', e.Notes, true)}
        ${(e.Positives && e.Positives.trim()) || (e.Reflections && e.Reflections.trim()) ? '<hr style="border:0;border-top:1px solid #eee;margin:20px 0;">' : ''}
        ${section('良かった点', e.Positives, false)}
        ${section('反省点', e.Reflections, false)}
    `;

    document.getElementById('exp-detail-modal').classList.remove('hidden');
}

function closeExpDetail() {
    document.getElementById('exp-detail-modal').classList.add('hidden');
    currentExpId = null;
}

function editCurrentExp() {
    if (!currentExpId) return;
    closeExpDetail();
    editExp(currentExpId);
}

function deleteCurrentExp() {
    if (!currentExpId) return;
    const id = currentExpId;
    closeExpDetail();
    deleteExp(id);
}

// ---- 編集モーダル ----
function openExpModal() {
    editingExpId = null;
    document.getElementById('exp-edit-title').textContent = '実験を追加';
    ['ex-name', 'ex-materials', 'ex-preparation', 'ex-flow', 'ex-notes', 'ex-slides', 'ex-positives', 'ex-reflections'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('ex-category').value = expCurrentTab;
    document.getElementById('exp-edit-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('ex-name').focus(), 50);
}

function editExp(id) {
    const e = expData.find(x => x.ID === id);
    if (!e) return;
    editingExpId = id;
    document.getElementById('exp-edit-title').textContent = '実験を編集';
    document.getElementById('ex-name').value = e.Name || '';
    document.getElementById('ex-category').value = e.Category || 'other';
    document.getElementById('ex-materials').value = e.Materials || '';
    document.getElementById('ex-preparation').value = e.Preparation || '';
    document.getElementById('ex-flow').value = e.Flow || '';
    document.getElementById('ex-notes').value = e.Notes || '';
    document.getElementById('ex-slides').value = e.SlidesURL || '';
    document.getElementById('ex-positives').value = e.Positives || '';
    document.getElementById('ex-reflections').value = e.Reflections || '';
    document.getElementById('exp-edit-modal').classList.remove('hidden');
}

function closeExpEdit() {
    document.getElementById('exp-edit-modal').classList.add('hidden');
}

async function saveExp() {
    const name = document.getElementById('ex-name').value.trim();
    if (!name) { toast('実験名を入力してください', 'error'); return; }

    const existing = editingExpId ? expData.find(x => x.ID === editingExpId) : null;
    const item = {
        ID: editingExpId || '',
        Name: name,
        Category: document.getElementById('ex-category').value,
        Materials: document.getElementById('ex-materials').value,
        Preparation: document.getElementById('ex-preparation').value,
        Flow: document.getElementById('ex-flow').value,
        Notes: document.getElementById('ex-notes').value,
        SlidesURL: document.getElementById('ex-slides').value.trim(),
        Positives: document.getElementById('ex-positives').value,
        Reflections: document.getElementById('ex-reflections').value,
        Active: existing ? (existing.Active || 'true') : 'true'
    };

    try {
        const saved = await api.save('experiments', item);
        if (editingExpId) {
            const idx = expData.findIndex(x => x.ID === editingExpId);
            if (idx >= 0) expData[idx] = saved;
        } else {
            expData.push(saved);
        }
        api.saveCache('experiments', expData);
        render();
        closeExpEdit();
        toast('保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
    }
}

function deleteExp(id) {
    const idx = expData.findIndex(x => x.ID === id);
    if (idx < 0) return;
    const backup = expData[idx];

    expData.splice(idx, 1);
    api.saveCache('experiments', expData);
    render();

    toastUndo(
        `「${backup.Name}」を削除しました`,
        () => {
            expData.splice(idx, 0, backup);
            api.saveCache('experiments', expData);
            render();
        },
        async () => {
            await api.delete('experiments', id);
            toast('削除を確定しました', 'success', 2000);
        },
        5000
    );
}
