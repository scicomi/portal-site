// イベントデータ（サーバーから取得してここに保持）
let eventsData = [];
// 参加バッジ・プレビューモーダルの投票UIに使う（listAll で一括取得）
let membersData = [];
let allVotesData = null;   // null = 未取得

// 共通ウィザード（event-wizard.js）が読み書きするこのページのデータ
configureEventWizard({
    list: () => eventsData,
    rerender: () => renderEvents(),
    onConflict: () => refreshData()
});

// ---- グローバルキーボードショートカット ----
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        // フォーム編集中は Ctrl+S だけ拾う
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            const saveBtn = document.querySelector('#qc-save, .modal-content .btn-primary:not(.hidden)');
            if (saveBtn) { e.preventDefault(); saveBtn.click(); }
        }
        return;
    }
    // ウィザード・確認ダイアログ・認証モーダル表示中や修飾キー付きでは
    // ページ用ショートカット（n）を発動しない。/ と ? は search.js が全ページ共通で扱う。
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.wizard-overlay, .confirm-dialog-overlay, #admin-auth-modal, #pw-modal')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openNewEventModal(); }
});

// ---- フィルタ状態 ----
let filterState = {
    keyword: '',
    category: 'all',
    period: 'upcoming'
};

// ---- 検索・絞り込み状態の URL 同期（?q= / ?cat= / ?period=） ----
// 検索結果をリロード・共有できるようにする。?duplicate= 等の既存パラメータとは共存させる。

// 指定パラメータだけを URL から取り除く（?q= 等の他のパラメータは保持する）
function stripUrlParams(names) {
    const p = new URLSearchParams(location.search);
    names.forEach(n => p.delete(n));
    const qs = p.toString();
    history.replaceState(null, '', qs ? 'events.html?' + qs : 'events.html');
}

function syncFilterToUrl() {
    const p = new URLSearchParams(location.search);
    ['q', 'cat', 'period'].forEach(k => p.delete(k));
    if (filterState.keyword) p.set('q', filterState.keyword);
    if (filterState.category !== 'all') p.set('cat', filterState.category);
    if (filterState.period !== 'upcoming') p.set('period', filterState.period);
    const qs = p.toString();
    history.replaceState(null, '', qs ? 'events.html?' + qs : 'events.html');
}

// init() の冒頭で呼ぶ。period のセレクトは選択肢がデータ読込後に作られるため、
// ここでは filterState に入れるだけで良い（buildPeriodFilterOptions が反映する）。
function restoreFilterFromUrl() {
    const p = new URLSearchParams(location.search);
    const q = p.get('q');
    const cat = p.get('cat');
    const period = p.get('period');
    if (q) {
        filterState.keyword = q.trim();
        const input = document.getElementById('event-search');
        if (input) input.value = q;
    }
    if (cat) {
        filterState.category = cat;
        document.querySelectorAll('.filter-chip[data-cat]').forEach(c => {
            const isActive = c.dataset.cat === cat;
            c.classList.toggle('active', isActive);
            c.setAttribute('aria-pressed', String(isActive));
        });
    }
    if (period) filterState.period = period;
}

// 「リセット」ボタン（キーワード・カテゴリ・期間のいずれかが初期値以外の時だけ表示）
function updateResetButton() {
    const btn = document.getElementById('filter-reset-btn');
    if (!btn) return;
    const active = !!(filterState.keyword || filterState.category !== 'all' || filterState.period !== 'upcoming');
    btn.classList.toggle('hidden', !active);
}

function resetFilters() {
    filterState.keyword = '';
    filterState.category = 'all';
    filterState.period = 'upcoming';
    const input = document.getElementById('event-search');
    if (input) input.value = '';
    document.querySelectorAll('.filter-chip[data-cat]').forEach(c => {
        const isActive = c.dataset.cat === 'all';
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });
    const sel = document.getElementById('period-filter');
    if (sel) sel.value = 'upcoming';
    syncFilterToUrl();
    renderEvents();
}

