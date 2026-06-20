/**
 * メンバーリストページ
 * データベース風テーブル表示。カテゴリフィルタ + 検索 + 卒業生トグル。
 */

let membersData = [];
let memberSearchKw = '';
let memberCatFilter = 'all';
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

let showGraduated = false;

function onMemberSearch() {
    memberSearchKw = (document.getElementById('member-search').value || '').toLowerCase();
    renderMembers();
}

function onCategoryFilterMember(cat) {
    memberCatFilter = cat;
    document.querySelectorAll('.filter-chip[data-cat]').forEach(c =>
        c.classList.toggle('active', c.dataset.cat === cat)
    );
    renderMembers();
}

function toggleGraduated() {
    showGraduated = !showGraduated;
    const btn = document.getElementById('toggle-grad-btn');
    if (btn) {
        btn.textContent = showGraduated ? '卒業生を隠す' : '卒業生も表示';
        btn.classList.toggle('active', showGraduated);
    }
    renderMembers();
}

function isActive(m) { return m.Active !== 'false'; }

function renderMembers() {
    let base = showGraduated ? membersData : membersData.filter(isActive);

    if (memberCatFilter !== 'all') {
        base = base.filter(m => (m.Category || 'member') === memberCatFilter);
    }

    if (memberSearchKw) {
        base = base.filter(m => {
            const hay = [m.Name, m.Role, m.Affiliation, m.StudentID, m.Note, m.Email].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(memberSearchKw);
        });
    }

    const sorted = base.slice().sort((a, b) => {
        if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
        const catOrder = { adviser: 0, coordinator: 1, member: 2 };
        const ca = catOrder[a.Category] ?? 2, cb = catOrder[b.Category] ?? 2;
        if (ca !== cb) return ca - cb;
        if (!!a.Role !== !!b.Role) return a.Role ? -1 : 1;
        return (b.Year || '').localeCompare(a.Year || '');
    });

    const tbody = document.getElementById('members-tbody');

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">該当するメンバーはいません</td></tr>';
    } else {
        tbody.innerHTML = sorted.map(m => {
            const grad = !isActive(m);
            const cat = getMemberCategory(m.Category);
            return `
            <tr class="${grad ? 'graduated' : ''}" data-id="${m.ID}">
                <td class="cell-name">
                    <span class="member-name-text">${escapeHtml(m.Name || '')}</span>
                    ${grad ? '<span class="grad-badge">卒業</span>' : ''}
                </td>
                <td><span class="cat-badge" style="background:${cat.color};">${escapeHtml(cat.label)}</span></td>
                <td>${escapeHtml(m.Role || '')}</td>
                <td class="hide-mobile">${escapeHtml(m.Year ? m.Year + '年' : '')}</td>
                <td class="hide-mobile">${escapeHtml(m.StudentID || '')}</td>
                <td class="hide-mobile">${escapeHtml(m.Affiliation || '')}</td>
                <td class="hide-mobile">${m.Email ? `<a href="mailto:${escapeAttr(m.Email)}">${escapeHtml(m.Email)}</a>` : ''}</td>
                <td class="hide-mobile">${escapeHtml(m.Note || '')}</td>
                <td class="cell-actions">
                    <button class="tbl-btn" onclick="editMember('${m.ID}')" title="編集">編集</button>
                    <button class="tbl-btn" onclick="toggleGraduate('${m.ID}')" title="${grad ? '在籍に戻す' : '卒業'}">${grad ? '復帰' : '卒業'}</button>
                    <button class="tbl-btn tbl-btn-danger" onclick="deleteMember('${m.ID}')" title="削除">削除</button>
                </td>
            </tr>`;
        }).join('');
    }

    const gradCount = membersData.filter(m => !isActive(m)).length;
    const gradBtn = document.getElementById('toggle-grad-btn');
    if (gradBtn) gradBtn.style.display = gradCount > 0 ? '' : 'none';
}

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

// ---- モーダル ----

function onMbCategoryChange() {
    const cat = document.getElementById('mb-category').value;
    const emailGroup = document.getElementById('mb-email-group');
    const catDef = getMemberCategory(cat);
    emailGroup.style.display = catDef.hasEmail ? '' : 'none';
}

function openMemberModal() {
    editingMemberId = null;
    document.getElementById('member-modal-title').textContent = 'メンバー追加';
    ['mb-name', 'mb-role', 'mb-student-id', 'mb-year', 'mb-affiliation', 'mb-note', 'mb-email'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('mb-category').value = 'member';
    onMbCategoryChange();
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
    document.getElementById('mb-email').value = m.Email || '';
    onMbCategoryChange();
    document.getElementById('member-modal').classList.remove('hidden');
}

function closeMemberModal() {
    document.getElementById('member-modal').classList.add('hidden');
}

async function saveMember() {
    const name = document.getElementById('mb-name').value.trim();
    if (!name) { toast('名前を入力してください', 'error'); return; }

    const existing = editingMemberId ? membersData.find(m => m.ID === editingMemberId) : null;
    const item = {
        ID: editingMemberId || '',
        Name: name,
        Category: document.getElementById('mb-category').value,
        Role: document.getElementById('mb-role').value.trim(),
        StudentID: document.getElementById('mb-student-id').value.trim(),
        Year: document.getElementById('mb-year').value.trim(),
        Affiliation: document.getElementById('mb-affiliation').value.trim(),
        Note: document.getElementById('mb-note').value.trim(),
        Email: document.getElementById('mb-email').value.trim(),
        Active: existing ? (existing.Active || 'true') : 'true'
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
