/**
 * メンバーリストページ
 * 年度別表示。全メンバー（アドバイザー・コーディネーター含む）を統一表示。
 * 新規作成・編集はステップウィザード形式。編集・削除ボタンは行内に常時表示。
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
    { label: '学部学科・メモ' }
];

// 学籍番号・教職員番号を大文字半角英数字へ正規化する。
// 学年フィルタ（gradeOf: 先頭2文字）と院生判定（isGradStudent: 5文字目の M）が
// 番号の形式に依存するため、全角・小文字のまま保存されると絞り込みに現れなくなる。
function normalizeStudentId(s) {
    return String(s || '')
        .replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\s+/g, '')
        .toUpperCase();
}

// gradeOf / isGradStudent は app.js の共通ヘルパーを使う（出欠・発表者選択などとも共有）。

// 役職の導出は app.js の memberRoleOf を使用

// 検索フィールド定義（search.js の createSearcher 用）。重要度順に並べる。
// Furigana を含めるので「やまだ」等の読みでも Name にたどり着ける。
const MEMBER_SEARCH_FIELDS = [
    { key: 'name', label: '名前', weight: 100, get: m => [m.Name, m.Furigana] },
    { key: 'role', label: '役職', weight: 70, get: m => [memberRoleOf(m)] },
    { key: 'attr', label: '所属', weight: 50, get: m => [m.Affiliation, m.StudentID] },
    { key: 'note', label: '備考', weight: 30, get: m => [m.Note, m.Email, m.Extension] }
];
const memberSearcher = createSearcher(() => membersData, MEMBER_SEARCH_FIELDS);

function memberSuggestSources() {
    const names = new Set(), affils = new Set();
    membersData.forEach(m => {
        if (m.Name) names.add(m.Name);
        if (m.Affiliation) affils.add(m.Affiliation);
    });
    return [
        { label: '名前', values: [...names] },
        { label: '所属', values: [...affils] }
    ];
}

// 「自分の名前」として端末に記憶されている ID（出欠回答などで選択した名前。vote-widget.js と同じキー）
function myMemberId() {
    try { return localStorage.getItem('scicomi_vote_member') || ''; } catch (e) { return ''; }
}

// m が「自分」の記録か。年度ごとに別レコード（ID が違う）になるため、
// 選択中の名前と同じ学籍番号（無ければ同名）のレコードも本人とみなす。
function isMyMember(m) {
    const myId = myMemberId();
    if (!myId || !m) return false;
    if (m.ID === myId) return true;
    const me = membersData.find(x => x.ID === myId);
    if (!me) return false;
    const sid = normalizeStudentId(me.StudentID);
    if (sid) return normalizeStudentId(m.StudentID) === sid;
    const nm = (me.Name || '').trim();
    return !!nm && (m.Name || '').trim() === nm;
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
        // 行タップで詳細ポップアップを開く（全行共通）
        const row = e.target.closest('tr[data-id][data-detail]');
        if (row) openMemberDetailModal(row.dataset.id, membersData, { onEdit: openMemberWizard });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bootPage('members', init);
});

async function init() {
    bindOverlayClose(document.getElementById('year-copy-modal'), closeYearCopyModal);
    _bindMemberTableDelegation();

    // 検索窓（デバウンス・サジェスト・キーボード操作は search.js が面倒を見る）
    attachSearchBox(document.getElementById('member-search'), {
        onSearch: (v) => {
            memberSearchKw = (v || '').trim();
            renderMembers();
        },
        suggestSources: memberSuggestSources,
        historyKey: 'members'
    });

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
        // キャッシュも無く一覧が空のままなら、「読み込み中」を残さずエラー＋再試行を表示
        if (membersData.length === 0) {
            const tbody = document.getElementById('members-tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-state">
                <div class="empty-text">データを読み込めませんでした</div>
                <div class="empty-hint">${escapeHtml(humanizeApiError(e))}</div>
                <button type="button" class="btn btn-secondary" onclick="refreshData(true)">再読み込み</button>
            </td></tr>`;
        }
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
        const role = memberRoleOf(m);
        if (role === 'アドバイザー' || role === 'コーディネーター') return;
        if (isGradStudent(m)) { hasGrad = true; return; }
        const g = gradeOf(m);
        if (g && /^\d[A-Z]$/.test(g)) grades.add(g);
    });
    // 学年チップも一覧と同じ年度サイクル順（上級生 → 新入生）で並べる
    const list = [...grades].sort((a, b) => {
        const ka = digitCycleKey(a[0]), kb = digitCycleKey(b[0]);
        if (ka !== kb) return ka - kb;
        return a.localeCompare(b);
    });
    if (hasGrad) list.push('院生');
    if (list.length === 0) {
        row.style.display = 'none';
        wrap.innerHTML = '';
        return;
    }
    row.style.display = 'inline-flex'; // 区分チップと同じ行に並べる（span ラッパーのため flex 指定）
    wrap.innerHTML = list.map(g =>
        `<button class="filter-chip ${gradeFilter === g ? 'active' : ''}" aria-pressed="${gradeFilter === g}" data-action="mb-grade-filter" data-grade="${escapeAttr(g)}">${g === '院生' ? '院生' : g + '生'}</button>`
    ).join('');
}

registerActions({ 'mb-grade-filter': el => setGradeFilter(el.dataset.grade) });   // onclick 属性に値を埋め込まない(app.js の registerActions 参照)

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
        const ra = memberRoleOf(a), rb = memberRoleOf(b);
        const oa = roleOrder[ra] ?? (ra ? 10 : 99);
        const ob = roleOrder[rb] ?? (rb ? 10 : 99);
        if (oa !== ob) return oa - ob;
        return (a.Name || '').localeCompare(b.Name || '');
    });
}

// 学籍番号の先頭1桁は入学年度の下1桁で、年度ごとに 0→9 でサイクルする。
// 選択中年度の下1桁が「最新の入学年」なので、その翌数字（=最も古い在籍学年）から
// 昇順に並ぶキーを返す。例) 2022年度に 8,9,0,1,2 がいる場合はこの順になる。
function digitCycleKey(ch) {
    const d = parseInt(ch, 10);
    if (isNaN(d)) return 10; // 数字で始まらない・空の番号は学年グループの最後へ
    const newest = selectedFiscalYear % 10;
    return ((d - newest - 1) % 10 + 10) % 10;
}

// メンバー（学生）タブの表示順:
//   1) 院生は必ず一番下（役職の有無より優先）
//   2) 役職もちは一番上（CONFIG.MEMBER_ROLES の順 → その他の役職）
//   3) 学籍番号先頭数字の年度サイクル順（上級生 → 新入生）
//   4) 名前順
function sortStudents(list) {
    const roleOrder = {};
    CONFIG.MEMBER_ROLES.forEach((r, i) => { roleOrder[r.value] = i; });
    return list.slice().sort((a, b) => {
        const ga = isGradStudent(a) ? 1 : 0, gb = isGradStudent(b) ? 1 : 0;
        if (ga !== gb) return ga - gb;
        const ra = memberRoleOf(a), rb = memberRoleOf(b);
        const oa = ra ? (roleOrder[ra] ?? 10) : 99;
        const ob = rb ? (roleOrder[rb] ?? 10) : 99;
        if (oa !== ob) return oa - ob;
        const da = digitCycleKey(((a.StudentID || '').trim())[0]);
        const db = digitCycleKey(((b.StudentID || '').trim())[0]);
        if (da !== db) return da - db;
        return (a.Name || '').localeCompare(b.Name || '', 'ja');
    });
}

function getMemberFiscalYear(m) {
    if (m.FiscalYear) return parseInt(m.FiscalYear);
    return currentFiscalYear();
}

function renderMembers() {
    let fyMembers = membersData.filter(m => getMemberFiscalYear(m) === selectedFiscalYear);

    // タブは「メンバー / 教職員」の2つ。教職員=コーディネーター＋アドバイザー
    // （人数が少ないため1タブに統合。区別は役職バッジで分かる）
    fyMembers = fyMembers.filter(m => {
        const role = memberRoleOf(m);
        const isStaff = role === 'コーディネーター' || role === 'アドバイザー';
        return roleFilter === 'staff' ? isStaff : !isStaff;
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

    // キーワードは検索エンジンで照合（かな・全角半角の揺れ吸収 + AND/-除外/"フレーズ"。search.js）。
    // メンバー一覧は学年・役職の並び順自体に意味があるため、スコア順ソートはしない。
    const pq = memberSearchKw ? parseSearchQuery(memberSearchKw) : null;
    if (pq) {
        base = base.filter(m => memberSearcher.matchItem(m, pq));
    }

    // 学生タブは学番サイクル順、コーディネーター・アドバイザーは役職→名前順
    const sorted = roleFilter === 'member' ? sortStudents(base) : sortByRoleThenName(base);
    if (pq) announceSearchResult(`検索結果 ${sorted.length}件`);

    const thead = document.getElementById('members-thead');
    const tbody = document.getElementById('members-tbody');
    const isAdmin = api.isAdmin();
    const isStaffTab = roleFilter === 'staff';
    const colCount = isStaffTab ? 5 : 4;

    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? 'inline-block' : 'none';
    });

    if (thead) {
        thead.innerHTML = isStaffTab
            ? `<tr><th>教職員番号</th><th>名前</th><th>役職</th><th>メールアドレス</th><th style="width:1px;"></th></tr>`
            : `<tr><th>学籍番号</th><th>名前</th><th>役職</th><th style="width:1px;"></th></tr>`;
    }

    if (sorted.length === 0) {
        // 検索・絞り込み中は「条件を変えれば見つかるかもしれない」ことが分かるようにする
        const hasFilter = memberSearchKw || gradeFilter;
        tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">
            <span class="empty-icon">&#x1F465;</span>
            <div class="empty-text">該当するメンバーはいません</div>
            ${hasFilter ? '<div class="empty-hint">検索キーワードや絞り込みを変更してみてください</div>' : ''}
        </td></tr>`;
    } else {
        // 検索中はマッチ部分をハイライト表示（search.js の highlightText は escape 込み）
        const hlTerms = pq ? searchQueryTerms(pq) : [];
        const hl = v => pq ? highlightText(v || '', hlTerms) : escapeHtml(v || '');
        tbody.innerHTML = sorted.map(m => {
            const role = memberRoleOf(m);
            const roleInfo = role ? getRoleDisplay(role) : null;
            const roleBadge = roleInfo
                ? `<span class="cat-badge" style="background:${roleInfo.color};">${escapeHtml(role)}</span>`
                : '';
            // 学籍番号・名前・役職を別セルに分けておくと、範囲選択してExcelにコピペした時に
            // 列がきれいに分かれる（1セルに複数行を詰め込まない）。ふりがなは表では出さず、
            // タップした詳細ポップアップ側でのみ確認できるようにする。
            const nameCell = `<td class="cell-name">${hl(m.Name)}</td>`;
            const roleCell = `<td class="cell-role">${roleBadge}</td>`;
            // 削除はゴミ箱に入るので全員に表示する（期限までは誰でも戻せる）。
            // 編集は、管理者か、自分の名前として選択中の行だけ
            const canEdit = isAdmin || isMyMember(m);
            const actionCell = `
                <td data-action-cell>
                    <div class="inline-actions">
                        ${canEdit ? '<button class="inline-action-btn" data-action="edit" title="このメンバーを編集">編集</button>' : ''}
                        <button class="inline-action-btn danger" data-action="delete" title="このメンバーを削除">削除</button>
                    </div>
                </td>`;

            // どの行もタップで詳細ポップアップを開ける（各項目はポップアップ側でコピー可能）
            if (isStaffTab) {
                return `
                <tr data-id="${escapeAttr(m.ID)}" data-detail="1" class="clickable-row" title="タップで詳細を表示">
                    <td>${hl(m.StudentID)}</td>
                    ${nameCell}
                    ${roleCell}
                    <td style="white-space:nowrap;">${hl(m.Email)}</td>
                    ${actionCell}
                </tr>`;
            }

            return `
            <tr data-id="${escapeAttr(m.ID)}" data-detail="1" class="clickable-row" title="タップで詳細を表示">
                <td class="card-inline">${hl(m.StudentID)}</td>
                ${nameCell}
                ${roleCell}
                ${actionCell}
            </tr>`;
        }).join('');
    }
}

// ---- ウィザード形式の新規作成・編集 ----

function openMemberWizard(editId) {
    editingMemberId = editId || null;
    mbWizardStep = 0;

    const m = editingMemberId ? membersData.find(x => x.ID === editingMemberId) : null;
    const isEdit = !!m;
    const isAdmin = api.isAdmin();
    const isSelf = isMyMember(m);

    // 編集は管理者か、自分の名前として選択中の本人のみ（削除は誰でも可でゴミ箱へ入る。新規追加は誰でも可）
    if (isEdit && !isAdmin && !isSelf) {
        toast('編集できるのは、自分の名前として選択しているメンバーだけです', 'info', 4000);
        editingMemberId = null;
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'mb-wizard-overlay';
    overlay.className = 'wizard-overlay';

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true">
            <div class="wizard-header">
                <h2 class="wizard-title">${isEdit ? 'メンバー編集' : 'メンバー追加'}</h2>
                <p class="wizard-subtitle">${isEdit ? escapeHtml(m.Name || '') : 'ステップに沿って入力してください'}</p>
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
                        <label class="e1-label">学生証番号 / 教職員番号 *</label>
                        <input id="wz-mb-student-id" class="e1-input" type="text" placeholder="例: 5CSC1234" value="${escapeAttr(m ? m.StudentID : '')}">
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">名前 *</label>
                        <input id="wz-mb-name" class="e1-input" type="text" placeholder="例: 山田 太郎" value="${escapeAttr(m ? m.Name : '')}">
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">ふりがな</label>
                        <input id="wz-mb-furigana" class="e1-input" type="text" placeholder="例: やまだ たろう" value="${escapeAttr(m ? m.Furigana : '')}">
                    </div>
                </div>

                <!-- Step 2: 学部学科・メモ -->
                <div class="wizard-step" data-step="1">
                    <div class="wizard-step-label">Step 2 / ${MB_WIZARD_STEPS.length} &mdash; ${MB_WIZARD_STEPS[1].label}</div>
                    <div class="e1-group">
                        <label class="e1-label">学部学科</label>
                        <input id="wz-mb-affiliation" class="e1-input" type="text" placeholder="例: 理学部 物理学科" value="${escapeAttr(m ? m.Affiliation : '')}">
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">メモ</label>
                        <textarea id="wz-mb-note" class="e1-input" rows="2" placeholder="任意のメモ">${escapeHtml(m ? m.Note : '')}</textarea>
                    </div>
                </div>
            </div>
            <div class="wizard-footer">
                ${isEdit ? '<button class="btn btn-danger" onclick="deleteFromMbWizard()">削除</button>' : ''}
                <div class="wizard-footer-spacer"></div>
                <button class="btn btn-text" onclick="closeMemberWizard()">キャンセル</button>
                <button id="wz-mb-prev-btn" class="btn btn-secondary" onclick="mbWizardPrev()" style="display:none;">戻る</button>
                <button id="wz-mb-next-btn" class="btn btn-primary" onclick="mbWizardNext()">次へ</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    // 領域外クリック・Esc は、入力に変更があれば破棄確認を挟む（誤タップで編集内容が消えないように）
    bindEditDismissGuard(overlay, closeMemberWizard);
    trapFocus(overlay.querySelector('.wizard-panel'));
    // 学籍番号は入力確定時に大文字半角英数字へ自動変換する
    const sidInput = document.getElementById('wz-mb-student-id');
    if (sidInput) sidInput.addEventListener('blur', () => { sidInput.value = normalizeStudentId(sidInput.value); });
    // テキスト入力中に Enter で次のステップへ（キーボードだけで完結できるように）
    overlay.querySelector('.wizard-body').addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || ev.isComposing) return;
        const t = ev.target;
        if (t.tagName === 'TEXTAREA') return;
        ev.preventDefault();
        mbWizardNext();
    });
    setTimeout(() => document.getElementById('wz-mb-student-id').focus(), 80);
}

function closeMemberWizard() {
    const overlay = document.getElementById('mb-wizard-overlay');
    if (overlay) overlay.remove();
    editingMemberId = null;
    mbWizardStep = 0;
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
        const sidEl = document.getElementById('wz-mb-student-id');
        sidEl.value = normalizeStudentId(sidEl.value);
        if (!sidEl.value) {
            toast('学生証番号 / 教職員番号を入力してください', 'error');
            sidEl.focus();
            return;
        }
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
    if (!normalizeStudentId(document.getElementById('wz-mb-student-id').value)) {
        toast('学生証番号 / 教職員番号を入力してください', 'error');
        return;
    }

    const existing = editingMemberId ? membersData.find(m => m.ID === editingMemberId) : null;
    const isNew = !editingMemberId;
    // 役職・メール・内線・緊急連絡先は編集画面に出さないため、既存の値をそのまま引き継ぐ
    const role = existing ? memberRoleOf(existing) : '';
    const item = {
        ID: editingMemberId || genId('mb_'),
        Name: name,
        Furigana: document.getElementById('wz-mb-furigana').value.trim(),
        Category: existing ? (existing.Category || deriveCategoryFromRole(role)) : deriveCategoryFromRole(role),
        Role: role,
        StudentID: normalizeStudentId(document.getElementById('wz-mb-student-id').value),
        Affiliation: document.getElementById('wz-mb-affiliation').value.trim(),
        Note: document.getElementById('wz-mb-note').value.trim(),
        Email: existing ? (existing.Email || '') : '',
        Extension: existing ? (existing.Extension || '') : '',
        EmergencyContact: existing ? (existing.EmergencyContact || '') : '',
        FiscalYear: existing ? (existing.FiscalYear || currentFiscalYear()) : (selectedFiscalYear || currentFiscalYear()),
        Active: 'true'
    };

    if (editingMemberId && existing) item._baseUpdatedAt = existing.UpdatedAt || '';

    // 保存は妨げない軽い検証（入力ミスの早期発見用）。
    // 学籍番号が数字始まりでないと学年フィルタ・並び順に反映されない。
    if (!item.Role && item.StudentID && !/^\d/.test(item.StudentID)) {
        toast('学籍番号が数字で始まっていません。学年の絞り込み・並び順に反映されない場合があります', 'info', 5000);
    }

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
    const m = membersData.find(x => x.ID === id);
    if (!m) return;
    showConfirmDialog({
        title: `「${m.Name}」を削除`,
        message: TRASH_KEEP_NOTE + '（出欠の回答も一緒に戻ります）',
        okLabel: '削除する',
        danger: true,
        onOk: () => deleteMember(id)
    });
}

async function deleteMember(id) {
    const idx = membersData.findIndex(m => m.ID === id);
    if (idx < 0) return;
    const backup = membersData[idx];

    membersData.splice(idx, 1);
    api.saveCache('members', membersData);
    renderMembers();

    let trashId = '';
    try {
        trashId = await api.delete('members', id);
    } catch (e) {
        membersData.splice(idx, 0, backup);
        api.saveCache('members', membersData);
        renderMembers();
        toast('削除失敗: ' + e.message, 'error');
        return;
    }

    toastUndo(
        `「${backup.Name}」をゴミ箱に移動しました`,
        async () => {
            try {
                const saved = (await api.restoreTrash(trashId)).item || backup;
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
        10000
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
    const tgtYear = parseInt(document.getElementById('yc-target-year').value);
    const members = membersData.filter(m => getMemberFiscalYear(m) === srcYear);

    // 登録先年度に既にいる人（同名 or 同学籍番号）は二重登録を防ぐため、
    // 既定でチェックを外し「登録済み」と表示する
    const inTarget = membersData.filter(m => getMemberFiscalYear(m) === tgtYear);
    const tgtNames = new Set(inTarget.map(m => (m.Name || '').trim()).filter(Boolean));
    const tgtIds = new Set(inTarget.map(m => (m.StudentID || '').trim()).filter(Boolean));

    const sortedMembers = sortByRoleThenName(members);

    const list = document.getElementById('yc-member-list');
    if (sortedMembers.length === 0) {
        list.innerHTML = '<p class="text-hint" style="text-align:center; padding:20px;">この年度にメンバーがいません</p>';
        return;
    }
    list.innerHTML = sortedMembers.map(m => {
        const role = memberRoleOf(m);
        const roleInfo = role ? getRoleDisplay(role) : null;
        const badge = roleInfo
            ? `<span class="cat-badge" style="background:${roleInfo.color};font-size:0.7rem;">${escapeHtml(role)}</span>`
            : '';
        const sid = (m.StudentID || '').trim();
        const dup = tgtNames.has((m.Name || '').trim()) || (sid && tgtIds.has(sid));
        const dupBadge = dup
            ? ' <span class="cat-badge" style="background:#9ca3af;font-size:0.7rem;" title="登録先年度に同名または同じ学籍番号のメンバーがいます">登録済み</span>'
            : '';
        return `<label style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid var(--bg-muted); cursor:pointer;">
            <input type="checkbox" value="${escapeAttr(m.ID)}" ${dup ? '' : 'checked'} class="yc-check">
            <span style="flex:1;">${escapeHtml(m.Name || '')} ${badge}${dupBadge}</span>
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
        showConfirmDialog({
            title: `${targetYear}年度に追加登録`,
            message: `${targetYear}年度には既に${existingInTarget.length}名のメンバーがいます。選択した${selectedIds.length}名を追加しますか？`,
            okLabel: '追加する',
            onOk: () => doYearCopy(targetYear, selectedIds)
        });
        return;
    }
    await doYearCopy(targetYear, selectedIds);
}

async function doYearCopy(targetYear, selectedIds) {
    const sourceMembers = membersData.filter(m => selectedIds.includes(m.ID));
    const newMembers = sourceMembers.map(m => ({
        ID: genId('mb_'),
        Name: m.Name,
        Furigana: m.Furigana || '',
        Category: m.Category || 'member',
        Role: memberRoleOf(m),
        StudentID: normalizeStudentId(m.StudentID || ''),
        Affiliation: m.Affiliation || '',
        Note: '',
        Email: m.Email || '',
        Extension: m.Extension || '',
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