function buildPeriodFilterOptions() {
    const sel = document.getElementById('period-filter');
    if (!sel) return;
    const fySet = new Set();
    eventsData.forEach(e => {
        const fy = getFiscalYear(e.Date);
        if (fy) fySet.add(fy);
    });
    const sorted = [...fySet].sort((a, b) => b - a);
    let html = '<option value="upcoming">今後</option>';
    sorted.forEach(fy => {
        html += `<option value="fy_${fy}">${fy}年度</option>`;
    });
    sel.innerHTML = html;
    sel.value = filterState.period;
}

// ---- テーブル行のイベント委譲（XSS 対策: onclick に ID を埋め込まない） ----
function _bindEventTableDelegation() {
    const tbody = document.getElementById('events-tbody');
    if (!tbody) return;
    tbody.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
            const action = actionEl.dataset.action;
            if (action === 'open' || action === 'vote') return;
            e.stopPropagation();
            if (action === 'stoprow') return;
            const row = actionEl.closest('tr[data-id]');
            if (!row) return;
            const id = row.dataset.id;
            if (action === 'edit') openEventWizard(id);
            else if (action === 'delete') confirmDeleteEvent(id);
            else if (action === 'duplicate') {
                const src = eventsData.find(x => x.ID === id);
                if (src) startNewEvent(src.Category || 'normal', src);
            }
            return;
        }
        if (e.target.closest('[data-action-cell]')) return;
        const row = e.target.closest('tr[data-id]');
        if (!row) return;
        location.href = `event-series.html?event=${encodeURIComponent(row.dataset.id)}`;
    });
}

// ---- 起動 ----
document.addEventListener('DOMContentLoaded', () => {
    bootPage('events', init);
});

async function init() {
    // 旧リンク互換: ?event=<ID> はイベント詳細（シリーズページ）へ転送する（詳細モーダルは廃止）。
    if (redirectLegacyEventParam()) return;

    _bindEventTableDelegation();

    // URL の ?q= / ?cat= / ?period= から検索・絞り込み状態を復元（共有リンク・リロード対応）
    restoreFilterFromUrl();

    // 検索窓（デバウンス・サジェスト・キーボード操作は search.js が面倒を見る）
    attachSearchBox(document.getElementById('event-search'), {
        onSearch: (v) => {
            filterState.keyword = (v || '').trim();
            syncFilterToUrl();
            renderEvents();
        },
        suggestSources: eventSuggestSources,
        historyKey: 'events',
        helpShortcuts: [
            ['n', '新しい予定を追加'],
            ['Ctrl+S', '編集モーダルの保存']
        ]
    });

    // ?action=new はデータ読込を待たずに新規作成モーダルを開ける
    if (new URLSearchParams(location.search).get('action') === 'new') {
        stripUrlParams(['action']);
        openNewEventModal();
    }

    // キャッシュ即表示
    const cached = api.loadCache('events');
    if (cached && cached.items && cached.items.length > 0) {
        eventsData = cached.items;
    }
    // メンバー・投票もキャッシュがあれば先に使う（参加バッジの分母・モーダル投票UI用）
    membersData = ((api.loadCache('members') || {}).items) || [];
    const cachedVotes = api.loadCache('votes');
    if (cachedVotes && Array.isArray(cachedVotes.items)) {
        allVotesData = cachedVotes.items;
        rebuildVotesByEvent();
    }

    populateDatalists();
    // キャッシュがある時だけ即描画。無い時は HTML の「読み込み中...」行を残し、
    // refreshData 完了後に renderEvents で置き換える（空表示と読込中を取り違えない）。
    if (cached && cached.items && cached.items.length > 0) {
        buildPeriodFilterOptions();
        renderEvents();
        handleUrlActionParams();
    }

    if (cached) updateSyncStatus('cached', cached.timestamp);
    else updateSyncStatus('initial-loading');

    refreshData();
}

function redirectLegacyEventParam() {
    const id = new URLSearchParams(location.search).get('event');
    if (!id) return false;
    location.replace('event-series.html?event=' + encodeURIComponent(id));
    return true;
}

