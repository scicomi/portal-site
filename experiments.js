/**
 * 実験内容ページ
 * タブ: workshop（工作）/ show（実験ショー）/ other（その他）
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

function switchExpTab(cat) {
    expCurrentTab = cat;
    document.querySelectorAll('.exp-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === cat));
    render();
}

function onExpSearch() {
    expSearchKw = (document.getElementById('exp-search').value || '').toLowerCase();
    render();
}

function render() {
    // タブカウント
    document.getElementById('tab-cnt-workshop').textContent = expData.filter(e => e.Category === 'workshop').length;
    document.getElementById('tab-cnt-show').textContent = expData.filter(e => e.Category === 'show').length;
    document.getElementById('tab-cnt-other').textContent = expData.filter(e => e.Category === 'other').length;

    // タブのアイテム
    let items = expData.filter(e => (e.Category || 'other') === expCurrentTab);
    if (expSearchKw) {
        items = items.filter(e => {
            const hay = [e.Name, e.Materials, e.Preparation, e.Flow, e.Notes].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(expSearchKw);
        });
    }

    const grid = document.getElementById('exp-grid');
    if (items.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">🧪</div>該当する実験はありません</div>';
        return;
    }

    const catLabel = { workshop: '工作', show: 'ショー', other: 'その他' };

    grid.innerHTML = items.map(e => {
        const cat = e.Category || 'other';
        const snippet = (e.Materials || e.Notes || '物品・注意事項はまだ未入力').split('\n').slice(0, 3).join(' / ');
        const hasSlides = e.SlidesURL && e.SlidesURL.trim();
        return `
            <div class="exp-card ${cat}" onclick="viewExp('${e.ID}')">
                <div class="exp-card-header">
                    <span class="exp-card-title">${escapeHtml(e.Name || '(無題)')}</span>
                    <span class="exp-card-cat-badge">${catLabel[cat]}</span>
                </div>
                <div class="exp-card-body">
                    <div class="exp-snippet">${escapeHtml(snippet)}</div>
                    ${hasSlides ? `<div style="margin-top:8px;"><a class="exp-link" href="${escapeHtml(e.SlidesURL)}" target="_blank" onclick="event.stopPropagation()">📊 スライドを開く</a></div>` : ''}
                </div>
            </div>
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

    body.innerHTML = `
        <div style="margin-bottom:12px;">
            <span class="exp-card-cat-badge" style="background:${e.Category === 'workshop' ? '#10b981' : e.Category === 'show' ? '#f59e0b' : '#8b5cf6'};color:white;">
                ${e.Category === 'workshop' ? '🛠️ 工作' : e.Category === 'show' ? '🎭 実験ショー' : '✨ その他'}
            </span>
            ${e.SlidesURL ? ` &nbsp;<a class="exp-link" href="${escapeHtml(e.SlidesURL)}" target="_blank">📊 スライドを開く</a>` : ''}
        </div>
        ${section('📦 使用物品', e.Materials, true)}
        ${section('🔧 事前準備', e.Preparation, true)}
        ${section('📋 発表の流れ', e.Flow, true)}
        ${section('⚠️ 注意事項', e.Notes, true)}
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
    ['ex-name', 'ex-materials', 'ex-preparation', 'ex-flow', 'ex-notes', 'ex-slides'].forEach(id => {
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
    document.getElementById('exp-edit-modal').classList.remove('hidden');
}

function closeExpEdit() {
    document.getElementById('exp-edit-modal').classList.add('hidden');
}

async function saveExp() {
    const name = document.getElementById('ex-name').value.trim();
    if (!name) { toast('実験名を入力してください', 'error'); return; }

    const item = {
        ID: editingExpId || '',
        Name: name,
        Category: document.getElementById('ex-category').value,
        Materials: document.getElementById('ex-materials').value,
        Preparation: document.getElementById('ex-preparation').value,
        Flow: document.getElementById('ex-flow').value,
        Notes: document.getElementById('ex-notes').value,
        SlidesURL: document.getElementById('ex-slides').value.trim(),
        Active: 'true'
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

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
