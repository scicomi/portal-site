// イベントデータ（GASから取得してここに保持）
let eventsData = [];
// 参加バッジ・プレビューモーダルの投票UIに使う（listAll で一括取得）
let membersData = [];
let allVotesData = null;   // null = 未取得


// ---- グローバルキーボードショートカット ----
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        // フォーム編集中は Esc / Ctrl+S だけ拾う
        if (e.key === 'Escape') closeAnyOpenModal();
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            const saveBtn = document.querySelector('#qc-save, .modal-content .btn-primary:not(.hidden)');
            if (saveBtn) { e.preventDefault(); saveBtn.click(); }
        }
        return;
    }
    if (e.key === 'Escape') { closeAnyOpenModal(); return; }
    // ウィザード・確認ダイアログ・認証モーダル表示中や修飾キー付きでは
    // ページ用ショートカット（n / /）を発動しない
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.wizard-overlay, .confirm-dialog-overlay, #admin-auth-modal, #pw-modal')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openNewEventModal(); }
    if (e.key === '/' && document.getElementById('event-search')) {
        e.preventDefault();
        document.getElementById('event-search').focus();
    }
});

function closeAnyOpenModal() {
}

// ---- フィルタ状態 ----
let filterState = {
    keyword: '',
    category: 'all',
    period: 'upcoming'
};

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
            if (action === 'open' || action === 'vote') return; // <a> のデフォルト遷移に任せる
            e.stopPropagation();
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

    // 検索窓（デバウンス・サジェスト・キーボード操作は search.js が面倒を見る）
    attachSearchBox(document.getElementById('event-search'), {
        onSearch: (v) => {
            filterState.keyword = (v || '').trim();
            renderEvents();
        },
        suggestSources: eventSuggestSources,
        historyKey: 'events'
    });

    // ?action=new はデータ読込を待たずに新規作成モーダルを開ける
    if (new URLSearchParams(location.search).get('action') === 'new') {
        history.replaceState(null, '', 'events.html');
        openNewEventModal();
    }

    holidaysData = await api.loadHolidaysCached();

    // 前回カレンダーを表示していたら復元する
    if (localStorage.getItem(CALENDAR_VISIBLE_KEY) === '1') toggleCalendar();

    // キャッシュ即表示（GAS形で書かれていても UI形へ正規化してから使う）
    const cached = api.loadCache('events');
    if (cached && cached.items && cached.items.length > 0) {
        eventsData = cacheItemsToUi(cached.items);
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

// ?edit=<ID> は編集ウィザード、?duplicate=<ID> は複製して新規作成を開く
// （シリーズ詳細ページの「編集」「複製」ボタンの遷移先）。
// データ未取得のうちは何もせず、refreshData 後に再度試みる（一度だけ実行）。
let urlActionHandled = false;
function handleUrlActionParams() {
    if (urlActionHandled) return;
    const params = new URLSearchParams(location.search);
    const editId = params.get('edit');
    const dupId = params.get('duplicate');
    if (!editId && !dupId) return;
    const target = eventsData.find(e => e.ID === (editId || dupId));
    if (!target) return; // まだ読み込まれていない → リフレッシュ後に再試行
    urlActionHandled = true;
    history.replaceState(null, '', 'events.html');
    if (editId) openEventWizard(editId);
    else startNewEvent(target.Category || 'normal', target);
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
    try {
        // listAll で events / members / votes を1往復で取得する
        // （参加バッジの分母表示・モーダル内の投票UIにメンバーと投票が要るため）
        const all = await api.listAll();
        eventsData = (all.events || []).map(gasToUi);
        api.saveCache('events', eventsData);
        membersData = all.members || [];
        api.saveCache('members', membersData);
        if (all.experiments) api.saveCache('experiments', all.experiments);
        if (Array.isArray(all.votes)) {
            allVotesData = all.votes;
            api.saveCache('votes', allVotesData);
            rebuildVotesByEvent();
        } else {
            refreshVotes(); // 旧バックエンド: votes 未同梱なら従来どおり別途取得
        }
        buildPeriodFilterOptions();
        renderEvents();
        handleUrlActionParams();
        if (calendarVisible) refreshCalendar();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
        // キャッシュも無く一覧が空のままなら、「読み込み中」を残さずエラー＋再試行を表示
        if (eventsData.length === 0) {
            const tbody = document.getElementById('events-tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="empty-state">
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
    const staffIds = voteStaffIds(membersData);
    (allVotesData || []).forEach(v => {
        if (staffIds.has(v.memberId)) return;
        const b = votesByEvent[v.eventId] || (votesByEvent[v.eventId] = { attend: 0, absent: 0, undecided: 0 });
        if (b[v.status] !== undefined) b[v.status]++;
    });
}

// 旧バックエンド（listAll に votes 未同梱）向けフォールバック
async function refreshVotes() {
    try {
        allVotesData = await api.listVotes();
        api.saveCache('votes', allVotesData);
        rebuildVotesByEvent();
        renderEvents();
    } catch (_) { /* 集計は補助情報。失敗しても一覧表示は継続する */ }
}

// ---- 検索・フィルタ ----

// 検索フィールド定義（search.js の createSearcher 用）。重要度順に並べる。
// 実験名・発表者は PartsList（JSON文字列）に入っているため normalizeParts（app.js）で展開する。
const EVENT_SEARCH_FIELDS = [
    { key: 'title', label: 'タイトル', weight: 100, get: e => [e.Title, e.Meeting_Number ? `第${e.Meeting_Number}回 ${e.Title || ''}` : ''] },
    { key: 'location', label: '場所', weight: 80, get: e => [e.Location] },
    {
        key: 'person', label: '人', weight: 70, get: e => {
            const out = [e.Admin_Kyoka, e.Admin_Houkoku];
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
        [e.Admin_Kyoka, e.Admin_Houkoku].forEach(v => { if (v) people.add(v); });
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
    renderEvents();
    if (calendarVisible) refreshCalendar();
}
function onPeriodFilter(period) {
    filterState.period = period;
    // 期間はチップからセレクトボックスへ変更（フィルタ行の要素数を減らすため）
    const sel = document.getElementById('period-filter');
    if (sel && sel.value !== period) sel.value = period;
    renderEvents();
}
// カテゴリ・期間の絞り込み（キーワードは renderEvents 側で検索エンジンに通す。
// スコア順ソートとマッチ理由バッジに検索結果のメタ情報が要るため）。
function applyFilters(events) {
    const today = todayISO();
    return events.filter(e => {
        if (filterState.category !== 'all' && (e.Category || 'normal') !== filterState.category) return false;
        if (filterState.period === 'upcoming') {
            const endDate = e.Date_End || e.Date;
            if (endDate < today) return false;
        } else if (filterState.period.startsWith('fy_')) {
            const fy = parseInt(filterState.period.slice(3));
            const eventFy = getFiscalYear(e.Date);
            if (eventFy !== fy) return false;
        }
        return true;
    });
}

function refreshCalendar() {
    if (window.globalCalendar) {
        window.globalCalendar.refetchEvents();
    }
}

function initFullCalendar(attempt = 0) {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;
    if (typeof FullCalendar === 'undefined') {
        // CDN 読込待ちの再試行。読込失敗時に無限リトライしないよう約5秒で打ち切る
        if (attempt > 100) {
            toast('カレンダーの読み込みに失敗しました。ページを再読込してください。', 'error');
            return;
        }
        setTimeout(() => initFullCalendar(attempt + 1), 50);
        return;
    }

    // Custom Jump UI
    const jumpHtml = `
        <div style="display:flex; align-items:center; gap:5px; margin-left:10px;">
            <input type="month" id="fc-month-jump" class="e1-input" style="padding: 2px 5px; height:auto; width:auto;">
        </div>
    `;

    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        locale: 'ja',
        selectable: true,
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: ''
        },
        buttonText: {
            today: '今日'
        },
        dayCellClassNames: function (arg) {
            const dateStr = toISODate(arg.date); // ローカル日付（タイムゾーン安全）
            if (holidaysData[dateStr]) {
                return ['holiday'];
            }
            return [];
        },
        select: function (info) {
            // info.endStr is exclusive. Convert to inclusive Date_End.
            // parseISODate は正午基準なのでタイムゾーンによる日付ズレを防げる
            const endObj = parseISODate(info.endStr);
            endObj.setDate(endObj.getDate() - 1);
            const endDateStr = toISODate(endObj);

            window.tempStart = info.startStr;
            window.tempEnd = endDateStr !== info.startStr ? endDateStr : "";
            startNewEventBlank();

            calendar.unselect();
        },
        events: function (fetchInfo, successCallback, failureCallback) {
            // カテゴリフィルタを反映（期間は無視。カレンダーは月表示なので）
            const source = (filterState.category === 'all')
                ? eventsData
                : eventsData.filter(e => (e.Category || 'normal') === filterState.category);
            const fcEvents = source.map(e => {
                const cat = getEventCategory(e.Category); // CONFIGから色・定義を取得
                let displayTitle = e.Title;
                if (cat.isMeeting && e.Meeting_Number) {
                    displayTitle = `第${e.Meeting_Number}回 ${e.Title}`;
                }

                let endDate = null;
                if (e.Date_End) {
                    const d = parseISODate(e.Date_End);
                    d.setDate(d.getDate() + 1); // FullCalendarのend排他仕様に合わせ+1日
                    endDate = toISODate(d);
                }

                return {
                    id: e.ID,
                    title: displayTitle,
                    start: e.Date,
                    end: endDate,
                    backgroundColor: cat.bg,
                    borderColor: cat.bg,
                    textColor: cat.text,
                    display: 'block'
                };
            });
            successCallback(fcEvents);
        },
        eventClick: function (info) {
            location.href = 'event-series.html?event=' + encodeURIComponent(info.event.id);
        },
        eventDidMount: function (info) {
            // ホバーツールチップ
            const ev = eventsData.find(x => x.ID === info.event.id);
            if (!ev) return;
            const lines = [
                ev.Title,
                ev.Date + (ev.Date_End && ev.Date_End !== ev.Date ? ' 〜 ' + ev.Date_End : ''),
                ev.Event_Time,
                ev.Location,
                ev.Audience
            ].filter(Boolean);
            info.el.title = lines.join('\n');
        }
    });
    calendar.render();
    window.globalCalendar = calendar;

    // Inject Custom Month Jump Input after the toolbar
    const toolbar = calendarEl.querySelector('.fc-header-toolbar');
    if (toolbar) {
        const jumpWrapper = document.createElement('div');
        jumpWrapper.style.cssText = 'margin-top: 6px; margin-bottom: 4px;';
        jumpWrapper.innerHTML = jumpHtml;
        toolbar.parentNode.insertBefore(jumpWrapper, toolbar.nextSibling);

        const jumpInput = jumpWrapper.querySelector('#fc-month-jump');
        if (jumpInput) {
            // Sync with current month（toISODate でローカル日付に。UTC変換による月ズレを防ぐ）
            jumpInput.value = toISODate(calendar.getDate()).slice(0, 7);

            jumpInput.addEventListener('change', (e) => {
                if (e.target.value) {
                    calendar.gotoDate(e.target.value + '-01');
                }
            });

            // Keep input synced when navigating with prev/next
            // info.start は表示範囲先頭（前月末を含む）ため getDate() を使う
            calendar.on('datesSet', () => {
                jumpInput.value = toISODate(calendar.getDate()).slice(0, 7);
            });
        }
    }
}

// ※ カスタムグリッド暦（#calendar-grid）は廃止。カレンダーは FullCalendar(#calendar) に一本化。
// ※ 行タップは詳細ページへ直接遷移（event-series.html?event=<ID>）。

// Calendar toggle（表示状態は端末に記憶し、次回訪問時に復元する）
const CALENDAR_VISIBLE_KEY = 'scicomi_calendar_visible';
let calendarVisible = false;
let calendarInitialized = false;

function toggleCalendar() {
    calendarVisible = !calendarVisible;
    localStorage.setItem(CALENDAR_VISIBLE_KEY, calendarVisible ? '1' : '0');
    const wrapper = document.getElementById('calendar-wrapper');
    const btn = document.getElementById('calendar-toggle-btn');
    if (calendarVisible) {
        wrapper.classList.remove('hidden');
        btn.textContent = 'カレンダーを非表示';
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        if (!calendarInitialized) {
            initFullCalendar();
            calendarInitialized = true;
        } else if (window.globalCalendar) {
            window.globalCalendar.updateSize();
            refreshCalendar();
        }
    } else {
        wrapper.classList.add('hidden');
        btn.textContent = 'カレンダーを表示';
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
    }
}

// Render all events as table
function renderEvents() {
    const heading = document.getElementById('event-list-heading');
    const tbody = document.getElementById('events-tbody');

    // キーワードは検索エンジンで照合（正規化・スコア・マッチ理由付き）
    const kw = (filterState.keyword || '').trim();
    const searchRes = kw ? eventSearcher.search(kw) : null;
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

    if (sorted.length === 0) {
        // 何を変えれば表示されるのかが分かるヒントを添える
        const hasNarrowing = filterState.keyword || filterState.category !== 'all';
        const hint = hasNarrowing
            ? '検索キーワードやカテゴリの絞り込みを変更してみてください'
            : (filterState.period === 'upcoming' && eventsData.length > 0
                ? '年度を選択すると過去の予定を確認できます'
                : '');
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state">
            <span class="empty-icon">&#x1F4C5;</span>
            <div class="empty-text">該当する予定はありません</div>
            ${hint ? `<div class="empty-hint">${hint}</div>` : ''}
        </td></tr>`;
        return;
    }

    // 削除は管理者ログイン時のみ表示（誤タップ防止）。編集・複製は全員に表示し、
    // 必要な操作は実行時に管理者認証を挟む（各ページ共通ルール）
    const isAdmin = api.isAdmin();
    const today = todayISO();
    const nq = searchMeta ? searchNormalize(kw) : '';
    tbody.innerHTML = sorted.map(ev => {
        const cat = getEventCategory(ev.Category);
        let displayTitle = ev.Title || '(無題)';
        if (cat.isMeeting && ev.Meeting_Number) {
            displayTitle = `第${ev.Meeting_Number}回 ${displayTitle}`;
        }
        // 検索中はマッチ部分をハイライトし、タイトル以外でヒットした行には
        // 「何に一致したか」バッジを添える（結果が平坦に見えないように）
        const titleHtml = searchMeta ? highlightText(displayTitle, nq) : escapeHtml(displayTitle);
        const meta = searchMeta ? searchMeta[ev.ID] : null;
        let matchBadge = '';
        if (meta && meta.match && meta.match.key !== 'title') {
            const val = meta.match.value.length > 20 ? meta.match.value.slice(0, 20) + '…' : meta.match.value;
            matchBadge = `<span class="match-badge" title="${escapeAttr(meta.match.label + 'に一致: ' + meta.match.value)}">${escapeHtml(meta.match.label)}: ${highlightText(val, nq)}</span>`;
        }
        // 参加人数バッジ。今後の日程には回答0件でも常時表示し（最初の1票への導線）、
        // 分母（対象者数）を添える。タップでイベント詳細の参加状況セクションへ。
        const vc = votesByEvent[ev.ID] || { attend: 0, absent: 0, undecided: 0 };
        const isUpcoming = (ev.Date_End || ev.Date) >= today;
        let voteBadge = '';
        if (isUpcoming && allVotesData !== null) {
            const eligibleCount = membersData.length > 0 ? voteEligibleMembers(membersData, ev).length : 0;
            const label = eligibleCount > 0 ? `${vc.attend} / ${eligibleCount}` : `${vc.attend}`;
            const noanswer = Math.max(0, eligibleCount - (vc.attend + vc.absent + vc.undecided));
            voteBadge = `<a class="vote-count-badge" href="event-series.html?event=${encodeURIComponent(ev.ID)}&vote=1" data-action="vote" title="参加${vc.attend}・不参加${vc.absent}・未定${vc.undecided}${eligibleCount > 0 ? `・未回答${noanswer}` : ''} — タップで出欠を回答">${label}</a>`;
        }
        return `
            <tr class="clickable-row" data-id="${escapeAttr(ev.ID)}" title="タップで詳細ページへ">
                <td class="cell-name" style="white-space:nowrap;">
                    ${escapeHtml(ev.Date || '')} <span class="text-muted">(${dayOfWeekJP(ev.Date)})</span>
                    ${ev.Date_End && ev.Date_End !== ev.Date ? '<br><span class="text-muted" style="font-size:0.8rem;">〜 ' + escapeHtml(ev.Date_End) + '</span>' : ''}
                </td>
                <td>
                    <span class="cat-dot" style="color:${cat.bg};" title="${cat.short}">&#9679;</span>
                    <a href="event-series.html?event=${encodeURIComponent(ev.ID)}" data-action="open" style="font-weight:600;color:inherit;text-decoration:none;">${titleHtml}</a>${matchBadge}
                </td>
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
                <button class="btn btn-category cat-general-btn" data-cat="general">全体ミーティング</button>
                <button class="btn btn-category cat-admin-btn" data-cat="admin">幹部ミーティング</button>
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
    const cat = category || 'normal';
    const isMeeting = cat === 'general' || cat === 'admin';
    const catInfo = getEventCategory(cat);

    // カレンダーのドラッグ選択で渡された日付があれば初期値に使う
    const startDate = window.tempStart || todayISO();
    const endDate = window.tempEnd || '';
    window.tempStart = null;
    window.tempEnd = null;

    const draft = {
        ID: genId('ev_'),
        Date: startDate, Date_End: endDate,
        Title: '', Location: '', Audience: '',
        Meeting_Number: '', Category: cat,
        Event_Time: '', Meeting_Logistics: '', PartsList: '', Accompany: '', PlanName: '',
        Admin_Kyoka: '', Admin_Houkoku: '',
        Kyoka_Deadline: '', Houkoku_Deadline: '',
        Remarks: '', Belongings: '', Files: [],
        Gather_Time: '', Dismiss_Time: '',
        Address: '', EmergencyHospital: '', EmergencyPolice: '',
        SeriesKey: ''
    };
    tempNewEvent = draft;

    const timeParts = (draft.Event_Time || '').split(' - ');
    const timeStart = (timeParts[0] || '').trim();
    const timeEnd = (timeParts[1] || '').trim();

    const overlay = document.createElement('div');
    overlay.id = 'qc-overlay';
    overlay.className = 'wizard-overlay';

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true" style="max-width:480px;">
            <div class="wizard-header">
                <h2 class="wizard-title">予定を追加</h2>
                <p class="wizard-subtitle">まず枠だけ登録できます。実験・担当などの詳細はあとから追記できます。</p>
            </div>
            <div class="wizard-body">
                <div style="margin-bottom:12px;"><span class="cat-badge" style="background:${catInfo.bg};color:${catInfo.text};">${catInfo.short}</span></div>
                ${isMeeting ? `
                <div class="flex-row">
                    <div class="e1-group" style="flex:0 0 100px;">
                        <label class="e1-label">回数</label>
                        <input id="qc-meeting-num" class="e1-input" type="number" placeholder="3" value="${escapeAttr(draft.Meeting_Number || '')}">
                    </div>
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">ミーティング名 *</label>
                        <input id="qc-title" class="e1-input" type="text" placeholder="例: イベント振り返り" value="${escapeAttr(draft.Title || '')}">
                    </div>
                </div>` : `
                <div class="e1-group">
                    <label class="e1-label">イベント名 *</label>
                    <input id="qc-title" class="e1-input" type="text" placeholder="例: サイエンスフェスタ" value="${escapeAttr(draft.Title || '')}">
                </div>`}
                <div class="e1-group">
                    <label class="e1-label">日にち *</label>
                    <div class="date-range-picker-wrapper">
                        <input type="text" class="e1-input date-range-display" readonly placeholder="クリックして日にちを選択">
                        <input type="hidden" data-field="Date" value="${escapeAttr(draft.Date || '')}">
                        <input type="hidden" data-field="Date_End" value="${escapeAttr(draft.Date_End || '')}">
                        <div class="date-range-popup hidden"></div>
                    </div>
                    <p id="qc-deadline-note" class="text-muted" style="font-size:0.8rem; margin:6px 0 0;"></p>
                </div>
                <div class="e1-group">
                    <label class="e1-label">時間（未定なら空欄のまま）</label>
                    <div class="time-select-group">
                        <select class="e1-input" id="qc-time-start">${genTimeOpts(7, 21, true)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="qc-time-end">${genTimeOpts(7, 21, true)}</select>
                    </div>
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
        const firstInput = overlay.querySelector('#qc-title');
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
    const isMeeting = draft.Category === 'general' || draft.Category === 'admin';

    draft.Title = (document.getElementById('qc-title')?.value || '').trim();
    if (!draft.Title) {
        toast(isMeeting ? 'ミーティング名を入力してください' : 'イベント名を入力してください', 'error');
        document.getElementById('qc-title')?.focus();
        return;
    }
    const overlay = document.getElementById('qc-overlay');
    draft.Date = overlay.querySelector('[data-field="Date"]')?.value || '';
    draft.Date_End = overlay.querySelector('[data-field="Date_End"]')?.value || '';
    if (!draft.Date) {
        toast('日にちを選択してください', 'error');
        return;
    }
    draft.Location = (document.getElementById('qc-location')?.value || '').trim();
    if (isMeeting) draft.Meeting_Number = document.getElementById('qc-meeting-num')?.value || '';

    const ts = document.getElementById('qc-time-start')?.value || '';
    const te = document.getElementById('qc-time-end')?.value || '';
    if ((ts && !te) || (!ts && te)) {
        toast('時間は開始と終了の両方を選択してください（未定なら両方空欄）', 'error');
        return;
    }
    if (ts && te && te <= ts) {
        toast('終了時刻は開始時刻より後にしてください', 'error');
        return;
    }
    draft.Event_Time = ts && te ? `${ts} - ${te}` : '';

    const dl = isMeeting ? { kyoka: '', houkoku: '' } : calculateDeadlines(draft.Date);
    draft.Kyoka_Deadline = dl.kyoka;
    draft.Houkoku_Deadline = dl.houkoku;

    const btn = document.getElementById('qc-save');
    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
        const savedGas = await api.save('events', uiToGas(draft));
        const saved = gasToUi(savedGas);
        eventsData.unshift(saved);
        api.saveCache('events', eventsData);
        closeQuickCreate();
        if (!isMeeting && dl.kyoka && dl.kyoka < todayISO() && (draft.Date_End || draft.Date) >= todayISO()) {
            toast(`許可願の期限（${dl.kyoka}）を過ぎています。至急対応してください`, 'error', 6000);
        }
        // 続きの入力はイベント詳細ページで（未入力チェックリストが出る）
        location.href = 'event-series.html?event=' + encodeURIComponent(saved.ID);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = '追加';
        toast('保存失敗: ' + err.message, 'error');
    }
}

// ---- イベント削除（確認ダイアログ） ----
function confirmDeleteEvent(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => confirmDeleteEvent(id));
        return;
    }
    const ev = eventsData.find(x => x.ID === id);
    if (!ev) return;
    showConfirmDialog({
        title: `「${ev.Title || '(無題)'}」を削除`,
        message: 'この操作は元に戻せます（削除直後のみ）。',
        okLabel: '削除する',
        danger: true,
        onOk: () => executeDeleteEvent(id)
    });
}

async function executeDeleteEvent(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => executeDeleteEvent(id));
        return;
    }
    const eventIndex = eventsData.findIndex(x => x.ID === id);
    if (eventIndex < 0) return;
    const backup = eventsData[eventIndex];

    eventsData.splice(eventIndex, 1);
    api.saveCache('events', eventsData);
    renderEvents();
    if (calendarVisible) refreshCalendar();

    try {
        await api.delete('events', id);
    } catch (err) {
        eventsData.splice(eventIndex, 0, backup);
        api.saveCache('events', eventsData);
        renderEvents();
        if (calendarVisible) refreshCalendar();
        toast('削除失敗: ' + err.message, 'error');
        return;
    }

    toastUndo(
        `「${backup.Title}」を削除しました`,
        async () => {
            try {
                const restored = gasToUi(await api.save('events', uiToGas(backup)));
                const insertAt = eventsData.findIndex(e => (e.Date || '') > (restored.Date || ''));
                eventsData.splice(insertAt >= 0 ? insertAt : eventsData.length, 0, restored);
                api.saveCache('events', eventsData);
                renderEvents();
                if (calendarVisible) refreshCalendar();
                toast('元に戻しました', 'success', 2000);
            } catch (err) {
                toast('復元に失敗しました: ' + err.message, 'error');
            }
        },
        () => {},
        5000
    );
}

// 日付フォーマットは app.js の toISODate / todayISO を使用