// ?duplicate=<ID> は複製して新規作成を開く
// （シリーズ詳細ページの「編集」「複製」ボタンの遷移先）。
// データ未取得のうちは何もせず、refreshData 後に再度試みる（一度だけ実行）。
let urlActionHandled = false;
function handleUrlActionParams() {
    if (urlActionHandled) return;
    const params = new URLSearchParams(location.search);
    const dupId = params.get('duplicate');
    if (!dupId) return;
    const target = eventsData.find(e => e.ID === dupId);
    if (!target) return; // まだ読み込まれていない → リフレッシュ後に再試行
    urlActionHandled = true;
    stripUrlParams(['duplicate']);
    startNewEvent(target.Category || 'normal', target);
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
    try {
        // listAll で events / members / votes を1往復で取得する
        // （参加バッジの分母表示・モーダル内の投票UIにメンバーと投票が要るため）
        const all = await api.listAll();
        eventsData = all.events || [];
        api.saveCache('events', eventsData);
        membersData = all.members || [];
        api.saveCache('members', membersData);
        if (all.experiments) {
            api.saveCache('experiments', all.experiments);
            populateDatalists(); // 実験名の入力候補・実在チェックを最新のマスタに更新する
        }
        allVotesData = all.votes;
        api.saveCache('votes', allVotesData);
        rebuildVotesByEvent();
        buildPeriodFilterOptions();
        renderEvents();
        handleUrlActionParams();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
        // キャッシュも無く一覧が空のままなら、「読み込み中」を残さずエラー＋再試行を表示
        if (eventsData.length === 0) {
            const tbody = document.getElementById('events-tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-state">
                <div class="empty-text">データを読み込めませんでした</div>
                <div class="empty-hint">${escapeHtml(humanizeApiError(e))}</div>
                <button type="button" class="btn btn-secondary" onclick="refreshData(true)">再読み込み</button>
            </td></tr>`;
        }
    }
}

// ---- 投票（出欠）集計: 一覧の参加人数バッジ用 ----
let votesByEvent = {};

// allVotesData（生の投票）から集計を作り直す。スタッフ（コーディネーター・アドバイザー）の
// 投票は集計から除外する（他ページの集計と基準を揃えた）。
function rebuildVotesByEvent() {
    votesByEvent = {};
    const perEvent = {};
    (allVotesData || []).forEach(v => (perEvent[v.eventId] || (perEvent[v.eventId] = [])).push(v));
    Object.keys(perEvent).forEach(id => {
        const g = groupVotesByStatus(perEvent[id], membersData);
        votesByEvent[id] = { attend: g.attend.length, absent: g.absent.length, undecided: g.undecided.length };
    });
}

// ---- 出欠投票（テーブル行内ドロップダウン） ----

function populateVoteMemberSelector() {
    const bar = document.getElementById('ev-vote-member-bar');
    const sel = document.getElementById('ev-vote-member-select');
    if (!bar || !sel) return;
    const eligible = voteEligibleMembers(membersData);
    if (eligible.length === 0) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const saved = getSavedVoteMemberId();
    const groups = groupMembersByGrade(eligible);
    sel.innerHTML = '<option value="">-- 選択 --</option>' +
        groups.map(g => `<optgroup label="${escapeAttr(g.label)}">${g.members.map(m => `<option value="${escapeAttr(m.ID)}" ${m.ID === saved ? 'selected' : ''}>${escapeHtml(m.Name)}</option>`).join('')}</optgroup>`).join('');
    sel.onchange = () => {
        setSavedVoteMemberId(sel.value);
        renderEvents();
    };
}

function getMyVoteForEvent(eventId) {
    const memberId = getSavedVoteMemberId();
    if (!memberId || !allVotesData) return null;
    return allVotesData.find(v => v.eventId === eventId && v.memberId === memberId) || null;
}

// 出欠セレクトの change 委譲（イベント ID は既存の data-vote-event から取る。onchange 属性に ID を埋め込まない）
registerActions({ 'ev-inline-vote': el => onInlineVoteChange(el, el.dataset.voteEvent) });

function onInlineVoteChange(selectEl, eventId) {
    const memberId = getSavedVoteMemberId();
    if (!memberId) { toast('先に名前を選択してください', 'info'); selectEl.value = ''; return; }
    const status = selectEl.value;
    if (!status) return;
    const ev = eventsData.find(e => e.ID === eventId);
    if (!ev) return;
    const votes = (allVotesData || []).filter(v => v.eventId === eventId);
    submitVoteOptimistic({
        event: ev, votes, memberId, status,
        rerender: () => {
            rebuildVotesByEvent();
            renderEvents();
        },
        onChange: (updatedVotes) => {
            allVotesData = (allVotesData || []).filter(v => v.eventId !== eventId).concat(updatedVotes);
            api.saveCache('votes', allVotesData);
            rebuildVotesByEvent();
        }
    });
}

// ---- 検索・フィルタ ----

// 検索フィールド定義（search.js の createSearcher 用）。重要度順に並べる。
// 実験名・発表者は PartsList（配列。旧データは JSON 文字列）に入っているため normalizeParts（app.js）で展開する。
const EVENT_SEARCH_FIELDS = [
    { key: 'title', label: 'タイトル', weight: 100, aliases: ['title', 'タイトル'], get: e => [e.Title, e.MeetingNumber ? `第${e.MeetingNumber}回 ${e.Title || ''}` : ''] },
    { key: 'location', label: '場所', weight: 80, aliases: ['location', '場所'], get: e => [e.Location] },
    {
        key: 'person', label: '人', weight: 70, aliases: ['person', '人', '担当'], get: e => {
            const out = [e.AdminKyoka, e.AdminHoukoku];
            normalizeParts(e.PartsList).forEach(p => out.push(...(p.presenters || [])));
            return out;
        }
    },
    { key: 'exp', label: '実験', weight: 50, get: e => normalizeParts(e.PartsList).map(p => p.name) },
    { key: 'other', label: '備考', weight: 30, get: e => [e.Audience, e.Remarks, e.Belongings] }
];
const eventSearcher = createSearcher(() => eventsData, EVENT_SEARCH_FIELDS);

// サジェスト候補（タイトル・場所・人名）。データは数百件規模なので都度組み立てで足りる。
function eventSuggestSources() {
    const titles = new Set(), locations = new Set(), people = new Set();
    eventsData.forEach(e => {
        if (e.Title) titles.add(e.Title);
        if (e.Location) locations.add(e.Location);
        [e.AdminKyoka, e.AdminHoukoku].forEach(v => { if (v) people.add(v); });
        normalizeParts(e.PartsList).forEach(p => (p.presenters || []).forEach(n => { if (n) people.add(n); }));
    });
    return [
        { label: 'タイトル', values: [...titles] },
        { label: '場所', values: [...locations] },
        { label: '人', values: [...people] }
    ];
}
function onCategoryFilter(cat) {
    filterState.category = cat;
    document.querySelectorAll('.filter-chip[data-cat]').forEach(c => {
        const isActive = c.dataset.cat === cat;
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });
    syncFilterToUrl();
    renderEvents();
}
function onPeriodFilter(period) {
    filterState.period = period;
    // 期間はチップからセレクトボックスへ変更（フィルタ行の要素数を減らすため）
    const sel = document.getElementById('period-filter');
    if (sel && sel.value !== period) sel.value = period;
    syncFilterToUrl();
    renderEvents();
}
// カテゴリ・期間の絞り込み（キーワードは renderEvents 側で検索エンジンに通す。
// スコア順ソートとマッチ理由バッジに検索結果のメタ情報が要るため）。
// 期間だけの絞り込みはチップ件数バッジでも使うため分離してある。
function applyPeriodFilter(events) {
    const today = todayISO();
    return events.filter(e => {
        if (filterState.period === 'upcoming') {
            const endDate = e.DateEnd || e.Date;
            if (endDate < today) return false;
        } else if (filterState.period.startsWith('fy_')) {
            const fy = parseInt(filterState.period.slice(3));
            if (getFiscalYear(e.Date) !== fy) return false;
        }
        return true;
    });
}

function applyFilters(events) {
    const periodFiltered = applyPeriodFilter(events);
    if (filterState.category === 'all') return periodFiltered;
    return periodFiltered.filter(e => (e.Category || 'normal') === filterState.category);
}

// 検索中はカテゴリチップに「その条件でのヒット件数」を添える（list = 期間絞り込み済みのヒット）。
// 検索していない時は元のラベルに戻す。
function updateCategoryChipCounts(list) {
    document.querySelectorAll('.filter-chip[data-cat]').forEach(chip => {
        const labelEl = chip.querySelector('.chip-label') || chip;
        if (!chip.dataset.baseLabel) chip.dataset.baseLabel = labelEl.textContent.trim();
        if (!list) { labelEl.textContent = chip.dataset.baseLabel; return; }
        const cat = chip.dataset.cat;
        const n = cat === 'all' ? list.length : list.filter(e => (e.Category || 'normal') === cat).length;
        labelEl.textContent = `${chip.dataset.baseLabel} (${n})`;
    });
}

// Render all events as table
function renderEvents() {
    const heading = document.getElementById('event-list-heading');
    const tbody = document.getElementById('events-tbody');

    // キーワードは検索エンジンで照合（正規化・演算子・スコア・マッチ理由付き）
    const kw = (filterState.keyword || '').trim();
    const pq = kw ? parseSearchQuery(kw) : null;
    const searchRes = pq ? eventSearcher.search(pq) : null;
    let searchMeta = null;
    let source = eventsData;
    if (searchRes) {
        searchMeta = {};
        searchRes.forEach(r => { searchMeta[r.item.ID] = r; });
        source = searchRes.map(r => r.item);
    }

    const filtered = applyFilters(source);
    const sorted = filtered.slice().sort((a, b) => {
        // 検索中は関連度スコア順、同点は従来の日付順
        if (searchMeta) {
            const d = (searchMeta[b.ID] ? searchMeta[b.ID].score : 0) - (searchMeta[a.ID] ? searchMeta[a.ID].score : 0);
            if (d !== 0) return d;
        }
        if (filterState.period !== 'upcoming') return (b.Date || '').localeCompare(a.Date || '');
        return (a.Date || '').localeCompare(b.Date || '');
    });

    let periodLabel = '今後の予定';
    if (filterState.period.startsWith('fy_')) {
        periodLabel = filterState.period.slice(3) + '年度の予定';
    }
    heading.textContent = searchMeta
        ? `検索結果 (${sorted.length}件)`
        : `${periodLabel} (${sorted.length}件)`;

    // チップ件数バッジ（検索中は期間絞り込み後のヒット数をカテゴリ別に表示）と「リセット」の表示更新
    updateCategoryChipCounts(searchMeta ? applyPeriodFilter(source) : null);
    updateResetButton();

    if (sorted.length === 0) {
        // 何を変えれば表示されるのかが分かるヒントを添える
        const hasNarrowing = filterState.keyword || filterState.category !== 'all';
        const hint = hasNarrowing
            ? '検索キーワードやカテゴリの絞り込みを変更してみてください'
            : (filterState.period === 'upcoming' && eventsData.length > 0
                ? '年度を選択すると過去の予定を確認できます'
                : '');
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">
            <span class="empty-icon">&#x1F4C5;</span>
            <div class="empty-text">該当する予定はありません</div>
            ${hint ? `<div class="empty-hint">${hint}</div>` : ''}
        </td></tr>`;
        populateVoteMemberSelector();
        return;
    }

    const isAdmin = api.isAdmin();
    const today = todayISO();
    const hlTerms = searchMeta ? searchQueryTerms(pq) : [];
    const memberId = getSavedVoteMemberId();
    tbody.innerHTML = sorted.map(ev => {
        const cat = getEventCategory(ev.Category);
        let displayTitle = ev.Title || '(無題)';
        if (cat.isMeeting && ev.MeetingNumber) {
            displayTitle = `第${ev.MeetingNumber}回 ${displayTitle}`;
        }
        const titleHtml = searchMeta ? highlightText(displayTitle, hlTerms) : escapeHtml(displayTitle);
        const meta = searchMeta ? searchMeta[ev.ID] : null;
        let matchBadge = '';
        if (meta && meta.match && meta.match.key !== 'title') {
            const val = meta.match.value.length > 20 ? meta.match.value.slice(0, 20) + '…' : meta.match.value;
            matchBadge = `<span class="match-badge" title="${escapeAttr(meta.match.label + 'に一致: ' + meta.match.value)}">${escapeHtml(meta.match.label)}: ${highlightText(val, hlTerms)}</span>`;
        }
        const vc = votesByEvent[ev.ID] || { attend: 0, absent: 0, undecided: 0 };
        const isUpcoming = (ev.DateEnd || ev.Date) >= today;
        let voteBadge = '';
        if (isUpcoming && allVotesData !== null && ev.Category !== 'admin') {
            const eligibleCount = membersData.length > 0 ? voteEligibleMembers(membersData, ev).length : 0;
            const label = eligibleCount > 0 ? `${vc.attend} / ${eligibleCount}` : `${vc.attend}`;
            const noanswer = Math.max(0, eligibleCount - (vc.attend + vc.absent + vc.undecided));
            voteBadge = `<a class="vote-count-badge" href="event-series.html?event=${encodeURIComponent(ev.ID)}&vote=1" data-action="vote" title="参加${vc.attend}・不参加${vc.absent}・未定${vc.undecided}${eligibleCount > 0 ? `・未回答${noanswer}` : ''} — タップで出欠を回答">${label}</a>`;
        }
        // 出欠ドロップダウン（今後の予定のみ、幹部会は対象外）
        let voteCell = '';
        if (isUpcoming && allVotesData !== null && ev.Category !== 'admin') {
            const myVote = getMyVoteForEvent(ev.ID);
            const curStatus = myVote ? myVote.status : '';
            const colorClass = curStatus ? 'vote-' + curStatus : '';
            const closed = voteDeadlinePassed(ev);
            voteCell = `<select class="ev-vote-select ${colorClass}" data-vote-event="${escapeAttr(ev.ID)}"
                aria-label="「${escapeAttr(displayTitle)}」の出欠を回答"
                data-change-action="ev-inline-vote"
                ${closed && !isAdmin ? 'disabled title="締切済み"' : ''}>
                <option value="">--</option>
                <option value="attend" ${curStatus === 'attend' ? 'selected' : ''}>参加</option>
                <option value="absent" ${curStatus === 'absent' ? 'selected' : ''}>不参加</option>
                <option value="undecided" ${curStatus === 'undecided' ? 'selected' : ''}>未定</option>
            </select>`;
        }
        return `
            <tr class="clickable-row" data-id="${escapeAttr(ev.ID)}" title="タップで詳細ページへ">
                <td class="cell-name ev-date-cell" style="white-space:nowrap;">
                    ${dateCellHtml(ev.Date)} <span class="text-muted">(${dayOfWeekJP(ev.Date)})</span>
                    ${ev.DateEnd && ev.DateEnd !== ev.Date ? '<br><span class="text-muted" style="font-size:0.8rem;">〜 ' + escapeHtml(ev.DateEnd) + '</span>' : ''}
                </td>
                <td style="white-space:nowrap;">
                    <span class="cat-dot" style="color:${cat.bg};" title="${cat.short}">&#9679;</span>
                    <a href="event-series.html?event=${encodeURIComponent(ev.ID)}" data-action="open" style="font-weight:600;color:inherit;text-decoration:none;">${titleHtml}</a>${matchBadge}
                </td>
                <td class="ev-vote-cell" data-action="stoprow">${voteCell}</td>
                <td>${voteBadge}</td>
                <td data-action-cell>
                    <div class="inline-actions">
                        <button class="inline-action-btn" data-action="duplicate" title="この予定を複製して新規作成">複製</button>
                        <button class="inline-action-btn" data-action="edit" title="この予定を編集">編集</button>
                        ${isAdmin ? '<button class="inline-action-btn danger" data-action="delete" title="この予定を削除">削除</button>' : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    populateVoteMemberSelector();
}


function openNewEventModal() {
    startNewEventBlank();
}

function startNewEventBlank() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="cat-modal-title">
            <h2 id="cat-modal-title">予定の種類を選択</h2>
            <div class="category-buttons">
                <button class="btn btn-category cat-normal-btn" data-cat="normal">イベント</button>
                <button class="btn btn-category cat-other-btn" data-cat="other">その他</button>
                <button class="btn btn-category cat-meeting-btn" data-cat="meeting">ミーティング</button>
            </div>
            <button class="btn btn-text mt-2" data-close>キャンセル</button>
        </div>`;
    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').addEventListener('click', close);
    overlay.querySelectorAll('[data-cat]').forEach(btn => {
        btn.addEventListener('click', () => { close(); startNewEvent(btn.dataset.cat); });
    });
    bindOverlayClose(overlay, close);
    bindModalEscape(overlay, close);
    document.body.appendChild(overlay);
    trapFocus(overlay.querySelector('.modal-content'));
}

// template あり（複製）の場合は、枠だけのクイック作成ではなく実験・担当などの詳細も
// その場で全て入力できるフルウィザードを開く。template 無し（真っさらな新規）はクイック作成のまま。
function startNewEvent(category, template) {
    if (template) openEventWizard(null, template);
    else openQuickCreate(category);
}

// ---- クイック作成（案C: 「枠だけ作って後から埋める」2段階運用） ----
// 真っさらな新規作成のみで使う。必須はカテゴリ＋名前＋日付だけ。保存後はイベント詳細ページへ遷移し、
// 残りの項目（実験・担当・ファイル等）は詳細ページの「編集」から追記する。
// （複製の場合はここを通らず、フルウィザード（openEventWizard）で詳細も一度に入力する）

function openQuickCreate(category) {
    let cat = category || 'normal';
    // 'meeting' は種類選択の「ミーティング」。全体会／幹部会はこの後のラジオで選ぶ（既定は全体会）
    const isMeeting = cat === 'meeting' || isMeetingCategory(cat);
    if (cat === 'meeting') cat = 'general';
    const catInfo = isMeeting ? { ...getEventCategory('general'), short: 'ミーティング' } : getEventCategory(cat);

    const startDate = todayISO();
    const endDate = '';

    // 送らない列はサーバーが '' で作成する
    const draft = {
        ID: genId('ev_'),
        Date: startDate, DateEnd: endDate,
        Title: '', Location: '', Audience: '',
        MeetingNumber: '', Category: cat,
        TimeStart: '', TimeEnd: '',
        PartsList: [], Files: []
    };
    tempNewEvent = draft;

    const timeStart = draft.TimeStart;
    const timeEnd = draft.TimeEnd;

    const overlay = document.createElement('div');
    overlay.id = 'qc-overlay';
    overlay.className = 'wizard-overlay';

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true" style="max-width:480px;">
            <div class="wizard-header">
                <h2 class="wizard-title">予定を追加</h2>
                <p class="wizard-subtitle">まず枠だけ登録できます。${isMeeting ? '' : '実験・担当などの詳細はあとから追記できます。'}</p>
            </div>
            <div class="wizard-body">
                <div style="margin-bottom:12px;"><span class="cat-badge" style="background:${catInfo.bg};color:${catInfo.text};">${catInfo.short}</span></div>
                ${isMeeting ? `
                <div class="e1-group">
                    <label class="e1-label">種別</label>
                    <div class="qc-meeting-type-row">
                        <label class="qc-meeting-type-option"><input type="radio" name="qc-meeting-type" value="general" checked> 全体会</label>
                        <label class="qc-meeting-type-option"><input type="radio" name="qc-meeting-type" value="admin"> 幹部会</label>
                    </div>
                </div>
                <div class="e1-group" style="max-width:140px;">
                    <label class="e1-label">回数</label>
                    <input id="qc-meeting-num" class="e1-input" type="number" placeholder="3" value="${escapeAttr(draft.MeetingNumber || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">参加メンバー（任意）</label>
                    <div id="qc-meeting-members"></div>
                </div>` : `
                <div class="e1-group">
                    <label class="e1-label">イベント名 *</label>
                    <input id="qc-title" class="e1-input" type="text" placeholder="例: サイエンスフェスタ" value="${escapeAttr(draft.Title || '')}">
                </div>`}
                <div class="e1-group">
                    <label class="e1-label">日にち *</label>${dateRangePickerHtml(draft.Date, draft.DateEnd)}
                    <p id="qc-deadline-note" class="text-muted" style="font-size:0.8rem; margin:6px 0 0;"></p>
                </div>
                <div class="e1-group">
                    <label class="e1-label">時間（未定なら空欄のまま）</label>${timeRangeSelectHtml('qc-time-start', 'qc-time-end')}
                </div>
                <div class="e1-group">
                    <label class="e1-label">場所（任意）</label>
                    <input id="qc-location" class="e1-input" type="text" placeholder="${isMeeting ? '例: 学生会館3F' : '例: ○○公民館'}" value="${escapeAttr(draft.Location || '')}">
                </div>
            </div>
            <div class="wizard-footer">
                <div class="wizard-footer-spacer"></div>
                <button class="btn btn-text" onclick="closeQuickCreate()">キャンセル</button>
                <button id="qc-save" class="btn btn-primary" onclick="saveQuickCreate()" title="追加後はイベント詳細ページが開き、残りの項目を追記できます">追加</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    trapFocus(overlay.querySelector('.wizard-panel'));
    initDateRangePicker(overlay);

    if (isMeeting) {
        const memberContainer = document.getElementById('qc-meeting-members');
        if (memberContainer) initTagInput(memberContainer, [], 'メンバーを検索...');
    }

    const tsEl = document.getElementById('qc-time-start');
    const teEl = document.getElementById('qc-time-end');
    if (tsEl) tsEl.value = timeStart;
    if (teEl) teEl.value = timeEnd;

    // 期限メモの初期表示
    const dateInput = overlay.querySelector('[data-field="Date"]');
    if (dateInput) updateDeadlines(dateInput);

    // 領域外クリック・Esc は、入力に変更があれば破棄確認を挟む（誤タップで入力内容が消えないように）。
    // 初期値の流し込みが終わった後に呼ぶこと（スナップショット基準がずれるため）。
    bindEditDismissGuard(overlay, closeQuickCreate);

    setTimeout(() => {
        const firstInput = overlay.querySelector('#qc-title, #qc-meeting-num');
        if (firstInput) firstInput.focus();
    }, 80);
}

function closeQuickCreate() {
    const overlay = document.getElementById('qc-overlay');
    if (overlay) overlay.remove();
    tempNewEvent = null;
}

async function saveQuickCreate() {
    if (!tempNewEvent) return;
    const draft = tempNewEvent;
    // ミーティング種別ラジオの反映
    const mtgRadio = document.querySelector('input[name="qc-meeting-type"]:checked');
    if (mtgRadio) draft.Category = mtgRadio.value;
    const isMeeting = isMeetingCategory(draft.Category);

    if (isMeeting) {
        draft.Title = draft.Category === 'admin' ? '幹部会' : '全体会';
    } else {
        draft.Title = (document.getElementById('qc-title')?.value || '').trim();
        if (!draft.Title) {
            toast('イベント名を入力してください', 'error');
            document.getElementById('qc-title')?.focus();
            return;
        }
    }
    const overlay = document.getElementById('qc-overlay');
    draft.Date = overlay.querySelector('[data-field="Date"]')?.value || '';
    draft.DateEnd = overlay.querySelector('[data-field="DateEnd"]')?.value || '';
    if (!draft.Date) {
        toast('日にちを選択してください', 'error');
        return;
    }
    draft.Location = (document.getElementById('qc-location')?.value || '').trim();
    if (isMeeting) {
        draft.MeetingNumber = document.getElementById('qc-meeting-num')?.value || '';
        const memberContainer = document.getElementById('qc-meeting-members');
        draft.Audience = memberContainer?._tagInput ? memberContainer._tagInput.getValues().join('、') : '';
    }

    const time = readTimeRange('qc-time-start', 'qc-time-end');
    if (!time) return;
    draft.TimeStart = time.start;
    draft.TimeEnd = time.end;

    const dl = isMeeting ? { kyoka: '', houkoku: '' } : calculateDeadlines(draft.Date);
    draft.KyokaDeadline = dl.kyoka;
    draft.HoukokuDeadline = dl.houkoku;

    const btn = document.getElementById('qc-save');
    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
        const saved = await api.save('events', draft);
        eventsData.unshift(saved);
        api.saveCache('events', eventsData);
        closeQuickCreate();
        warnKyokaOverdue(saved);
        // 続きの入力はイベント詳細ページで（未入力チェックリストが出る）
        location.href = 'event-series.html?event=' + encodeURIComponent(saved.ID);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = '追加';
        toast('保存失敗: ' + err.message, 'error');
    }
}

// 日付フォーマットは app.js の toISODate / todayISO を使用
