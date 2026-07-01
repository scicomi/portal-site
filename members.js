/**
 * メンバーリストページ
 * 年度別表示。全メンバー（アドバイザー・コーディネーター含む）を統一表示。
 * 新規作成・編集はステップウィザード形式。行ホバーで編集・削除ボタン表示。
 */

let membersData = [];
let memberSearchKw = '';
let editingMemberId = null;
let selectedFiscalYear = currentFiscalYear();
let gradeFilter = null;
let roleFilter = 'member';
let mbWizardStep = 0;

const MB_WIZARD_STEPS = [
    { label: '基本情報' },
    { label: '所属・連絡先' }
];

function gradeOf(m) {
    const id = (m.StudentID || '').trim();
    if (id.length < 2) return '';
    return id.slice(0, 2).toUpperCase();
}

function isGradStudent(m) {
    const id = (m.StudentID || '').trim();
    return id.length >= 5 && (id[4] === 'm' || id[4] === 'M');
}

function getEffectiveRole(m) {
    if (m.Role) return m.Role;
    const cat = m.Category || 'member';
    if (cat === 'adviser') return 'アドバイザー';
    if (cat === 'coordinator') return 'コーディネーター';
    return '';
}

function deriveCategoryFromRole(role) {
    if (role === 'アドバイザー') return 'adviser';
    if (role === 'コーディネーター') return 'coordinator';
    return 'member';
}

function _bindMemberTableDelegation() {
    const tbody = document.getElementById('members-tbody');
    if (!tbody) return;
    tbody.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
            e.stopPropagation();
            const row = actionEl.closest('tr[data-id]');
            if (!row) return;
            const id = row.dataset.id;
            if (actionEl.dataset.action === 'edit') openMemberWizard(id);
            else if (actionEl.dataset.action === 'delete') confirmDeleteMember(id);
            return;
        }
        if (e.target.closest('[data-action-cell]')) return;
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bootPage('members', init);
});

async function init() {
    bindOverlayClose(document.getElementById('year-copy-modal'), closeYearCopyModal);
    _bindMemberTableDelegation();

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
        if (e.handled) return;
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
    gradeFilter = null;
    document.querySelectorAll('#role-filter-row .filter-chip').forEach(c => {
        const isActive = c.dataset.role === r;
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });
    renderMembers();
}

