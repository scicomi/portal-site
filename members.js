/**
 * メンバーリストページ
 * 年度別表示。全メンバー（アドバイザー・コーディネーター含む）を統一表示。
 * 編集・削除は管理者のみ（編集モード）。
 */

let membersData = [];
let memberSearchKw = '';
let editingMemberId = null;
let selectedFiscalYear = currentFiscalYear();
let gradeFilter = null;
let roleFilter = 'member'; // 'member' | 'coordinator' | 'adviser'（既定はメンバーのみ表示）
let isEditMode = false;

function gradeOf(m) {
    const id = (m.StudentID || '').trim();
    if (id.length < 2) return '';
    return id.slice(0, 2).toUpperCase();
}

function isGradStudent(m) {
    const id = (m.StudentID || '').trim();
    return id.length >= 5 && (id[4] === 'm' || id[4] === 'M');
}

function currentFiscalYear() {
    const now = new Date();
    return (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

// 後方互換: 古いデータの Category から Role を導出
function getEffectiveRole(m) {
    if (m.Role) return m.Role;
    const cat = m.Category || 'member';
    if (cat === 'adviser') return 'アドバイザー';
    if (cat === 'coordinator') return 'コーディネーター';
    return '';
}

// Role から Category を導出（バックエンド互換用）
function deriveCategoryFromRole(role) {
    if (role === 'アドバイザー') return 'adviser';
    if (role === 'コーディネーター') return 'coordinator';
    return 'member';
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
    gradeFilter = null;
    renderMembers();
}

function buildGradeChips(fyMembers) {
    const row = document.getElementById('grade-filter-row');
    const wrap = document.getElementById('grade-filter-chips');
    if (!wrap || !row) return;
    const grades = new Set();
    let hasGrad = false;
    fyMembers.forEach(m => {
        const role = getEffectiveRole(m);
        if (role === 'アドバイザー' || role === 'コーディネーター') return;
        // 院生は学年（5C 等）に含めず「院生」だけに分類する
        if (isGradStudent(m)) { hasGrad = true; return; }
        const g = gradeOf(m);
        if (g && /^\d[A-Z]$/.test(g)) grades.add(g);
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

function setRoleFilter(r) {
    roleFilter = r;
    gradeFilter = null; // 区分を変えたら学年絞り込みはリセット
    document.querySelectorAll('#role-filter-row .filter-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.role === r));
    renderMembers();
}

function onMemberSearch() {
    memberSearchKw = (document.getElementById('member-search').value || '').toLowerCase();
    renderMembers();
}

function getMemberFiscalYear(m) {
    if (m.FiscalYear) return parseInt(m.FiscalYear);
    return currentFiscalYear();
}

function renderMembers() {
    let fyMembers = membersData.filter(m => getMemberFiscalYear(m) === selectedFiscalYear);

    // 区分（メンバー / コーディネーター / アドバイザー）で絞り込み
    fyMembers = fyMembers.filter(m => {
        const role = getEffectiveRole(m);
        if (roleFilter === 'coordinator') return role === 'コーディネーター';
        if (roleFilter === 'adviser') return role === 'アドバイザー';
        return role !== 'コーディネーター' && role !== 'アドバイザー'; // member（既定）
    });

    // 学年チップ・学年絞り込みはメンバー区分のときだけ
    if (roleFilter === 'member') {
        buildGradeChips(fyMembers);
    } else {
        const row = document.getElementById('grade-filter-row');
        if (row) row.style.display = 'none';
        gradeFilter = null;
    }

    let base;
    if (gradeFilter && roleFilter === 'member') {
        if (gradeFilter === '院生') {
            base = fyMembers.filter(isGradStudent);
        } else {
            // 院生（5CSKM012 等）は学年（5C 等）に含めない
            base = fyMembers.filter(m => gradeOf(m) === gradeFilter && !isGradStudent(m));
        }
    } else {
        base = fyMembers;
    }

    if (memberSearchKw) {
        base = base.filter(m => {
            const role = getEffectiveRole(m);
            const hay = [m.Name, m.Furigana, role, m.Affiliation, m.StudentID, m.Note, m.Email].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(memberSearchKw);
        });
    }

    const roleOrder = {};
    CONFIG.MEMBER_ROLES.forEach((r, i) => { roleOrder[r.value] = i; });

    const sorted = base.slice().sort((a, b) => {
        const ra = getEffectiveRole(a), rb = getEffectiveRole(b);
        const oa = roleOrder[ra] ?? (ra ? 10 : 99);
        const ob = roleOrder[rb] ?? (rb ? 10 : 99);
        if (oa !== ob) return oa - ob;
        return (a.Name || '').localeCompare(b.Name || '');
    });

    const tbody = document.getElementById('members-tbody');
    const table = document.getElementById('members-table');
    table.classList.toggle('edit-mode', isEditMode);

    // Admin buttons
    const isAdmin = api.isAdmin();
    // 空文字だと CSS の .admin-only { display:none } に戻ってしまうため明示的に値を指定する
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? 'inline-block' : 'none';
    });

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">該当するメンバーはいません</td></tr>';
    } else {
        tbody.innerHTML = sorted.map(m => {
            const role = getEffectiveRole(m);
            const roleInfo = role ? getRoleDisplay(role) : null;
            const isStaff = role === 'アドバイザー' || role === 'コーディネーター';
            const rowStyle = isStaff ? 'style="background:#faf9f8;"' : '';
            const clickHandler = isEditMode ? `onclick="editMember('${m.ID}')"` : '';
            const roleBadge = roleInfo
                ? `<span class="cat-badge" style="background:${roleInfo.color};margin-left:6px;font-size:0.7rem;">${escapeHtml(role)}</span>`
                : '';
            return `
            <tr data-id="${m.ID}" ${rowStyle} ${clickHandler} class="${isEditMode ? 'clickable-row' : ''}">
                <td>${escapeHtml(m.StudentID || '')}</td>
                <td class="cell-name">
                    ${m.Furigana ? '<span class="member-furigana">' + escapeHtml(m.Furigana) + '</span>' : ''}
                    <span class="member-name-text">${escapeHtml(m.Name || '')}</span>
                    ${roleBadge}
                </td>
                <td>${escapeHtml(m.Affiliation || '')}</td>
                <td class="hide-mobile">${m.Email ? `<a href="mailto:${escapeAttr(m.Email)}">${escapeHtml(m.Email)}</a>` : ''}</td>
            </tr>`;
        }).join('');
    }
}

// ---- 編集モード ----

function toggleEditMode() {
    if (!isEditMode && !api.isAdmin()) {
        showAdminAuthModal(() => toggleEditMode());
        return;
    }
    isEditMode = !isEditMode;
    const btn = document.getElementById('edit-mode-btn');
    if (btn) {
        btn.textContent = isEditMode ? '完了' : '編集';
        btn.classList.toggle('active', isEditMode);
    }
    renderMembers();
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

// 役職の選択肢は「アドバイザー / コーディネーター / (なし) / 自由入力」に限定。既定は (なし)。
// 既存データに別の役職（旧プロジェクトリーダー等）があれば、その値は専用 option として保持する。
const MEMBER_ROLE_PRESETS = ['アドバイザー', 'コーディネーター'];

function populateRoleSelect(currentRole) {
    const sel = document.getElementById('mb-role');
    if (!sel) return;
    const options = [{ value: '', label: '(なし)' }];
    MEMBER_ROLE_PRESETS.forEach(r => options.push({ value: r, label: r }));

    const isCustom = currentRole && !MEMBER_ROLE_PRESETS.includes(currentRole);

    let html = options.map(o =>
        `<option value="${escapeAttr(o.value)}" ${!isCustom && o.value === currentRole ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    ).join('');

    if (isCustom) {
        html += `<option value="${escapeAttr(currentRole)}" selected>${escapeHtml(currentRole)}</option>`;
    }
    html += '<option value="__custom__">その他（自由入力）</option>';
    sel.innerHTML = html;

    updateMemberFieldVisibility();
}

function onRoleSelectChange() {
    const sel = document.getElementById('mb-role');
    if (sel.value === '__custom__') {
        const custom = prompt('役職名を入力してください:');
        if (custom && custom.trim()) {
            const opt = document.createElement('option');
            opt.value = custom.trim();
            opt.textContent = custom.trim();
            opt.selected = true;
            sel.insertBefore(opt, sel.querySelector('option[value="__custom__"]'));
        } else {
            sel.value = '';
        }
    }
    updateMemberFieldVisibility();
}

// 役職が (なし) のときはメールアドレス・所属の入力欄を隠す（一般メンバーには不要なため）。
function updateMemberFieldVisibility() {
    const sel = document.getElementById('mb-role');
    if (!sel) return;
    const hide = sel.value === ''; // (なし)
    const emailG = document.getElementById('mb-email-group');
    const affG = document.getElementById('mb-affiliation-group');
    if (emailG) emailG.style.display = hide ? 'none' : '';
    if (affG) affG.style.display = hide ? 'none' : '';
}

function openMemberModal() {
    editingMemberId = null;
    document.getElementById('member-modal-title').textContent = 'メンバー追加';
    ['mb-name', 'mb-furigana', 'mb-student-id', 'mb-affiliation', 'mb-note', 'mb-email'].forEach(id => {
        document.getElementById(id).value = '';
    });
    populateRoleSelect('');
    populateFiscalYearModal();
    document.getElementById('mb-fiscal-year').value = selectedFiscalYear || currentFiscalYear();
    document.getElementById('mb-delete-btn').classList.add('hidden');
    document.getElementById('member-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('mb-name').focus(), 50);
}

function editMember(id) {
    const m = membersData.find(x => x.ID === id);
    if (!m) return;
    editingMemberId = id;
    document.getElementById('member-modal-title').textContent = 'メンバー編集';
    document.getElementById('mb-name').value = m.Name || '';
    document.getElementById('mb-furigana').value = m.Furigana || '';
    populateRoleSelect(getEffectiveRole(m));
    document.getElementById('mb-student-id').value = m.StudentID || '';
    document.getElementById('mb-affiliation').value = m.Affiliation || '';
    document.getElementById('mb-note').value = m.Note || '';
    document.getElementById('mb-email').value = m.Email || '';
    populateFiscalYearModal();
    document.getElementById('mb-fiscal-year').value = m.FiscalYear || currentFiscalYear();
    document.getElementById('mb-delete-btn').classList.remove('hidden');
    document.getElementById('member-modal').classList.remove('hidden');
}

function closeMemberModal() {
    document.getElementById('member-modal').classList.add('hidden');
}

async function saveMember() {
    const name = document.getElementById('mb-name').value.trim();
    if (!name) { toast('名前を入力してください', 'error'); return; }

    const existing = editingMemberId ? membersData.find(m => m.ID === editingMemberId) : null;
    const isNew = !editingMemberId;
    const role = document.getElementById('mb-role').value === '__custom__' ? '' : document.getElementById('mb-role').value;
    const item = {
        ID: editingMemberId || genId('mb_'),
        Name: name,
        Furigana: document.getElementById('mb-furigana').value.trim(),
        Category: deriveCategoryFromRole(role),
        Role: role,
        StudentID: document.getElementById('mb-student-id').value.trim(),
        Affiliation: document.getElementById('mb-affiliation').value.trim(),
        Note: document.getElementById('mb-note').value.trim(),
        Email: document.getElementById('mb-email').value.trim(),
        FiscalYear: document.getElementById('mb-fiscal-year').value,
        Active: 'true'
    };

    if (editingMemberId && existing) item._baseUpdatedAt = existing.UpdatedAt || '';

    const snapshot = JSON.parse(JSON.stringify(membersData));

    if (isNew) {
        membersData.push({ ...item });
    } else {
        const idx = membersData.findIndex(m => m.ID === editingMemberId);
        if (idx >= 0) membersData[idx] = { ...membersData[idx], ...item };
    }
    api.saveCache('members', membersData);
    buildFiscalYearSelect();
    renderMembers();
    closeMemberModal();
    toast('保存しました', 'success');

    api.save('members', item).then(saved => {
        const idx = membersData.findIndex(m => m.ID === item.ID);
        if (idx >= 0) membersData[idx] = saved;
        api.saveCache('members', membersData);
    }).catch(e => {
        membersData.splice(0, membersData.length, ...snapshot);
        api.saveCache('members', membersData);
        buildFiscalYearSelect();
        renderMembers();
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのメンバーを編集しました。最新を読み込みます。', 'error', 5000);
            refreshData();
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    });
}

function deleteMemberFromModal() {
    if (!editingMemberId) return;
    if (!confirm('このメンバーを削除しますか？')) return;
    deleteMember(editingMemberId);
}

async function deleteMember(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => deleteMember(id));
        return;
    }
    const idx = membersData.findIndex(m => m.ID === id);
    if (idx < 0) return;
    const backup = membersData[idx];

    membersData.splice(idx, 1);
    api.saveCache('members', membersData);
    renderMembers();
    closeMemberModal();

    try {
        await api.delete('members', id);
    } catch (e) {
        membersData.splice(idx, 0, backup);
        api.saveCache('members', membersData);
        renderMembers();
        toast('削除失敗: ' + e.message, 'error');
        return;
    }

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
        () => {},
        5000
    );
}

// ---- 年度一括登録 ----

function openYearCopyModal() {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => openYearCopyModal());
        return;
    }
    const curFY = currentFiscalYear();

    const srcSel = document.getElementById('yc-source-year');
    const years = new Set();
    membersData.forEach(m => {
        const fy = m.FiscalYear ? parseInt(m.FiscalYear) : null;
        if (fy) years.add(fy);
    });
    if (years.size === 0) years.add(curFY);
    const sorted = [...years].sort((a, b) => b - a);
    const defaultSrc = sorted.find(y => y < curFY) || sorted[0];
    srcSel.innerHTML = sorted.map(y =>
        `<option value="${y}" ${y === defaultSrc ? 'selected' : ''}>${y}年度</option>`
    ).join('');

    const tgtSel = document.getElementById('yc-target-year');
    const tgtYears = [];
    for (let y = curFY + 1; y >= curFY - 1; y--) tgtYears.push(y);
    tgtSel.innerHTML = tgtYears.map(y =>
        `<option value="${y}" ${y === curFY ? 'selected' : ''}>${y}年度</option>`
    ).join('');

    renderYearCopyMembers();
    document.getElementById('year-copy-modal').classList.remove('hidden');
}

function renderYearCopyMembers() {
    const srcYear = parseInt(document.getElementById('yc-source-year').value);
    const members = membersData.filter(m => getMemberFiscalYear(m) === srcYear);

    const roleOrder = {};
    CONFIG.MEMBER_ROLES.forEach((r, i) => { roleOrder[r.value] = i; });

    members.sort((a, b) => {
        const ra = getEffectiveRole(a), rb = getEffectiveRole(b);
        const oa = roleOrder[ra] ?? (ra ? 10 : 99);
        const ob = roleOrder[rb] ?? (rb ? 10 : 99);
        if (oa !== ob) return oa - ob;
        return (a.Name || '').localeCompare(b.Name || '');
    });

    const list = document.getElementById('yc-member-list');
    if (members.length === 0) {
        list.innerHTML = '<p style="color:#999; text-align:center; padding:20px;">この年度にメンバーがいません</p>';
        return;
    }
    list.innerHTML = members.map(m => {
        const role = getEffectiveRole(m);
        const roleInfo = role ? getRoleDisplay(role) : null;
        const badge = roleInfo
            ? `<span class="cat-badge" style="background:${roleInfo.color};font-size:0.7rem;">${escapeHtml(role)}</span>`
            : '';
        return `<label style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid #f5f5f5; cursor:pointer;">
            <input type="checkbox" value="${m.ID}" checked class="yc-check">
            <span style="flex:1;">${escapeHtml(m.Name || '')} ${badge}</span>
            <span style="font-size:0.8rem; color:#999;">${escapeHtml(m.StudentID || '')}</span>
        </label>`;
    }).join('');
}

function yearCopySelectAll(checked) {
    document.querySelectorAll('.yc-check').forEach(cb => cb.checked = checked);
}

function closeYearCopyModal() {
    document.getElementById('year-copy-modal').classList.add('hidden');
}

async function executeYearCopy() {
    const targetYear = document.getElementById('yc-target-year').value;
    const selectedIds = [...document.querySelectorAll('.yc-check:checked')].map(cb => cb.value);

    if (selectedIds.length === 0) {
        toast('メンバーを選択してください', 'error');
        return;
    }

    const existingInTarget = membersData.filter(m => getMemberFiscalYear(m) === parseInt(targetYear));
    if (existingInTarget.length > 0) {
        if (!confirm(`${targetYear}年度には既に${existingInTarget.length}名のメンバーがいます。追加しますか？`)) return;
    }

    const sourceMembers = membersData.filter(m => selectedIds.includes(m.ID));
    const newMembers = sourceMembers.map(m => ({
        ID: genId('mb_'),
        Name: m.Name,
        Furigana: m.Furigana || '',
        Category: m.Category || 'member',
        Role: getEffectiveRole(m),
        StudentID: m.StudentID || '',
        Affiliation: m.Affiliation || '',
        Note: '',
        Email: m.Email || '',
        FiscalYear: targetYear,
        Active: 'true'
    }));

    membersData.push(...newMembers);
    api.saveCache('members', membersData);
    selectedFiscalYear = parseInt(targetYear);
    buildFiscalYearSelect();
    renderMembers();
    closeYearCopyModal();
    toast(`${newMembers.length}名を${targetYear}年度に登録しました`, 'success');

    let failCount = 0;
    for (const item of newMembers) {
        try {
            const saved = await api.save('members', item);
            const idx = membersData.findIndex(m => m.ID === item.ID);
            if (idx >= 0) membersData[idx] = saved;
        } catch (e) {
            failCount++;
        }
    }
    api.saveCache('members', membersData);
    if (failCount > 0) {
        toast(`${failCount}名の保存に失敗しました。再読み込みしてください。`, 'error');
        refreshData();
    }
}
