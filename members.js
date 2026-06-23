/**
 * メンバーリストページ
 * 年度別表示。メンバーがデフォルト、アドバイザー/コーディネーターはトグルで表示。
 */

let membersData = [];
let memberSearchKw = '';
let editingMemberId = null;
let selectedFiscalYear = currentFiscalYear();
let showAdviser = false;
let showCoordinator = false;
let gradeFilter = null; // 例: '5C' / '院生' / null(全員)

// 学籍番号の先頭2文字（例: '5CSC1234' → '5C'）。なければ空。
function gradeOf(m) {
    const id = (m.StudentID || '').trim();
    if (id.length < 2) return '';
    return id.slice(0, 2).toUpperCase();
}

// 5文字目が m/M なら院生（例: '5CSKM0112'）。
function isGradStudent(m) {
    const id = (m.StudentID || '').trim();
    return id.length >= 5 && (id[4] === 'm' || id[4] === 'M');
}

function currentFiscalYear() {
    const now = new Date();
    return (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

document.addEventListener('DOMContentLoaded', () => {
    bootPage('members', init);
});

async function init() {
    const cached = api.loadCache('members');
    if (cached && cached.items) {
        membersData = cached.items;
        buildFiscalYearSelect();
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
        buildFiscalYearSelect();
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

function buildFiscalYearSelect() {
    const sel = document.getElementById('fiscal-year-select');
    if (!sel) return;

    const years = new Set();
    const curFY = currentFiscalYear();
    years.add(curFY);

    membersData.forEach(m => {
        const fy = m.FiscalYear ? parseInt(m.FiscalYear) : null;
        if (fy) years.add(fy);
    });

    const sorted = [...years].sort((a, b) => b - a);
    sel.innerHTML = sorted.map(y =>
        `<option value="${y}" ${y === selectedFiscalYear ? 'selected' : ''}>${y}年度</option>`
    ).join('');
}

function onFiscalYearChange() {
    selectedFiscalYear = parseInt(document.getElementById('fiscal-year-select').value);
    gradeFilter = null; // 年度が変われば学年構成も変わるのでリセット
    renderMembers();
}

// 表示中の年度の学生から学年チップ（◯C生）を動的生成。院生がいれば院生チップも追加。
function buildGradeChips(fyMembers) {
    const row = document.getElementById('grade-filter-row');
    const wrap = document.getElementById('grade-filter-chips');
    if (!wrap || !row) return;

    const grades = new Set();
    let hasGrad = false;
    fyMembers.forEach(m => {
        if ((m.Category || 'member') !== 'member') return;
        const g = gradeOf(m);
        if (g && /^\d[A-Z]$/.test(g)) grades.add(g);
        if (isGradStudent(m)) hasGrad = true;
    });

    const list = [...grades].sort();
    if (hasGrad) list.push('院生');

    if (list.length === 0) {
        row.style.display = 'none';
        wrap.innerHTML = '';
        return;
    }
    row.style.display = '';
    wrap.innerHTML = list.map(g =>
        `<button class="filter-chip ${gradeFilter === g ? 'active' : ''}" onclick="setGradeFilter('${g}')">${g === '院生' ? '院生' : g + '生'}</button>`
    ).join('');
}

function setGradeFilter(g) {
    gradeFilter = (gradeFilter === g) ? null : g;
    renderMembers();
}

function onMemberSearch() {
    memberSearchKw = (document.getElementById('member-search').value || '').toLowerCase();
    renderMembers();
}

function toggleCategoryFilter(cat) {
    if (cat === 'adviser') {
        showAdviser = !showAdviser;
        document.getElementById('toggle-adviser-btn').classList.toggle('active', showAdviser);
    } else if (cat === 'coordinator') {
        showCoordinator = !showCoordinator;
        document.getElementById('toggle-coordinator-btn').classList.toggle('active', showCoordinator);
    }
    renderMembers();
}

function getMemberFiscalYear(m) {
    if (m.FiscalYear) return parseInt(m.FiscalYear);
    return currentFiscalYear();
}

function renderMembers() {
    const fyMembers = membersData.filter(m => getMemberFiscalYear(m) === selectedFiscalYear);
    buildGradeChips(fyMembers);

    let base;
    if (gradeFilter) {
        // 学年/院生フィルタが選択されている時は、その学年の学生だけを表示
        if (gradeFilter === '院生') {
            base = fyMembers.filter(isGradStudent);
        } else {
            base = fyMembers.filter(m => gradeOf(m) === gradeFilter);
        }
    } else {
        base = fyMembers.filter(m => {
            const cat = m.Category || 'member';
            if (cat === 'member') return true;
            if (cat === 'adviser') return showAdviser;
            if (cat === 'coordinator') return showCoordinator;
            return true;
        });
    }

    if (memberSearchKw) {
        base = base.filter(m => {
            const hay = [m.Name, m.Role, m.Affiliation, m.StudentID, m.Note, m.Email].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(memberSearchKw);
        });
    }

    const sorted = base.slice().sort((a, b) => {
        const catOrder = { adviser: 0, coordinator: 1, member: 2 };
        const ca = catOrder[a.Category] ?? 2, cb = catOrder[b.Category] ?? 2;
        if (ca !== cb) return ca - cb;
        if (!!a.Role !== !!b.Role) return a.Role ? -1 : 1;
        return (a.Name || '').localeCompare(b.Name || '');
    });

    const tbody = document.getElementById('members-tbody');

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">該当するメンバーはいません</td></tr>';
    } else {
        tbody.innerHTML = sorted.map(m => {
            const cat = m.Category || 'member';
            const catDef = getMemberCategory(cat);
            const roleAffil = [m.Role, m.Affiliation].filter(Boolean).join(' / ');
            const isSub = cat !== 'member';
            const isInactive = m.Active === 'false';
            const rowStyle = isInactive ? 'style="background:#faf9f8;opacity:0.6;"' : (isSub ? 'style="background:#faf9f8;"' : '');
            return `
            <tr data-id="${m.ID}" ${rowStyle}>
                <td>${escapeHtml(m.StudentID || '')}</td>
                <td class="cell-name">
                    <span class="member-name-text">${escapeHtml(m.Name || '')}</span>
                    ${isSub ? '<span class="cat-badge" style="background:' + catDef.color + ';margin-left:6px;font-size:0.7rem;">' + escapeHtml(catDef.label) + '</span>' : ''}
                    ${isInactive ? '<span class="cat-badge" style="background:#9ca3af;margin-left:6px;font-size:0.7rem;">卒業・退会</span>' : ''}
                </td>
                <td>${escapeHtml(roleAffil || '')}</td>
                <td class="hide-mobile">${m.Email ? `<a href="mailto:${escapeAttr(m.Email)}">${escapeHtml(m.Email)}</a>` : ''}</td>
                <td class="cell-actions">
                    <button class="tbl-btn" onclick="editMember('${m.ID}')" title="編集">編集</button>
                    <button class="tbl-btn tbl-btn-danger${api.isAdmin() ? '' : ' admin-hidden'}" onclick="deleteMember('${m.ID}')" title="削除">削除</button>
                </td>
            </tr>`;
        }).join('');
    }
}

// ---- モーダル ----

function populateFiscalYearModal() {
    const sel = document.getElementById('mb-fiscal-year');
    if (!sel) return;
    const curFY = currentFiscalYear();
    const years = [];
    for (let y = curFY + 1; y >= curFY - 5; y--) years.push(y);
    sel.innerHTML = years.map(y =>
        `<option value="${y}" ${y === curFY ? 'selected' : ''}>${y}年度</option>`
    ).join('');
}

function openMemberModal() {
    editingMemberId = null;
    document.getElementById('member-modal-title').textContent = 'メンバー追加';
    ['mb-name', 'mb-role', 'mb-student-id', 'mb-affiliation', 'mb-note', 'mb-email'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('mb-category').value = 'member';
    document.getElementById('mb-active').value = 'true';
    populateFiscalYearModal();
    document.getElementById('mb-fiscal-year').value = selectedFiscalYear || currentFiscalYear();
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
    document.getElementById('mb-affiliation').value = m.Affiliation || '';
    document.getElementById('mb-note').value = m.Note || '';
    document.getElementById('mb-email').value = m.Email || '';
    populateFiscalYearModal();
    document.getElementById('mb-fiscal-year').value = m.FiscalYear || currentFiscalYear();
    document.getElementById('mb-active').value = (m.Active === 'false') ? 'false' : 'true';
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
        Affiliation: document.getElementById('mb-affiliation').value.trim(),
        Note: document.getElementById('mb-note').value.trim(),
        Email: document.getElementById('mb-email').value.trim(),
        FiscalYear: document.getElementById('mb-fiscal-year').value,
        Active: document.getElementById('mb-active').value === 'false' ? 'false' : 'true'
    };

    // 編集時は競合検知用に読み込み時の版を添える
    if (editingMemberId && existing) item._baseUpdatedAt = existing.UpdatedAt || '';

    try {
        const saved = await api.save('members', item);
        if (editingMemberId) {
            const idx = membersData.findIndex(m => m.ID === editingMemberId);
            if (idx >= 0) membersData[idx] = saved;
        } else {
            membersData.push(saved);
        }
        api.saveCache('members', membersData);
        buildFiscalYearSelect();
        renderMembers();
        closeMemberModal();
        toast('保存しました', 'success');
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのメンバーを編集しました。最新を読み込みます。', 'error', 5000);
            closeMemberModal();
            await refreshData();
            return;
        }
        toast('保存失敗: ' + e.message, 'error');
    }
}

async function deleteMember(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => deleteMember(id));
        return;
    }
    const idx = membersData.findIndex(m => m.ID === id);
    if (idx < 0) return;
    const backup = membersData[idx];

    // UIから即削除（楽観的表示）
    membersData.splice(idx, 1);
    api.saveCache('members', membersData);
    renderMembers();

    // サーバー削除を即時実行（ページ離脱でも確実に確定する）
    try {
        await api.delete('members', id);
    } catch (e) {
        membersData.splice(idx, 0, backup);
        api.saveCache('members', membersData);
        renderMembers();
        toast('削除失敗: ' + e.message, 'error');
        return;
    }

    // 削除確定後、UNDO（同一IDで再作成）を提示
    toastUndo(
        `「${backup.Name}」を削除しました`,
        async () => {
            try {
                const saved = await api.save('members', backup);
                membersData.splice(idx, 0, saved);
                api.saveCache('members', membersData);
                buildFiscalYearSelect();
                renderMembers();
                toast('元に戻しました', 'success', 2000);
            } catch (e) {
                toast('復元に失敗しました: ' + e.message, 'error');
            }
        },
        () => {},   // 確定処理は不要（既にサーバー削除済み）
        5000
    );
}