function sortByRoleThenName(list) {
    const roleOrder = {};
    CONFIG.MEMBER_ROLES.forEach((r, i) => { roleOrder[r.value] = i; });
    return list.slice().sort((a, b) => {
        const ra = getEffectiveRole(a), rb = getEffectiveRole(b);
        const oa = roleOrder[ra] ?? (ra ? 10 : 99);
        const ob = roleOrder[rb] ?? (rb ? 10 : 99);
        if (oa !== ob) return oa - ob;
        return (a.Name || '').localeCompare(b.Name || '');
    });
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

    fyMembers = fyMembers.filter(m => {
        const role = getEffectiveRole(m);
        if (roleFilter === 'coordinator') return role === 'コーディネーター';
        if (roleFilter === 'adviser') return role === 'アドバイザー';
        return role !== 'コーディネーター' && role !== 'アドバイザー';
    });

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

    const sorted = sortByRoleThenName(base);

    const tbody = document.getElementById('members-tbody');
    const isAdmin = api.isAdmin();

    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? 'inline-block' : 'none';
    });

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">該当するメンバーはいません</td></tr>';
    } else {
        tbody.innerHTML = sorted.map(m => {
            const role = getEffectiveRole(m);
            const roleInfo = role ? getRoleDisplay(role) : null;
            const isStaff = role === 'アドバイザー' || role === 'コーディネーター';
            const rowStyle = isStaff ? 'style="background:var(--hover-bg);"' : '';
            const roleBadge = roleInfo
                ? `<span class="cat-badge" style="background:${roleInfo.color};margin-left:6px;font-size:0.7rem;">${escapeHtml(role)}</span>`
                : '';
            return `
            <tr data-id="${escapeAttr(m.ID)}" ${rowStyle}>
                <td>${escapeHtml(m.StudentID || '')}</td>
                <td class="cell-name">
                    ${m.Furigana ? '<span class="member-furigana">' + escapeHtml(m.Furigana) + '</span>' : ''}
                    <span class="member-name-text">${escapeHtml(m.Name || '')}</span>
                    ${roleBadge}
                </td>
                <td>${escapeHtml(m.Affiliation || '')}</td>
                <td class="hide-mobile">${m.Email ? `<a href="mailto:${escapeAttr(m.Email)}">${escapeHtml(m.Email)}</a>` : ''}</td>
                <td data-action-cell>
                    <div class="inline-actions">
                        ${isAdmin ? `<button class="inline-action-btn" data-action="edit" title="編集">&#9998;</button>` : ''}
                        ${isAdmin ? `<button class="inline-action-btn danger" data-action="delete" title="削除">&#x2715;</button>` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');
    }
}

// ---- ウィザード形式の新規作成・編集 ----

const MEMBER_ROLE_PRESETS = ['アドバイザー', 'コーディネーター'];

function openMemberWizard(editId) {
    editingMemberId = editId || null;
    mbWizardStep = 0;

    const m = editingMemberId ? membersData.find(x => x.ID === editingMemberId) : null;
    const isEdit = !!m;
    const isAdmin = api.isAdmin();

    // 編集・削除は管理者のみ（新規追加は誰でも可）
    if (isEdit && !isAdmin) {
        showAdminAuthModal(() => openMemberWizard(editId));
        return;
    }
    const currentRole = isEdit ? getEffectiveRole(m) : '';
    const isCustomRole = currentRole && !MEMBER_ROLE_PRESETS.includes(currentRole) && currentRole !== '';

    const roleOptions = [
        `<option value="" ${!currentRole ? 'selected' : ''}>(なし)</option>`,
        ...MEMBER_ROLE_PRESETS.map(r => `<option value="${escapeAttr(r)}" ${currentRole === r ? 'selected' : ''}>${escapeHtml(r)}</option>`),
        isCustomRole ? `<option value="${escapeAttr(currentRole)}" selected>${escapeHtml(currentRole)}</option>` : '',
        `<option value="__custom__">その他（自由入力）</option>`
    ].join('');

    const fyOptions = (() => {
        const curFY = currentFiscalYear();
        const years = [];
        for (let y = curFY + 1; y >= curFY - 5; y--) years.push(y);
        const sel = isEdit ? (m.FiscalYear || curFY) : (selectedFiscalYear || curFY);
        return years.map(y => `<option value="${y}" ${y == sel ? 'selected' : ''}>${y}年度</option>`).join('');
    })();

    const showContactFields = currentRole !== '';

    const overlay = document.createElement('div');
    overlay.id = 'mb-wizard-overlay';
    overlay.className = 'wizard-overlay';
    overlay.onclick = (ev) => { if (ev.target === overlay) closeMemberWizard(); };

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true">
            <div class="wizard-header">
                <h2 class="wizard-title">${isEdit ? 'メンバー編集' : 'メンバー追加'}</h2>
                <p class="wizard-subtitle">${isEdit ? (m.Name || '') : 'ステップに沿って入力してください'}</p>
            </div>
            <div class="wizard-progress">
                ${MB_WIZARD_STEPS.map((s, i) => `
                    ${i > 0 ? '<div class="wizard-step-line" data-line="' + i + '"></div>' : ''}
                    <div class="wizard-step-dot${i === 0 ? ' active' : ''}" data-dot="${i}" title="${s.label}">${i + 1}</div>
                `).join('')}
            </div>
            <div class="wizard-body">
                <!-- Step 1: 基本情報 -->
                <div class="wizard-step active" data-step="0">
                    <div class="wizard-step-label">Step 1 / ${MB_WIZARD_STEPS.length} &mdash; ${MB_WIZARD_STEPS[0].label}</div>
                    <div class="e1-group">
                        <label class="e1-label">名前 *</label>
                        <input id="wz-mb-name" class="e1-input" type="text" placeholder="例: 山田 太郎" value="${escapeAttr(m ? m.Name : '')}">
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">ふりがな</label>
                        <input id="wz-mb-furigana" class="e1-input" type="text" placeholder="例: やまだ たろう" value="${escapeAttr(m ? m.Furigana : '')}">
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">役職</label>
                        <select id="wz-mb-role" class="e1-input" onchange="onWzRoleChange()">${roleOptions}</select>
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">年度</label>
                        <select id="wz-mb-fiscal-year" class="e1-input">${fyOptions}</select>
                    </div>
                </div>

                <!-- Step 2: 所属・連絡先 -->
                <div class="wizard-step" data-step="1">
                    <div class="wizard-step-label">Step 2 / ${MB_WIZARD_STEPS.length} &mdash; ${MB_WIZARD_STEPS[1].label}</div>
                    <div class="e1-group">
                        <label class="e1-label">学生証番号 / 教職員番号</label>
                        <input id="wz-mb-student-id" class="e1-input" type="text" placeholder="例: 5CSC1234" value="${escapeAttr(m ? m.StudentID : '')}">
                    </div>
                    <div class="e1-group" id="wz-mb-affiliation-group" ${!showContactFields ? 'style="display:none;"' : ''}>
                        <label class="e1-label">所属</label>
                        <input id="wz-mb-affiliation" class="e1-input" type="text" placeholder="例: 理系教育センター" value="${escapeAttr(m ? m.Affiliation : '')}">
                    </div>
                    <div class="e1-group" id="wz-mb-email-group" ${!showContactFields ? 'style="display:none;"' : ''}>
                        <label class="e1-label">メールアドレス</label>
                        <input id="wz-mb-email" class="e1-input" type="email" placeholder="例: name@example.com" value="${escapeAttr(m ? m.Email : '')}">
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">メモ</label>
                        <textarea id="wz-mb-note" class="e1-input" rows="2" placeholder="任意のメモ">${escapeHtml(m ? m.Note : '')}</textarea>
                    </div>
                </div>
            </div>
            <div class="wizard-footer">
                ${isEdit && isAdmin ? '<button class="btn btn-danger" onclick="deleteFromMbWizard()">削除</button>' : ''}
                <div class="wizard-footer-spacer"></div>
                <button class="btn btn-text" onclick="closeMemberWizard()">キャンセル</button>
                <button id="wz-mb-prev-btn" class="btn btn-secondary" onclick="mbWizardPrev()" style="display:none;">戻る</button>
                <button id="wz-mb-next-btn" class="btn btn-primary" onclick="mbWizardNext()">次へ</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    bindModalEscape(overlay, closeMemberWizard);
    trapFocus(overlay.querySelector('.wizard-panel'));
    setTimeout(() => document.getElementById('wz-mb-name').focus(), 80);
}

function closeMemberWizard() {
    const overlay = document.getElementById('mb-wizard-overlay');
    if (overlay) overlay.remove();
    editingMemberId = null;
    mbWizardStep = 0;
}

function onWzRoleChange() {
    const sel = document.getElementById('wz-mb-role');
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
    const hide = sel.value === '';
    const emailG = document.getElementById('wz-mb-email-group');
    const affG = document.getElementById('wz-mb-affiliation-group');
    if (emailG) emailG.style.display = hide ? 'none' : '';
    if (affG) affG.style.display = hide ? 'none' : '';
}

function updateMbWizardUI() {
    const total = MB_WIZARD_STEPS.length;
    const isLast = mbWizardStep === total - 1;

    document.querySelectorAll('#mb-wizard-overlay .wizard-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === mbWizardStep);
    });
    document.querySelectorAll('#mb-wizard-overlay .wizard-step-dot').forEach(el => {
        const i = parseInt(el.dataset.dot);
        el.classList.toggle('active', i === mbWizardStep);
        el.classList.toggle('done', i < mbWizardStep);
    });
    document.querySelectorAll('#mb-wizard-overlay .wizard-step-line').forEach(el => {
        const i = parseInt(el.dataset.line);
        el.classList.toggle('done', i <= mbWizardStep);
    });

    const prevBtn = document.getElementById('wz-mb-prev-btn');
    const nextBtn = document.getElementById('wz-mb-next-btn');
    if (prevBtn) prevBtn.style.display = mbWizardStep > 0 ? '' : 'none';
    if (nextBtn) nextBtn.textContent = isLast ? '保存' : '次へ';
}

function mbWizardPrev() {
    if (mbWizardStep > 0) {
        mbWizardStep--;
        updateMbWizardUI();
    }
}

function mbWizardNext() {
    const total = MB_WIZARD_STEPS.length;

    if (mbWizardStep === 0) {
        const name = document.getElementById('wz-mb-name').value.trim();
        if (!name) {
            toast('名前を入力してください', 'error');
            document.getElementById('wz-mb-name').focus();
            return;
        }
    }

    if (mbWizardStep < total - 1) {
        mbWizardStep++;
        updateMbWizardUI();
        const step = document.querySelector('#mb-wizard-overlay .wizard-step.active');
        if (step) {
            const firstInput = step.querySelector('input, textarea, select');
            if (firstInput) setTimeout(() => firstInput.focus(), 100);
        }
    } else {
        saveMember();
    }
}

async function saveMember() {
    const name = document.getElementById('wz-mb-name').value.trim();
    if (!name) { toast('名前を入力してください', 'error'); return; }

    const existing = editingMemberId ? membersData.find(m => m.ID === editingMemberId) : null;
    const isNew = !editingMemberId;
    const role = document.getElementById('wz-mb-role').value === '__custom__' ? '' : document.getElementById('wz-mb-role').value;
    const item = {
        ID: editingMemberId || genId('mb_'),
        Name: name,
        Furigana: document.getElementById('wz-mb-furigana').value.trim(),
        Category: deriveCategoryFromRole(role),
        Role: role,
        StudentID: document.getElementById('wz-mb-student-id').value.trim(),
        Affiliation: document.getElementById('wz-mb-affiliation').value.trim(),
        Note: document.getElementById('wz-mb-note').value.trim(),
        Email: document.getElementById('wz-mb-email').value.trim(),
        FiscalYear: document.getElementById('wz-mb-fiscal-year').value,
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
    closeMemberWizard();
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

// ---- 削除 ----

function deleteFromMbWizard() {
    if (!editingMemberId) return;
    const id = editingMemberId;
    closeMemberWizard();
    confirmDeleteMember(id);
}

function confirmDeleteMember(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => confirmDeleteMember(id));
        return;
    }
    const m = membersData.find(x => x.ID === id);
    if (!m) return;

    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <h3>「${escapeHtml(m.Name)}」を削除</h3>
            <p>この操作は元に戻せます（削除直後のみ）。</p>
            <div class="confirm-dialog-actions">
                <button class="btn btn-secondary" onclick="this.closest('.confirm-dialog-overlay').remove()">キャンセル</button>
                <button class="btn btn-danger" id="confirm-del-mb-btn">削除する</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    bindModalEscape(overlay, () => overlay.remove());

    overlay.querySelector('#confirm-del-mb-btn').onclick = () => {
        overlay.remove();
        deleteMember(id);
    };
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
                membersData.push(saved);
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
    bindModalEscape(document.getElementById('year-copy-modal'), closeYearCopyModal);
}

function renderYearCopyMembers() {
    const srcYear = parseInt(document.getElementById('yc-source-year').value);
    const members = membersData.filter(m => getMemberFiscalYear(m) === srcYear);

    const sortedMembers = sortByRoleThenName(members);

    const list = document.getElementById('yc-member-list');
    if (sortedMembers.length === 0) {
        list.innerHTML = '<p class="text-hint" style="text-align:center; padding:20px;">この年度にメンバーがいません</p>';
        return;
    }
    list.innerHTML = sortedMembers.map(m => {
        const role = getEffectiveRole(m);
        const roleInfo = role ? getRoleDisplay(role) : null;
        const badge = roleInfo
            ? `<span class="cat-badge" style="background:${roleInfo.color};font-size:0.7rem;">${escapeHtml(role)}</span>`
            : '';
        return `<label style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid var(--bg-muted); cursor:pointer;">
            <input type="checkbox" value="${m.ID}" checked class="yc-check">
            <span style="flex:1;">${escapeHtml(m.Name || '')} ${badge}</span>
            <span class="text-hint" style="font-size:0.8rem;">${escapeHtml(m.StudentID || '')}</span>
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

    const results = await Promise.allSettled(newMembers.map(item => api.save('members', item)));
    let failCount = 0;
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            const idx = membersData.findIndex(m => m.ID === newMembers[i].ID);
            if (idx >= 0) membersData[idx] = r.value;
        } else {
            failCount++;
        }
    });
    api.saveCache('members', membersData);
    if (failCount > 0) {
        toast(`${failCount}名の保存に失敗しました。再読み込みしてください。`, 'error');
        refreshData();
    }
}
