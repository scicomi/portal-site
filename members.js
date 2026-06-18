/**
 * メンバーリストページ
 * 3カテゴリ: adviser / coordinator / member
 */

let membersData = [];
let memberSearchKw = '';
let editingMemberId = null;

document.addEventListener('DOMContentLoaded', () => {
    bootPage('members', init);
});

async function init() {
    const cached = api.loadCache('members');
    if (cached && cached.items) {
        membersData = cached.items;
        renderMembers();
    }
    updateSyncStatus(cached ? 'cached' : 'initial-loading', cached ? cached.timestamp : null);

    await refreshData();
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
    try {
        membersData = await api.list('members');
        api.saveCache('members', membersData);
        renderMembers();
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

function onMemberSearch() {
    memberSearchKw = (document.getElementById('member-search').value || '').toLowerCase();
    renderMembers();
}

function renderMembers() {
    const filtered = memberSearchKw
        ? membersData.filter(m => {
            const hay = [m.Name, m.Role, m.Affiliation, m.StudentID, m.Note].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(memberSearchKw);
        })
        : membersData;

    const advisers = filtered.filter(m => m.Category === 'adviser');
    const coordinators = filtered.filter(m => m.Category === 'coordinator');
    const regulars = filtered.filter(m => m.Category === 'member' || !m.Category);

    renderCategoryGrid('adviser-grid', advisers, 'adviser');
    renderCategoryGrid('coordinator-grid', coordinators, 'coordinator');
    renderCategoryGrid('member-grid', regulars, 'member');

    document.getElementById('adviser-count').textContent = advisers.length + '名';
    document.getElementById('coordinator-count').textContent = coordinators.length + '名';
    document.getElementById('member-count').textContent = regulars.length + '名';
}

function renderCategoryGrid(elId, items, cat) {
    const el = document.getElementById(elId);
    if (items.length === 0) {
        el.innerHTML = '<div class="empty-state" style="grid-column:1/-1;padding:20px;">該当者なし</div>';
        return;
    }
    // 役職持ちを上に
    const sorted = items.slice().sort((a, b) => {
        if (a.Role && !b.Role) return -1;
        if (!a.Role && b.Role) return 1;
        return (b.Year || '').localeCompare(a.Year || ''); // 学年降順
    });
    el.innerHTML = sorted.map(m => `
        <div class="member-card ${cat}" data-id="${m.ID}">
            <div class="member-name">${escapeHtml(m.Name || '')}</div>
            ${m.Role ? `<div class="member-role">⭐ ${escapeHtml(m.Role)}</div>` : ''}
            <div class="member-meta">
                ${m.Year ? `${escapeHtml(m.Year)}年 ` : ''}
                ${m.StudentID ? `<span style="color:#999;">${escapeHtml(m.StudentID)}</span>` : ''}
            </div>
            ${m.Affiliation ? `<div class="member-meta">📍 ${escapeHtml(m.Affiliation)}</div>` : ''}
            ${m.Note ? `<div class="member-meta">📝 ${escapeHtml(m.Note)}</div>` : ''}
            <div class="member-actions">
                <button onclick="editMember('${m.ID}')">✏️ 編集</button>
                <button class="del-btn" onclick="deleteMember('${m.ID}')">🗑️ 削除</button>
            </div>
        </div>
    `).join('');
}

// ---- モーダル制御 ----
function openMemberModal() {
    editingMemberId = null;
    document.getElementById('member-modal-title').textContent = 'メンバー追加';
    ['mb-name', 'mb-role', 'mb-student-id', 'mb-year', 'mb-affiliation', 'mb-note'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('mb-category').value = 'member';
    document.getElementById('member-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('mb-name').focus(), 50);
}

function editMember(id) {
    const m = membersData.find(x => x.ID === id);
    if (!m) return;
    editingMemberId = id;
    document.getElementById('member-modal-title').textContent = 'メンバー編集';
    document.getElementById('mb-name').value = m.Name || '';
    document.getElementById('mb-category').value = m.Category || 'member';
    document.getElementById('mb-role').value = m.Role || '';
    document.getElementById('mb-student-id').value = m.StudentID || '';
    document.getElementById('mb-year').value = m.Year || '';
    document.getElementById('mb-affiliation').value = m.Affiliation || '';
    document.getElementById('mb-note').value = m.Note || '';
    document.getElementById('member-modal').classList.remove('hidden');
}

function closeMemberModal() {
    document.getElementById('member-modal').classList.add('hidden');
}

async function saveMember() {
    const name = document.getElementById('mb-name').value.trim();
    if (!name) { toast('名前を入力してください', 'error'); return; }

    const item = {
        ID: editingMemberId || '',
        Name: name,
        Category: document.getElementById('mb-category').value,
        Role: document.getElementById('mb-role').value.trim(),
        StudentID: document.getElementById('mb-student-id').value.trim(),
        Year: document.getElementById('mb-year').value.trim(),
        Affiliation: document.getElementById('mb-affiliation').value.trim(),
        Note: document.getElementById('mb-note').value.trim(),
        Active: 'true'
    };

    try {
        const saved = await api.save('members', item);
        if (editingMemberId) {
            const idx = membersData.findIndex(m => m.ID === editingMemberId);
            if (idx >= 0) membersData[idx] = saved;
        } else {
            membersData.push(saved);
        }
        api.saveCache('members', membersData);
        renderMembers();
        closeMemberModal();
        toast('保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
    }
}

function deleteMember(id) {
    const idx = membersData.findIndex(m => m.ID === id);
    if (idx < 0) return;
    const backup = membersData[idx];

    membersData.splice(idx, 1);
    api.saveCache('members', membersData);
    renderMembers();

    toastUndo(
        `「${backup.Name}」を削除しました`,
        () => {
            membersData.splice(idx, 0, backup);
            api.saveCache('members', membersData);
            renderMembers();
        },
        async () => {
            await api.delete('members', id);
            toast('削除を確定しました', 'success', 2000);
        },
        5000
    );
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
