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
    } else {
        renderSkeleton();
    }
    updateSyncStatus(cached ? 'cached' : 'initial-loading', cached ? cached.timestamp : null);

    await refreshData();
}

function renderSkeleton() {
    ['adviser-grid', 'coordinator-grid', 'member-grid'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = Array(3).fill('<div class="member-card" style="height:80px;"><div class="skeleton" style="height:18px;width:60%;margin-bottom:6px;"></div><div class="skeleton" style="height:14px;width:40%;"></div></div>').join('');
    });
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

let showGraduated = false; // 卒業生を表示するか

function onMemberSearch() {
    memberSearchKw = (document.getElementById('member-search').value || '').toLowerCase();
    renderMembers();
}

function toggleGraduated() {
    showGraduated = !showGraduated;
    const btn = document.getElementById('toggle-grad-btn');
    if (btn) {
        btn.textContent = showGraduated ? '👁️ 卒業生を隠す' : '🎓 卒業生も表示';
        btn.classList.toggle('active', showGraduated);
    }
    renderMembers();
}

function isActive(m) { return m.Active !== 'false'; }

function renderMembers() {
    // 在籍/卒業の絞り込み
    let base = showGraduated ? membersData : membersData.filter(isActive);

    const filtered = memberSearchKw
        ? base.filter(m => {
            const hay = [m.Name, m.Role, m.Affiliation, m.StudentID, m.Note].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(memberSearchKw);
        })
        : base;

    const advisers = filtered.filter(m => m.Category === 'adviser');
    const coordinators = filtered.filter(m => m.Category === 'coordinator');
    const regulars = filtered.filter(m => m.Category === 'member' || !m.Category);

    renderCategoryGrid('adviser-grid', advisers, 'adviser');
    renderCategoryGrid('coordinator-grid', coordinators, 'coordinator');
    renderCategoryGrid('member-grid', regulars, 'member');

    // 卒業生数を表示
    const gradCount = membersData.filter(m => !isActive(m)).length;
    document.getElementById('adviser-count').textContent = advisers.length + '名';
    document.getElementById('coordinator-count').textContent = coordinators.length + '名';
    document.getElementById('member-count').textContent = regulars.length + '名';
    const gradBtn = document.getElementById('toggle-grad-btn');
    if (gradBtn) gradBtn.style.display = gradCount > 0 ? '' : 'none';
}

function renderCategoryGrid(elId, items, cat) {
    const el = document.getElementById(elId);
    if (items.length === 0) {
        el.innerHTML = '<div class="empty-state" style="grid-column:1/-1;padding:20px;">該当者なし</div>';
        return;
    }
    // 在籍を上・役職持ちを上・学年降順
    const sorted = items.slice().sort((a, b) => {
        if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
        if (!!a.Role !== !!b.Role) return a.Role ? -1 : 1;
        return (b.Year || '').localeCompare(a.Year || '');
    });
    el.innerHTML = sorted.map(m => {
        const grad = !isActive(m);
        return `
        <div class="member-card ${cat} ${grad ? 'graduated' : ''}" data-id="${m.ID}">
            <div class="member-name">${escapeHtml(m.Name || '')}${grad ? ' <span class="grad-badge">卒業</span>' : ''}</div>
            ${m.Role ? `<div class="member-role">⭐ ${escapeHtml(m.Role)}</div>` : ''}
            <div class="member-meta">
                ${m.Year ? `${escapeHtml(m.Year)}年 ` : ''}
                ${m.StudentID ? `<span style="color:#999;">${escapeHtml(m.StudentID)}</span>` : ''}
            </div>
            ${m.Affiliation ? `<div class="member-meta">📍 ${escapeHtml(m.Affiliation)}</div>` : ''}
            ${m.Note ? `<div class="member-meta">📝 ${escapeHtml(m.Note)}</div>` : ''}
            <div class="member-actions">
                <button onclick="editMember('${m.ID}')">✏️ 編集</button>
                <button onclick="toggleGraduate('${m.ID}')">${grad ? '↩️ 在籍に戻す' : '🎓 卒業'}</button>
                <button class="del-btn" onclick="deleteMember('${m.ID}')">🗑️ 削除</button>
            </div>
        </div>`;
    }).join('');
}

/** メンバーを卒業/在籍トグル（削除せずArchive）。 */
async function toggleGraduate(id) {
    const m = membersData.find(x => x.ID === id);
    if (!m) return;
    const nowActive = isActive(m);
    const updated = { ...m, Active: nowActive ? 'false' : 'true' };
    try {
        const saved = await api.save('members', updated);
        const idx = membersData.findIndex(x => x.ID === id);
        if (idx >= 0) membersData[idx] = saved;
        api.saveCache('members', membersData);
        renderMembers();
        toast(nowActive ? `${m.Name} を卒業生にしました` : `${m.Name} を在籍に戻しました`, 'success');
    } catch (e) {
        toast('更新失敗: ' + e.message, 'error');
    }
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
