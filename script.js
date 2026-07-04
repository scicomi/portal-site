// イベントデータ（GASから取得してここに保持）
let eventsData = [];

let holidaysData = {};

// ---- ウィザード定義 ----
let evWizardStep = 0;
let editingEventId = null;
let evWizardCategory = 'normal';

const EV_STEPS_EVENT = [
    { label: '基本情報' },
    { label: '日時' },
    { label: '実験・担当' },
    { label: 'その他' }
];
const EV_STEPS_MEETING = [
    { label: '基本情報' },
    { label: '日時' },
    { label: 'その他' }
];

// ---- スキーマ変換: GAS(新スキーマ) ⇔ UI(旧スキーマ) ----
// GAS側: Date, DateEnd, TimeStart, TimeEnd, PartsList(配列), Files(配列), Logistics, AdminKyoka 等
// UI側:  Date, Date_End, Event_Time, PartsList(JSON文字列), Files(カンマ区切り), Meeting_Logistics, Admin_Kyoka 等
function gasToUi(g) {
    const u = { ...g };
    u.Date_End = g.DateEnd || '';
    u.Event_Time = (g.TimeStart && g.TimeEnd) ? `${g.TimeStart} - ${g.TimeEnd}` : '';
    u.Meeting_Logistics = g.Logistics || '';
    u.Admin_Kyoka = g.AdminKyoka || '';
    u.Admin_Houkoku = g.AdminHoukoku || '';
    u.Kyoka_Deadline = g.KyokaDeadline || '';
    u.Houkoku_Deadline = g.HoukokuDeadline || '';
    u.Meeting_Number = g.MeetingNumber || '';
    u.Gather_Time = g.GatherTime || '';
    u.Dismiss_Time = g.DismissTime || '';
    u.Accompany = g.Accompany || '';
    u.Address = g.Address || '';
    u.EmergencyHospital = g.EmergencyHospital || '';
    u.EmergencyPolice = g.EmergencyPolice || '';
    u.PartsList = Array.isArray(g.PartsList) ? JSON.stringify(g.PartsList) : (g.PartsList || '');
    u.Files = Array.isArray(g.Files)
        ? g.Files.map(f => typeof f === 'string' ? { name: '', url: f } : f)
        : [];
    return u;
}

function uiToGas(u) {
    const time = (u.Event_Time || '').split(' - ');

    let partsList = [];
    if (u.PartsList) {
        if (typeof u.PartsList === 'string') {
            try { partsList = JSON.parse(u.PartsList); } catch (_) { partsList = []; }
        } else if (Array.isArray(u.PartsList)) {
            partsList = u.PartsList;
        }
    }

    return {
        ID: u.ID || '',
        Date: u.Date || '',
        DateEnd: u.Date_End || '',
        Title: u.Title || '',
        Category: u.Category || 'normal',
        Location: u.Location || '',
        Audience: u.Audience || '',
        TimeStart: (time[0] || '').trim(),
        TimeEnd: (time[1] || '').trim(),
        MeetingNumber: u.Meeting_Number || '',
        GatherTime: u.Gather_Time || '',
        DismissTime: u.Dismiss_Time || '',
        Accompany: u.Accompany || '',
        PartsList: partsList,
        AdminKyoka: u.Admin_Kyoka || '',
        AdminHoukoku: u.Admin_Houkoku || '',
        KyokaDeadline: u.Kyoka_Deadline || '',
        HoukokuDeadline: u.Houkoku_Deadline || '',
        Logistics: u.Meeting_Logistics || '',
        Remarks: u.Remarks || '',
        Belongings: u.Belongings || '',
        Files: Array.isArray(u.Files) ? u.Files : [],
        Address: u.Address || '',
        EmergencyHospital: u.EmergencyHospital || '',
        EmergencyPolice: u.EmergencyPolice || '',
        SeriesKey: u.SeriesKey || '',
        Positives: u.Positives || '',
        Reflections: u.Reflections || '',
        ReportStatus: u.ReportStatus || '',  // 報告書ステータスをイベント編集保存でも保持する
        KyokaStatus: u.KyokaStatus || '',    // 許可願ステータスも同様に保持する
        UpdatedBy: u.UpdatedBy || '',
        CreatedAt: u.CreatedAt || '',  // 既存の作成日時を保持（更新・UNDO再作成で消さない）
        UpdatedAt: u.UpdatedAt || ''   // GAS形キャッシュ統一を将来行うための準備。サーバーは送信値を上書きする。
    };
}

// ---- キャッシュ読込の正規化 ----
// 'events' キャッシュは、イベントページが UI形（Event_Time 等）、home/bot/詳細ページが
// GAS形（DateEnd/TimeStart 等）を書き込むため、同じキーに2スキーマが混在しうる。
// 直前に別ページが GAS形で書いていても破綻しないよう、UI形でなければ gasToUi で変換する。
function cacheItemsToUi(items) {
    return (items || []).map(e => (e && 'Event_Time' in e) ? e : gasToUi(e));
}

// ---- 開催回数（同名イベントの紐付け） ----
// SeriesKey（無ければ Title）が一致するイベントを「同じ催し」とみなし、
// 日付順に何回目かと通算回数を算出する。毎年やるイベントの開催回数把握に使う。
function eventSeriesKey(e) {
    const k = (e.SeriesKey && String(e.SeriesKey).trim()) || (e.Title || '');
    return k.replace(/\s+/g, '').replace(/^第\d+回/, '');
}

function occurrenceInfo(e) {
    const key = eventSeriesKey(e);
    if (!key) return null;
    const series = eventsData
        .filter(x => eventSeriesKey(x) === key && x.Date)
        .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
    if (series.length < 2) return null;
    const idx = series.findIndex(x => x.ID === e.ID);
    return { num: idx >= 0 ? idx + 1 : series.length, total: series.length };
}

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
    const overlay = document.getElementById('modal-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
        overlay.classList.add('hidden');
    }
}

// ---- フィルタ状態 ----
let filterState = {
    keyword: '',
    category: 'all',
    period: 'upcoming'
};

// ---- テーブル行のイベント委譲（XSS 対策: onclick に ID を埋め込まない） ----
function _bindEventTableDelegation() {
    const tbody = document.getElementById('events-tbody');
    if (!tbody) return;
    tbody.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
            const action = actionEl.dataset.action;
            if (action === 'series' || action === 'map') return; // <a> のデフォルト遷移に任せる
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
        if (row) location.href = 'event-series.html?event=' + encodeURIComponent(row.dataset.id);
    });
}

// ---- 起動 ----
document.addEventListener('DOMContentLoaded', () => {
    bootPage('events', init);
});

async function init() {
    // 旧リンク互換: ?event=<ID> はイベント詳細（シリーズページ）へ転送する（詳細モーダルは廃止）。
    if (redirectLegacyEventParam()) return;

    bindOverlayClose(document.getElementById('modal-overlay'), closeModal);
    _bindEventTableDelegation();

    // ?action=new はデータ読込を待たずに新規作成モーダルを開ける
    if (new URLSearchParams(location.search).get('action') === 'new') {
        history.replaceState(null, '', 'events.html');
        openNewEventModal();
    }

    holidaysData = await api.loadHolidaysCached();

    // キャッシュ即表示（GAS形で書かれていても UI形へ正規化してから使う）
    const cached = api.loadCache('events');
    if (cached && cached.items && cached.items.length > 0) {
        eventsData = cacheItemsToUi(cached.items);
    }

    populateDatalists();
    // キャッシュがある時だけ即描画。無い時は HTML の「読み込み中...」行を残し、
    // refreshData 完了後に renderEvents で置き換える（空表示と読込中を取り違えない）。
    if (cached && cached.items && cached.items.length > 0) {
        renderEvents();
        handleUrlActionParams();
    }

    if (cached) updateSyncStatus('cached', cached.timestamp);
    else updateSyncStatus('initial-loading');

    refreshData();
    refreshVotes();
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

/**
 * 担当者(members)・実験名(experiments)のdatalist候補を構築。
 * イベントページは events だけを同期するので、members/experiments はキャッシュを使う。
 * キャッシュが無ければ裏で1回だけ取得する。
 */
async function populateDatalists() {
    const memberDl = document.getElementById('member-datalist');
    const expDl = document.getElementById('experiment-datalist');

    let members = (api.loadCache('members') || {}).items;
    let experiments = (api.loadCache('experiments') || {}).items;

    // キャッシュが無ければ裏で取得（失敗しても致命的でない）
    if (!members) {
        try { members = await api.list('members'); api.saveCache('members', members); } catch (_) { members = []; }
    }
    if (!experiments) {
        try { experiments = await api.list('experiments'); api.saveCache('experiments', experiments); } catch (_) { experiments = []; }
    }

    if (memberDl && members) {
        const curFY = currentFiscalYear();
        memberDl.innerHTML = members
            .filter(m => parseInt(m.FiscalYear || curFY) === curFY && m.Name)
            .map(m => `<option value="${escapeAttr(m.Name)}">${escapeAttr(memberRoleOf(m) || 'メンバー')}</option>`)
            .join('');
    }
    if (expDl && experiments) {
        expDl.innerHTML = experiments
            .filter(e => e.Name)
            .map(e => `<option value="${escapeAttr(e.Name)}">${escapeAttr(getExperimentCategory(e.Category).label)}</option>`)
            .join('');
    }
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
    try {
        const list = await api.list('events');
        eventsData = list.map(gasToUi);
        api.saveCache('events', eventsData);
        renderEvents();
        handleUrlActionParams();
        if (calendarVisible) refreshCalendar();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
    }
}

// ---- 投票（出欠）集計: 一覧の参加人数バッジ用 ----
let votesByEvent = {};
async function refreshVotes() {
    try {
        const votes = await api.listVotes();
        votesByEvent = {};
        votes.forEach(v => {
            const b = votesByEvent[v.eventId] || (votesByEvent[v.eventId] = { attend: 0, absent: 0, undecided: 0 });
            if (b[v.status] !== undefined) b[v.status]++;
        });
        renderEvents();
    } catch (_) { /* 集計は補助情報。失敗しても一覧表示は継続する */ }
}

// ---- 検索・フィルタ ----
function onSearchChange() {
    filterState.keyword = (document.getElementById('event-search').value || '').toLowerCase();
    renderEvents();
}
function onCategoryFilter(cat) {
    filterState.category = cat;
    document.querySelectorAll('.filter-chip[data-cat]').forEach(c => c.classList.toggle('active', c.dataset.cat === cat));
    renderEvents();
    if (calendarVisible) refreshCalendar();
}
function onPeriodFilter(period) {
    filterState.period = period;
    document.querySelectorAll('.filter-chip[data-period]').forEach(c => c.classList.toggle('active', c.dataset.period === period));
    renderEvents();
}
/**
 * イベントの検索対象テキストを生成。
 * 実験名・担当者は PartsList（JSON文字列）に入っているのでパースして含める。
 */
function eventSearchText(e) {
    const parts = [e.Title, e.Location, e.Audience, e.Remarks, e.Belongings, e.Admin_Kyoka, e.Admin_Houkoku];
    if (e.PartsList) {
        try {
            const list = parsePartsList(e.PartsList);
            list.forEach(it => {
                parts.push(it.name);
                if (Array.isArray(it.presenters)) parts.push(...it.presenters);
            });
        } catch (_) {}
    }
    return parts.filter(Boolean).join(' ').toLowerCase();
}

function applyFilters(events) {
    const today = todayISO();
    return events.filter(e => {
        // カテゴリ
        if (filterState.category !== 'all' && (e.Category || 'normal') !== filterState.category) return false;
        // 期間
        const endDate = e.Date_End || e.Date;
        if (filterState.period === 'upcoming' && endDate < today) return false;
        if (filterState.period === 'past' && e.Date >= today) return false;
        // キーワード（実験名・担当者も含めて検索）
        if (filterState.keyword) {
            if (!eventSearchText(e).includes(filterState.keyword)) return false;
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

            _modalPrevFocus = document.activeElement;
            document.getElementById('category-selection-modal').classList.remove('hidden');
            document.getElementById('modal-overlay').classList.remove('hidden');
            bindModalEscape(document.getElementById('modal-overlay'), closeModal);

            // Set global temp dates
            window.tempStart = info.startStr;
            window.tempEnd = endDateStr !== info.startStr ? endDateStr : "";

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
// ※ イベント詳細モーダルは廃止。閲覧はシリーズ詳細ページ（event-series.html?event=<ID>）へ一本化。

// Calendar toggle
let calendarVisible = false;
let calendarInitialized = false;

function toggleCalendar() {
    calendarVisible = !calendarVisible;
    const wrapper = document.getElementById('calendar-wrapper');
    const btn = document.getElementById('calendar-toggle-btn');
    if (calendarVisible) {
        wrapper.classList.remove('hidden');
        btn.textContent = 'カレンダーを非表示';
        btn.classList.add('active');
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
    }
}

// Render all events as table
function renderEvents() {
    const heading = document.getElementById('event-list-heading');
    const tbody = document.getElementById('events-tbody');

    const filtered = applyFilters(eventsData);
    const sorted = filtered.slice().sort((a, b) => {
        if (filterState.period === 'past') return (b.Date || '').localeCompare(a.Date || '');
        return (a.Date || '').localeCompare(b.Date || '');
    });

    const periodLabel = { upcoming: '今後のイベント', past: '過去のイベント', all: '全てのイベント' };
    heading.textContent = `${periodLabel[filterState.period]} (${sorted.length}件)`;

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">該当するイベントはありません</td></tr>';
        return;
    }

    const isAdmin = api.isAdmin();
    const today = todayISO();
    tbody.innerHTML = sorted.map(ev => {
        const cat = getEventCategory(ev.Category);
        let displayTitle = ev.Title || '(無題)';
        if (cat.isMeeting && ev.Meeting_Number) {
            displayTitle = `第${ev.Meeting_Number}回 ${displayTitle}`;
        }
        const occ = occurrenceInfo(ev);
        // 参加人数バッジ（今後のイベントで、回答が1件以上あるときだけ表示）
        const vc = votesByEvent[ev.ID];
        const isUpcoming = (ev.Date_End || ev.Date) >= today;
        const hasVotes = vc && (vc.attend + vc.absent + vc.undecided) > 0;
        const voteBadge = (isUpcoming && hasVotes)
            ? `<span class="vote-count-badge" title="参加${vc.attend}・不参加${vc.absent}・未定${vc.undecided}">参加 ${vc.attend}</span>`
            : '';
        return `
            <tr class="clickable-row" data-id="${escapeAttr(ev.ID)}">
                <td class="cell-name" style="white-space:nowrap;">
                    ${escapeHtml(ev.Date || '')} <span class="text-muted">(${dayOfWeekJP(ev.Date)})</span>
                    ${ev.Date_End && ev.Date_End !== ev.Date ? '<br><span class="text-muted" style="font-size:0.8rem;">〜 ' + escapeHtml(ev.Date_End) + '</span>' : ''}
                </td>
                <td>
                    <span style="font-weight:600;">${escapeHtml(displayTitle)}</span>
                    <span class="cat-badge" style="background:${cat.bg};color:${cat.text};margin-left:6px;">${cat.short}</span>
                    ${occ ? `<a href="event-series.html?key=${encodeURIComponent(eventSeriesKey(ev))}" class="occ-badge occ-link" title="通算${occ.total}回 — シリーズ履歴を見る" data-action="series">${occ.num}回目</a>` : ''}
                    ${voteBadge}
                </td>
                <td class="hide-mobile">${ev.Location ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.Location)}" target="_blank" rel="noopener" class="location-link" data-action="map" title="Google マップで開く">${escapeHtml(ev.Location)}</a>` : ''}</td>
                <td class="hide-mobile">${escapeHtml(ev.Event_Time || '')}</td>
                <td data-action-cell>
                    <div class="inline-actions">
                        <button class="inline-action-btn" data-action="duplicate" title="複製して新規作成">&#x29C9;</button>
                        <button class="inline-action-btn" data-action="edit" title="編集">&#9998;</button>
                        ${isAdmin ? `<button class="inline-action-btn danger" data-action="delete" title="削除">&#x2715;</button>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ---- 日付レンジピッカー（クリックでカレンダーを開く） ----
// events.html の .date-range-picker-wrapper を駆動する。
// 表示用の readonly input をクリックするとポップアップ暦が開き、
// 開始日→終了日の順にクリックすると hidden の Date / Date_End に反映される。
function initDateRangePicker(card) {
    const wrapper = card.querySelector('.date-range-picker-wrapper');
    if (!wrapper) return;
    const display = wrapper.querySelector('.date-range-display');
    const startInput = wrapper.querySelector('[data-field="Date"]');
    const endInput = wrapper.querySelector('[data-field="Date_End"]');
    const popup = wrapper.querySelector('.date-range-popup');
    if (!display || !startInput || !endInput || !popup) return;

    const state = {
        start: startInput.value || '',
        end: endInput.value || '',
        view: parseISODate(startInput.value || todayISO())
    };
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];

    function syncDisplay() {
        if (state.start && state.end && state.end !== state.start) {
            display.value = `${state.start} (${dayOfWeekJP(state.start)}) 〜 ${state.end} (${dayOfWeekJP(state.end)})`;
        } else if (state.start) {
            display.value = `${state.start} (${dayOfWeekJP(state.start)})`;
        } else {
            display.value = '';
        }
        startInput.value = state.start;
        endInput.value = (state.end && state.end !== state.start) ? state.end : '';
        // 開始日が変わると書類期限の表示も更新する
        if (typeof updateDeadlines === 'function') updateDeadlines(startInput);
    }

    function renderCal() {
        const y = state.view.getFullYear();
        const m = state.view.getMonth();
        const startWeekday = new Date(y, m, 1).getDay();
        const daysInMonth = new Date(y, m + 1, 0).getDate();

        let cells = '';
        for (let i = 0; i < startWeekday; i++) cells += '<span class="drp-day drp-empty"></span>';
        for (let d = 1; d <= daysInMonth; d++) {
            const iso = toISODate(new Date(y, m, d));
            const dow = new Date(y, m, d).getDay();
            const cls = ['drp-day'];
            if (dow === 0) cls.push('drp-sun');
            if (dow === 6) cls.push('drp-sat');
            if (holidaysData[iso]) cls.push('drp-holiday');
            if (iso === todayISO()) cls.push('drp-today');
            if (iso === state.start) cls.push('drp-start');
            if (state.end && iso === state.end) cls.push('drp-end');
            if (state.start && state.end && iso > state.start && iso < state.end) cls.push('drp-inrange');
            cells += `<button type="button" class="${cls.join(' ')}" data-iso="${iso}">${d}</button>`;
        }

        popup.innerHTML = `
            <div class="drp-header">
                <button type="button" class="drp-nav" data-nav="-1">‹</button>
                <span class="drp-title">${y}年 ${m + 1}月</span>
                <button type="button" class="drp-nav" data-nav="1">›</button>
            </div>
            <div class="drp-weekdays">${weekdays.map((w, i) => `<span class="${i === 0 ? 'drp-sun' : i === 6 ? 'drp-sat' : ''}">${w}</span>`).join('')}</div>
            <div class="drp-grid">${cells}</div>
            <div class="drp-footer">
                <span class="drp-hint">開始日→終了日の順にクリック</span>
                <button type="button" class="drp-clear">クリア</button>
                <button type="button" class="drp-close">完了</button>
            </div>
        `;
    }

    function openPopup() {
        state.view = parseISODate(state.start || todayISO());
        renderCal();
        popup.classList.remove('hidden');
        setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    }
    function closePopup() {
        popup.classList.add('hidden');
        document.removeEventListener('mousedown', onOutside);
    }
    function onOutside(e) {
        if (!wrapper.contains(e.target)) closePopup();
    }

    display.addEventListener('click', () => {
        if (popup.classList.contains('hidden')) openPopup(); else closePopup();
    });

    popup.addEventListener('click', (e) => {
        const nav = e.target.closest('.drp-nav');
        if (nav) {
            state.view = new Date(state.view.getFullYear(), state.view.getMonth() + parseInt(nav.dataset.nav), 1);
            renderCal();
            return;
        }
        if (e.target.closest('.drp-clear')) {
            state.start = ''; state.end = '';
            syncDisplay(); renderCal();
            return;
        }
        if (e.target.closest('.drp-close')) { closePopup(); return; }

        const day = e.target.closest('.drp-day');
        if (day && day.dataset.iso) {
            const iso = day.dataset.iso;
            if (!state.start || (state.start && state.end) || iso < state.start) {
                // 新しい開始日として設定（終了日はリセット）
                state.start = iso; state.end = '';
            } else {
                // 終了日を設定
                state.end = iso;
            }
            syncDisplay(); renderCal();
            if (state.start && state.end) closePopup();
        }
    });

    syncDisplay();
}

// ---- タグ入力コンポーネント（検索可能な複数選択） ----

function getActiveMembers() {
    const cached = (api.loadCache('members') || {}).items || [];
    const curFY = currentFiscalYear();
    return cached.filter(m => parseInt(m.FiscalYear || curFY) === curFY && m.Name);
}

// 役職判定は app.js の memberRoleOf を使用
function isStaffMember(m) {
    const r = memberRoleOf(m);
    return r === 'アドバイザー' || r === 'コーディネーター';
}
function isRegularMember(m) {
    return !isStaffMember(m);
}

// 開いているタグ入力ドロップダウンをすべて再配置する。row/wizard の再生成のたびに
// window リスナーを追加すると溜まり続けるため、リスナー自体は一度だけ登録する。
let _tagInputViewportListenersBound = false;
function _initTagInputViewportListeners() {
    if (_tagInputViewportListenersBound) return;
    _tagInputViewportListenersBound = true;
    const reposition = () => {
        document.querySelectorAll('.tag-input-dropdown:not(.hidden)').forEach(dd => {
            if (dd.isConnected && dd._reposition) dd._reposition();
        });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
}

function initTagInput(container, selectedValues, placeholder, filterFn) {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'tag-input';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input-field';
    input.placeholder = placeholder || 'メンバーを検索...';

    const dropdown = document.createElement('div');
    dropdown.className = 'tag-input-dropdown hidden';

    wrapper.appendChild(dropdown);
    wrapper.insertBefore(input, dropdown);
    container.appendChild(wrapper);

    let values = [...(selectedValues || [])];

    function renderTags() {
        wrapper.querySelectorAll('.tag-input-tag').forEach(t => t.remove());
        values.forEach(v => {
            const tag = document.createElement('span');
            tag.className = 'tag-input-tag';
            tag.dataset.value = v;
            tag.innerHTML = `${escapeHtml(v)}<button class="tag-input-remove" type="button">&times;</button>`;
            wrapper.insertBefore(tag, input);
        });
    }

    // position:fixed でモーダルの overflow:auto によるクリッピングを避け、
    // 実験内容の datalist のように入力欄の下（入らなければ上）へ画面いっぱいに広げる。
    function positionDropdown() {
        const rect = wrapper.getBoundingClientRect();
        const margin = 8;
        const spaceBelow = window.innerHeight - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        dropdown.style.left = rect.left + 'px';
        dropdown.style.width = rect.width + 'px';
        if (spaceBelow >= 150 || spaceBelow >= spaceAbove) {
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.bottom = '';
            dropdown.style.maxHeight = Math.max(100, spaceBelow) + 'px';
        } else {
            dropdown.style.top = '';
            dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
            dropdown.style.maxHeight = Math.max(100, spaceAbove) + 'px';
        }
    }

    dropdown._reposition = positionDropdown;
    _initTagInputViewportListeners();

    function showDropdown() {
        const query = input.value.toLowerCase().trim();
        const members = filterFn ? getActiveMembers().filter(filterFn) : getActiveMembers();
        const filtered = members.filter(m => {
            if (values.includes(m.Name)) return false;
            if (!query) return true;
            return (m.Name || '').toLowerCase().includes(query) ||
                   (m.Furigana || '').toLowerCase().includes(query);
        });
        if (filtered.length === 0) {
            dropdown.innerHTML = query
                ? '<div class="tag-input-empty">候補なし（Enterで自由入力）</div>'
                : '<div class="tag-input-empty">候補なし</div>';
        } else {
            const maxShow = 30;
            let html = filtered.slice(0, maxShow).map(m =>
                `<div class="tag-input-option" data-value="${escapeAttr(m.Name)}">${escapeHtml(m.Name)}${m.Furigana ? ' <span class="text-hint" style="font-size:0.8em;">(' + escapeHtml(m.Furigana) + ')</span>' : ''}</div>`
            ).join('');
            if (filtered.length > maxShow) {
                html += `<div class="tag-input-empty">他 ${filtered.length - maxShow} 件（入力で絞り込み）</div>`;
            }
            dropdown.innerHTML = html;
        }
        dropdown.classList.remove('hidden');
        positionDropdown();
    }

    function hideDropdown() { dropdown.classList.add('hidden'); }

    function addValue(val) {
        val = (val || '').trim();
        if (val && !values.includes(val)) { values.push(val); renderTags(); }
        input.value = '';
        hideDropdown();
    }

    input.addEventListener('focus', showDropdown);
    input.addEventListener('input', showDropdown);
    input.addEventListener('blur', () => setTimeout(hideDropdown, 200));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) addValue(input.value); }
        if (e.key === 'Backspace' && !input.value && values.length > 0) { values.pop(); renderTags(); showDropdown(); }
    });
    dropdown.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const opt = e.target.closest('.tag-input-option');
        if (opt) addValue(opt.dataset.value);
    });
    wrapper.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.tag-input-remove');
        if (removeBtn) {
            e.stopPropagation();
            const tag = removeBtn.closest('.tag-input-tag');
            values = values.filter(v => v !== tag.dataset.value);
            renderTags();
            return;
        }
        input.focus();
    });

    renderTags();
    container._tagInput = {
        getValues: () => [...values],
        setValues: (vals) => { values = [...vals]; renderTags(); }
    };
    return container._tagInput;
}

// ---- PartsList 新旧フォーマット変換 ----
// 旧: [{partName:"一部", items:[{name:"スライム", presenter:"太田"}]}]
// 新: [{name:"スライム", presenters:["太田","鈴木"]}]
function parsePartsList(raw) {
    let data = [];
    if (!raw) return [{ name: '', presenters: [] }];
    try {
        data = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
    } catch (_) { return [{ name: '', presenters: [] }]; }
    if (!Array.isArray(data) || data.length === 0) return [{ name: '', presenters: [] }];

    if (data[0] && data[0].partName !== undefined) {
        const flat = [];
        data.forEach(p => (p.items || []).forEach(it => {
            if (!it.name && !it.presenter) return;
            const existing = flat.find(f => f.name === it.name);
            if (existing && it.presenter && !existing.presenters.includes(it.presenter)) {
                existing.presenters.push(it.presenter);
            } else if (!existing) {
                flat.push({ name: it.name || '', presenters: it.presenter ? [it.presenter] : [] });
            }
        }));
        return flat.length > 0 ? flat : [{ name: '', presenters: [] }];
    }

    return data.map(item => ({
        name: item.name || '',
        presenters: Array.isArray(item.presenters) ? item.presenters : (item.presenter ? [item.presenter] : [])
    }));
}

// ---- 実験行の生成・追加・削除 ----

function buildExperimentRow(expName, presenters) {
    const row = document.createElement('div');
    row.className = 'experiment-row';
    row.innerHTML = `
        <div class="exp-name-col">
            <label>実験内容</label>
            <input type="text" class="e1-input experiment-name" value="${escapeAttr(expName || '')}" placeholder="実験名を検索..." list="experiment-datalist">
        </div>
        <div class="exp-presenter-col">
            <label>発表者</label>
            <div class="presenter-tag-container"></div>
        </div>
        <button class="btn-del" onclick="removeExperimentRow(this)" type="button">✖</button>
    `;
    // 発表者の候補はコーディネーター・アドバイザーを除いたメンバーのみ
    initTagInput(row.querySelector('.presenter-tag-container'), presenters || [], '発表者を検索...', isRegularMember);
    return row;
}

function addExperimentRow(btn) {
    const container = btn.closest('.e1-group').querySelector('.experiments-container');
    container.appendChild(buildExperimentRow('', []));
}

function removeExperimentRow(btn) {
    const row = btn.closest('.experiment-row');
    const container = row.parentElement;
    row.remove();
    if (container.children.length === 0) {
        addExperimentRow(container.closest('.e1-group').querySelector('.btn-add-exp'));
    }
}

// --- Modal & New Event Logic ---

function openNewEventModal() {
    _modalPrevFocus = document.activeElement;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('category-selection-modal').classList.remove('hidden');
    bindModalEscape(document.getElementById('modal-overlay'), closeModal);
    populateTemplateDropdown();
}

function populateTemplateDropdown() {
    const sel = document.getElementById('template-source');
    if (!sel) return;
    const sorted = eventsData.slice().sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
    // カテゴリ表記はフィルタチップ等と同じ CONFIG の短縮名に統一する（表記ゆれ防止）
    sel.innerHTML = '<option value="">-- 過去イベントを選んで複製 --</option>' +
        sorted.slice(0, 50).map(e => {
            const catLabel = getEventCategory(e.Category).short;
            return `<option value="${escapeAttr(e.ID)}">${escapeHtml(e.Date)} ${catLabel}: ${escapeHtml(e.Title)}</option>`;
        }).join('');
    sel.value = '';
}

function onTemplateSelect(sourceId) {
    if (!sourceId) return;
    const source = eventsData.find(e => e.ID === sourceId);
    if (!source) return;
    // カテゴリは元イベントを継承して新規作成フローへ
    startNewEvent(source.Category || 'normal', source);
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    if (_modalPrevFocus) { _modalPrevFocus.focus(); _modalPrevFocus = null; }
}
let _modalPrevFocus = null;

function startNewEvent(category, template) {
    closeModal();
    openQuickCreate(category, template);
}

// ---- クイック作成（案C: 「枠だけ作って後から埋める」2段階運用） ----
// 必須はカテゴリ＋名前＋日付だけ。保存後はイベント詳細ページへ遷移し、
// 残りの項目（実験・担当・ファイル等）は詳細ページの「編集」から追記する。
// template（複製元）がある場合は、表示されない項目も含めて内容を引き継ぐ。

function openQuickCreate(category, template) {
    const cat = category || (template && template.Category) || 'normal';
    const isMeeting = cat === 'general' || cat === 'admin';
    const catInfo = getEventCategory(cat);

    // カレンダーのドラッグ選択で渡された日付があれば初期値に使う
    const startDate = window.tempStart || todayISO();
    const endDate = window.tempEnd || '';
    window.tempStart = null;
    window.tempEnd = null;

    // 下書きイベント（クイック作成で見せないフィールドは template から引き継ぐ）
    const draft = {
        ID: genId('ev_'),
        Date: startDate, Date_End: endDate,
        Title: template ? (template.Title || '') + ' (複製)' : '',
        Location: template ? (template.Location || '') : '',
        Audience: template ? (template.Audience || '') : '',
        Meeting_Number: '', Category: cat,
        Event_Time: template ? (template.Event_Time || '') : '',
        Meeting_Logistics: template ? (template.Meeting_Logistics || '') : '',
        PartsList: template ? (template.PartsList || '') : '',
        Accompany: template ? (template.Accompany || '') : '',
        Admin_Kyoka: template ? (template.Admin_Kyoka || '') : '',
        Admin_Houkoku: template ? (template.Admin_Houkoku || '') : '',
        Kyoka_Deadline: '', Houkoku_Deadline: '',
        Remarks: template ? (template.Remarks || '') : '',
        Belongings: template ? (template.Belongings || '') : '',
        Files: [],
        Gather_Time: template ? (template.Gather_Time || '') : '',
        Dismiss_Time: template ? (template.Dismiss_Time || '') : '',
        Address: template ? (template.Address || '') : '',
        EmergencyHospital: template ? (template.EmergencyHospital || '') : '',
        EmergencyPolice: template ? (template.EmergencyPolice || '') : '',
        SeriesKey: template ? (template.SeriesKey || '') : ''
    };
    tempNewEvent = draft;

    const timeParts = (draft.Event_Time || '').split(' - ');
    const timeStart = (timeParts[0] || '').trim();
    const timeEnd = (timeParts[1] || '').trim();

    const overlay = document.createElement('div');
    overlay.id = 'qc-overlay';
    overlay.className = 'wizard-overlay';
    overlay.onclick = (ev) => { if (ev.target === overlay) closeQuickCreate(); };

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true" style="max-width:480px;">
            <div class="wizard-header">
                <h2 class="wizard-title">${template ? 'イベントを複製して作成' : '新規イベント作成'}</h2>
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
                <button id="qc-save" class="btn btn-primary" onclick="saveQuickCreate()">作成して詳細ページへ</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    bindModalEscape(overlay, closeQuickCreate);
    trapFocus(overlay.querySelector('.wizard-panel'));
    initDateRangePicker(overlay);

    const tsEl = document.getElementById('qc-time-start');
    const teEl = document.getElementById('qc-time-end');
    if (tsEl) tsEl.value = timeStart;
    if (teEl) teEl.value = timeEnd;

    // 期限メモの初期表示
    const dateInput = overlay.querySelector('[data-field="Date"]');
    if (dateInput) updateDeadlines(dateInput);

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
        btn.textContent = '作成して詳細ページへ';
        toast('保存失敗: ' + err.message, 'error');
    }
}

// ---- イベント ウィザード（既存イベントの編集用） ----

function genTimeOpts(startH, endH, withEmpty) {
    let html = withEmpty ? '<option value="">--</option>' : '';
    for (let h = startH; h <= endH; h++) {
        for (let m = 0; m < 60; m += 30) {
            if (h === endH && m > 0) break;
            const v = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
            html += `<option value="${v}">${v}</option>`;
        }
    }
    return html;
}

function openEventWizard(editId) {
    editingEventId = editId || null;
    evWizardStep = 0;

    // 新規作成はクイック作成（openQuickCreate）に一本化した。ここは既存イベントの編集専用。
    const existing = editingEventId ? eventsData.find(x => x.ID === editingEventId) : null;
    if (!existing) return;
    const isEdit = true;

    const e = { ...existing, Files: Array.isArray(existing.Files) ? [...existing.Files] : [] };
    evWizardCategory = e.Category || 'normal';

    tempNewEvent = e;

    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const isAdmin = api.isAdmin();
    const catInfo = getEventCategory(evWizardCategory);

    const overlay = document.createElement('div');
    overlay.id = 'ev-wizard-overlay';
    overlay.className = 'wizard-overlay';
    overlay.onclick = (ev) => { if (ev.target === overlay) closeEventWizard(); };

    // 時間未定のイベントに架空の時間を入れない（空欄 = 未定のまま保存できる）
    const timeStart = (e.Event_Time || '').split(' - ')[0]?.trim() || '';
    const timeEnd = (e.Event_Time || '').split(' - ')[1]?.trim() || '';

    let stepsHtml = '';

    if (isMeeting) {
        // Meeting step 1: 基本情報
        stepsHtml += `
            <div class="wizard-step active" data-step="0">
                <div class="wizard-step-label">Step 1 / ${steps.length} &mdash; ${steps[0].label}</div>
                <div style="margin-bottom:12px;"><span class="cat-badge" style="background:${catInfo.bg};color:${catInfo.text};">${catInfo.short}</span></div>
                <div class="flex-row">
                    <div class="e1-group" style="flex:0 0 100px;">
                        <label class="e1-label">回数</label>
                        <input id="wz-ev-meeting-num" class="e1-input" type="number" placeholder="3" value="${escapeAttr(e.Meeting_Number || '')}">
                    </div>
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">ミーティング名</label>
                        <input id="wz-ev-title" class="e1-input" type="text" placeholder="例: イベント振り返り" value="${escapeAttr(e.Title || '')}">
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">場所</label>
                    <input id="wz-ev-location" class="e1-input" type="text" placeholder="例: 学生会館3F" value="${escapeAttr(e.Location || '')}">
                </div>
            </div>`;
        // Meeting step 2: 日時
        stepsHtml += `
            <div class="wizard-step" data-step="1">
                <div class="wizard-step-label">Step 2 / ${steps.length} &mdash; ${steps[1].label}</div>
                <div class="e1-group">
                    <label class="e1-label">日にち</label>
                    <div class="date-range-picker-wrapper">
                        <input type="text" class="e1-input date-range-display" id="wz-ev-date-display" readonly placeholder="クリックして日にちを選択">
                        <input type="hidden" id="wz-ev-date" data-field="Date" value="${escapeAttr(e.Date || '')}">
                        <input type="hidden" id="wz-ev-date-end" data-field="Date_End" value="${escapeAttr(e.Date_End || '')}">
                        <div class="date-range-popup hidden"></div>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">ミーティング時間（未定なら空欄のまま）</label>
                    <div class="time-select-group">
                        <select class="e1-input" id="wz-ev-time-start">${genTimeOpts(7, 21, true)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="wz-ev-time-end">${genTimeOpts(7, 21, true)}</select>
                    </div>
                </div>
            </div>`;
        // Meeting step 3: その他
        stepsHtml += `
            <div class="wizard-step" data-step="2">
                <div class="wizard-step-label">Step 3 / ${steps.length} &mdash; ${steps[2].label}</div>
                <div class="e1-group">
                    <label class="e1-label">議題 / 備考</label>
                    <textarea id="wz-ev-remarks" class="e1-input" rows="6" placeholder="議題や備考を入力">${escapeHtml(e.Remarks || '')}</textarea>
                </div>
            </div>`;
    } else {
        // Event step 1: 基本情報
        stepsHtml += `
            <div class="wizard-step active" data-step="0">
                <div class="wizard-step-label">Step 1 / ${steps.length} &mdash; ${steps[0].label}</div>
                <div style="margin-bottom:12px;"><span class="cat-badge" style="background:${catInfo.bg};color:${catInfo.text};">${catInfo.short}</span></div>
                <div class="e1-group">
                    <label class="e1-label">イベント名 *</label>
                    <input id="wz-ev-title" class="e1-input" type="text" placeholder="例: サイエンスフェスタ" value="${escapeAttr(e.Title || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">場所</label>
                    <input id="wz-ev-location" class="e1-input" type="text" placeholder="例: ○○公民館" value="${escapeAttr(e.Location || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">対象者・人数</label>
                    <input id="wz-ev-audience" class="e1-input" type="text" placeholder="例: 小学1〜3年生 40名" value="${escapeAttr(e.Audience || '')}">
                </div>
            </div>`;
        // Event step 2: 日時
        stepsHtml += `
            <div class="wizard-step" data-step="1">
                <div class="wizard-step-label">Step 2 / ${steps.length} &mdash; ${steps[1].label}</div>
                <div class="e1-group">
                    <label class="e1-label">日にち</label>
                    <div class="date-range-picker-wrapper">
                        <input type="text" class="e1-input date-range-display" id="wz-ev-date-display" readonly placeholder="クリックして日にちを選択">
                        <input type="hidden" id="wz-ev-date" data-field="Date" value="${escapeAttr(e.Date || '')}">
                        <input type="hidden" id="wz-ev-date-end" data-field="Date_End" value="${escapeAttr(e.Date_End || '')}">
                        <div class="date-range-popup hidden"></div>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">イベント時間（未定なら空欄のまま）</label>
                    <div class="time-select-group">
                        <select class="e1-input" id="wz-ev-time-start">${genTimeOpts(7, 21, true)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="wz-ev-time-end">${genTimeOpts(7, 21, true)}</select>
                    </div>
                </div>
                <div class="flex-row">
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">集合時間</label>
                        <select class="e1-input" id="wz-ev-gather">${genTimeOpts(7, 21, true)}</select>
                    </div>
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">解散時間</label>
                        <select class="e1-input" id="wz-ev-dismiss">${genTimeOpts(7, 21, true)}</select>
                    </div>
                </div>
            </div>`;
        // Event step 3: 実験・担当
        stepsHtml += `
            <div class="wizard-step" data-step="2">
                <div class="wizard-step-label">Step 3 / ${steps.length} &mdash; ${steps[2].label}</div>
                <div class="e1-group">
                    <label class="e1-label">実験内容・発表者</label>
                    <div id="wz-ev-exp-container" class="experiments-container"></div>
                    <button class="btn-add-exp" onclick="addWzEvExpRow()" type="button">＋ 実験を追加</button>
                </div>
                <div class="e1-group">
                    <label class="e1-label">帯同（コーディネーター・アドバイザー）</label>
                    <div id="wz-ev-accompany"></div>
                </div>
            </div>`;
        // Event step 4: その他
        stepsHtml += `
            <div class="wizard-step" data-step="3">
                <div class="wizard-step-label">Step 4 / ${steps.length} &mdash; ${steps[3].label}</div>
                <div class="e1-group">
                    <label class="e1-label">スケジュール・運搬</label>
                    <textarea id="wz-ev-logistics" class="e1-input" rows="4" placeholder="タイムテーブルや運搬の段取り">${escapeHtml(e.Meeting_Logistics || '')}</textarea>
                </div>
                <div class="e1-group">
                    <label class="e1-label">備考</label>
                    <textarea id="wz-ev-remarks" class="e1-input" rows="3" placeholder="その他メモ">${escapeHtml(e.Remarks || '')}</textarea>
                </div>
                <div class="e1-group">
                    <label class="e1-label">現地情報（任意・イベント詳細ページの「緊急連絡先・現地情報」に表示）</label>
                    <input id="wz-ev-address" class="e1-input" type="text" placeholder="住所（例: 秋田県大館市桜町1-1）" value="${escapeAttr(e.Address || '')}" style="margin-bottom:8px;">
                    <div class="flex-row">
                        <input id="wz-ev-hospital" class="e1-input" type="text" placeholder="近隣の病院（例: ○○診療所：0186-45-0223）" value="${escapeAttr(e.EmergencyHospital || '')}" style="flex:1;">
                        <input id="wz-ev-police" class="e1-input" type="text" placeholder="近隣の警察署（例: ○○警察署：018-852-4100）" value="${escapeAttr(e.EmergencyPolice || '')}" style="flex:1;">
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">関連ファイル</label>
                    <div class="file-upload-area">
                        <div class="file-drop-zone" id="wz-ev-drop-zone">
                            <p style="margin:0; font-weight:bold;">ファイルをここにドラッグ＆ドロップ</p>
                            <p style="margin:5px 0 0 0; font-size:0.85rem;">またはクリックして選択 (上限 10MB/ファイル)</p>
                        </div>
                        <input type="file" id="wz-ev-file-input" multiple style="display:none;">
                        <div id="wz-ev-file-list" class="file-list-edit"></div>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">書類期限（日付は自動計算されます）</label>
                    <div class="deadline-grid">
                        <div>
                            <label class="text-label" style="font-size:0.85rem; display:block; margin-bottom:4px;">許可願 (担当)</label>
                            <div id="wz-ev-admin-kyoka"></div>
                            <span class="text-muted" style="font-size:0.8rem;">期限: <span id="wz-ev-kyoka-dl">${escapeHtml(e.Kyoka_Deadline || '---')}</span></span>
                        </div>
                        <div>
                            <label class="text-label" style="font-size:0.85rem; display:block; margin-bottom:4px;">報告書 (担当)</label>
                            <div id="wz-ev-admin-houkoku"></div>
                            <span class="text-muted" style="font-size:0.8rem;">期限: <span id="wz-ev-houkoku-dl">${escapeHtml(e.Houkoku_Deadline || '---')}</span></span>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true" style="max-width:560px;">
            <div class="wizard-header">
                <h2 class="wizard-title">${isEdit ? 'イベントを編集' : '新規イベント作成'}</h2>
                <p class="wizard-subtitle">${isEdit ? (e.Title || '') : 'ステップに沿って入力してください'}</p>
            </div>
            <div class="wizard-progress">
                ${steps.map((s, i) => `
                    ${i > 0 ? '<div class="wizard-step-line" data-line="' + i + '"></div>' : ''}
                    <button type="button" class="wizard-step-dot${i === 0 ? ' active' : ''}" data-dot="${i}" title="${s.label}へ移動" onclick="evWizardGoto(${i})">${i + 1}</button>
                `).join('')}
            </div>
            <div class="wizard-body">${stepsHtml}</div>
            <div class="wizard-footer">
                ${isEdit && isAdmin ? '<button class="btn btn-danger" onclick="deleteFromEvWizard()">削除</button>' : ''}
                <div class="wizard-footer-spacer"></div>
                <button class="btn btn-text" onclick="closeEventWizard()">キャンセル</button>
                <button id="wz-ev-prev" class="btn btn-secondary" onclick="evWizardPrev()" style="display:none;">戻る</button>
                <button id="wz-ev-next" class="btn btn-primary" onclick="evWizardNext()">次へ</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    bindModalEscape(overlay, closeEventWizard);
    trapFocus(overlay.querySelector('.wizard-panel'));

    // Initialize time selects
    const tsEl = document.getElementById('wz-ev-time-start');
    const teEl = document.getElementById('wz-ev-time-end');
    if (tsEl) tsEl.value = timeStart;
    if (teEl) teEl.value = timeEnd;
    if (!isMeeting) {
        const gEl = document.getElementById('wz-ev-gather');
        const dEl = document.getElementById('wz-ev-dismiss');
        if (gEl) gEl.value = e.Gather_Time || '';
        if (dEl) dEl.value = e.Dismiss_Time || '';
    }

    // Initialize date range picker
    initDateRangePicker(overlay);

    // Initialize experiment rows (event only)
    if (!isMeeting) {
        const expContainer = document.getElementById('wz-ev-exp-container');
        const expList = parsePartsList(e.PartsList);
        expList.forEach(item => {
            expContainer.appendChild(buildExperimentRow(item.name, item.presenters));
        });

        // Initialize accompany tag input
        const accompanyEl = document.getElementById('wz-ev-accompany');
        const accompanyVals = (e.Accompany || '').split(',').map(s => s.trim()).filter(Boolean);
        initTagInput(accompanyEl, accompanyVals, 'コーディネーター・アドバイザーを検索...', isStaffMember);

        // Initialize admin tag inputs for deadlines
        const kyokaEl = document.getElementById('wz-ev-admin-kyoka');
        const houkokuEl = document.getElementById('wz-ev-admin-houkoku');
        const kyokaVals = (e.Admin_Kyoka || '').split(',').map(s => s.trim()).filter(Boolean);
        const houkokuVals = (e.Admin_Houkoku || '').split(',').map(s => s.trim()).filter(Boolean);
        initTagInput(kyokaEl, kyokaVals, '担当者を検索...', isRegularMember);
        initTagInput(houkokuEl, houkokuVals, '担当者を検索...', isRegularMember);

        // File upload bindings
        const dropZone = document.getElementById('wz-ev-drop-zone');
        const fileInput = document.getElementById('wz-ev-file-input');
        if (dropZone) {
            dropZone.addEventListener('drop', (ev) => { ev.preventDefault(); dropZone.classList.remove('dragover'); const files = [...(ev.dataTransfer.files || [])]; if (files.length) wzUploadFiles(files); });
            dropZone.addEventListener('dragover', (ev) => ev.preventDefault());
            dropZone.addEventListener('dragenter', () => dropZone.classList.add('dragover'));
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
            dropZone.addEventListener('click', () => fileInput.click());
        }
        if (fileInput) {
            fileInput.addEventListener('change', () => { wzUploadFiles(Array.from(fileInput.files)); fileInput.value = ''; });
        }
        // Render existing files
        wzRefreshFileList();
    }

    setTimeout(() => {
        const firstInput = overlay.querySelector('.wizard-step.active input:not([type="hidden"]), .wizard-step.active textarea, .wizard-step.active select');
        if (firstInput) firstInput.focus();
    }, 80);
}

function closeEventWizard() {
    const overlay = document.getElementById('ev-wizard-overlay');
    if (overlay) overlay.remove();
    editingEventId = null;
    evWizardStep = 0;
    tempNewEvent = null;
}

function updateEvWizardUI() {
    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const total = steps.length;
    const isLast = evWizardStep === total - 1;

    document.querySelectorAll('#ev-wizard-overlay .wizard-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === evWizardStep);
    });
    document.querySelectorAll('#ev-wizard-overlay .wizard-step-dot').forEach(el => {
        const i = parseInt(el.dataset.dot);
        el.classList.toggle('active', i === evWizardStep);
        el.classList.toggle('done', i < evWizardStep);
    });
    document.querySelectorAll('#ev-wizard-overlay .wizard-step-line').forEach(el => {
        const i = parseInt(el.dataset.line);
        el.classList.toggle('done', i <= evWizardStep);
    });

    const prevBtn = document.getElementById('wz-ev-prev');
    const nextBtn = document.getElementById('wz-ev-next');
    if (prevBtn) prevBtn.style.display = evWizardStep > 0 ? '' : 'none';
    if (nextBtn) nextBtn.textContent = isLast ? '保存' : '次へ';
}

function evWizardPrev() {
    if (evWizardStep > 0) { evWizardStep--; updateEvWizardUI(); }
}

// 進捗ドットのクリックで任意のステップへ移動（1項目だけ直したい時に全ステップたどらなくてよい）
function evWizardGoto(n) {
    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    if (n < 0 || n >= steps.length || n === evWizardStep) return;
    evWizardStep = n;
    updateEvWizardUI();
    const step = document.querySelector('#ev-wizard-overlay .wizard-step.active');
    if (step) {
        const fi = step.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
        if (fi) setTimeout(() => fi.focus(), 100);
    }
}

function evWizardNext() {
    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const total = steps.length;

    if (evWizardStep === 0 && !isMeeting) {
        const title = document.getElementById('wz-ev-title').value.trim();
        if (!title) {
            toast('イベント名を入力してください', 'error');
            document.getElementById('wz-ev-title').focus();
            return;
        }
    }

    if (evWizardStep < total - 1) {
        evWizardStep++;
        updateEvWizardUI();
        const step = document.querySelector('#ev-wizard-overlay .wizard-step.active');
        if (step) {
            const fi = step.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
            if (fi) setTimeout(() => fi.focus(), 100);
        }
    } else {
        saveEventFromWizard();
    }
}

function addWzEvExpRow() {
    const container = document.getElementById('wz-ev-exp-container');
    if (container) container.appendChild(buildExperimentRow('', []));
}

// ---- ウィザード内ファイルアップロード ----
async function wzUploadFiles(fileList) {
    const maxSizeMB = (CONFIG.FILE_UPLOAD && CONFIG.FILE_UPLOAD.maxSizeMB) || 10;
    for (const file of fileList) {
        if (file.size > maxSizeMB * 1024 * 1024) {
            toast(`「${file.name}」はサイズ上限(${maxSizeMB}MB)を超えています`, 'error');
            continue;
        }
        if (!tempNewEvent) continue;
        if (!Array.isArray(tempNewEvent.Files)) tempNewEvent.Files = [];

        const placeholder = { name: file.name, size: file.size, _uploading: true };
        tempNewEvent.Files.push(placeholder);
        wzRefreshFileList();

        try {
            const result = await api.uploadFile(file);
            const idx = tempNewEvent.Files.indexOf(placeholder);
            if (idx >= 0) tempNewEvent.Files[idx] = result;
            else tempNewEvent.Files.push(result);
            toast(`「${file.name}」をアップロードしました`, 'success', 2000);
        } catch (err) {
            toast(`「${file.name}」のアップロード失敗: ${err.message}`, 'error');
            const idx = tempNewEvent.Files.indexOf(placeholder);
            if (idx >= 0) tempNewEvent.Files[idx] = { name: file.name, size: file.size, _failed: true };
        }
        wzRefreshFileList();
    }
}

function wzRemoveFile(index) {
    if (!tempNewEvent || !Array.isArray(tempNewEvent.Files)) return;
    const file = tempNewEvent.Files[index];
    if (!file) return;
    if (file.driveId) {
        if (!Array.isArray(tempNewEvent._filesToDelete)) tempNewEvent._filesToDelete = [];
        tempNewEvent._filesToDelete.push(file.driveId);
    }
    tempNewEvent.Files.splice(index, 1);
    wzRefreshFileList();
}

function wzRefreshFileList() {
    const el = document.getElementById('wz-ev-file-list');
    if (!el || !tempNewEvent) return;
    const files = tempNewEvent.Files || [];
    if (files.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML = files.map((f, i) => {
        const name = escapeHtml(f.name || ('ファイル ' + (i + 1)));
        const size = f.size ? formatFileSize(f.size) : '';
        const uploading = f._uploading;
        const failed = f._failed;
        let statusCls = '';
        let statusLabel = '';
        if (uploading) { statusCls = ' uploading'; statusLabel = ' (アップロード中...)'; }
        if (failed) { statusCls = ' upload-failed'; statusLabel = ' (アップロード失敗)'; }
        return `
            <div class="file-item${statusCls}" data-index="${i}">
                <span class="file-name">${name}${statusLabel}</span>
                <span class="file-size">${size}</span>
                <div class="file-actions">
                    ${!uploading && !failed && f.url ? `<a href="${escapeAttr(f.url)}" target="_blank" rel="noopener" class="tbl-btn">開く</a>` : ''}
                    <button class="tbl-btn tbl-btn-danger" onclick="wzRemoveFile(${i})" type="button">${uploading ? 'キャンセル' : '削除'}</button>
                </div>
            </div>
        `;
    }).join('');
}

// ---- ウィザードから保存 ----
function saveEventFromWizard() {
    if (!tempNewEvent) return;

    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';

    // Collect form data
    tempNewEvent.Title = (document.getElementById('wz-ev-title')?.value || '').trim();
    if (!tempNewEvent.Title) {
        // ドットで直接最終ステップへ来られるため、保存時にも必須チェックする
        toast(isMeeting ? 'ミーティング名を入力してください' : 'イベント名を入力してください', 'error');
        evWizardGoto(0);
        return;
    }
    tempNewEvent.Location = (document.getElementById('wz-ev-location')?.value || '').trim();
    // 現地情報の入力欄はイベントの Step 4 のみに存在する。
    // ミーティング編集時は欄が無いので、既存値を消さないよう存在チェックしてから反映する。
    const addrEl = document.getElementById('wz-ev-address');
    if (addrEl) tempNewEvent.Address = addrEl.value.trim();
    const hospEl = document.getElementById('wz-ev-hospital');
    if (hospEl) tempNewEvent.EmergencyHospital = hospEl.value.trim();
    const polEl = document.getElementById('wz-ev-police');
    if (polEl) tempNewEvent.EmergencyPolice = polEl.value.trim();
    tempNewEvent.Category = evWizardCategory;
    tempNewEvent.Date = document.getElementById('wz-ev-date')?.value || '';
    tempNewEvent.Date_End = document.getElementById('wz-ev-date-end')?.value || '';
    tempNewEvent.Remarks = (document.getElementById('wz-ev-remarks')?.value || '');

    const ts = document.getElementById('wz-ev-time-start')?.value || '';
    const te = document.getElementById('wz-ev-time-end')?.value || '';
    if ((ts && !te) || (!ts && te)) {
        toast('時間は開始と終了の両方を選択してください（未定なら両方空欄）', 'error');
        evWizardGoto(1);
        return;
    }
    tempNewEvent.Event_Time = ts && te ? `${ts} - ${te}` : '';

    if (isMeeting) {
        tempNewEvent.Meeting_Number = document.getElementById('wz-ev-meeting-num')?.value || '';
    } else {
        tempNewEvent.Audience = (document.getElementById('wz-ev-audience')?.value || '').trim();
        tempNewEvent.Gather_Time = document.getElementById('wz-ev-gather')?.value || '';
        tempNewEvent.Dismiss_Time = document.getElementById('wz-ev-dismiss')?.value || '';
        tempNewEvent.Meeting_Logistics = (document.getElementById('wz-ev-logistics')?.value || '');

        // Collect experiments
        const expContainer = document.getElementById('wz-ev-exp-container');
        if (expContainer) {
            const rows = expContainer.querySelectorAll('.experiment-row');
            const collected = [];
            rows.forEach(row => {
                const name = (row.querySelector('.experiment-name')?.value || '').trim();
                const tagContainer = row.querySelector('.presenter-tag-container');
                const presenters = tagContainer?._tagInput ? tagContainer._tagInput.getValues() : [];
                if (name || presenters.length > 0) collected.push({ name, presenters });
            });
            tempNewEvent.PartsList = JSON.stringify(collected);
        }

        // Collect tag inputs
        const accompanyEl = document.getElementById('wz-ev-accompany');
        if (accompanyEl?._tagInput) tempNewEvent.Accompany = accompanyEl._tagInput.getValues().join(', ');
        const kyokaEl = document.getElementById('wz-ev-admin-kyoka');
        if (kyokaEl?._tagInput) tempNewEvent.Admin_Kyoka = kyokaEl._tagInput.getValues().join(', ');
        const houkokuEl = document.getElementById('wz-ev-admin-houkoku');
        if (houkokuEl?._tagInput) tempNewEvent.Admin_Houkoku = houkokuEl._tagInput.getValues().join(', ');
    }

    // Recalculate deadlines
    if (isMeeting) {
        tempNewEvent.Kyoka_Deadline = '';
        tempNewEvent.Houkoku_Deadline = '';
    } else {
        const dl = calculateDeadlines(tempNewEvent.Date);
        tempNewEvent.Kyoka_Deadline = dl.kyoka;
        tempNewEvent.Houkoku_Deadline = dl.houkoku;
    }

    // Uploading check
    if (Array.isArray(tempNewEvent.Files) && tempNewEvent.Files.some(f => f._uploading)) {
        toast('ファイルのアップロードが完了するまでお待ちください', 'error');
        return;
    }
    if (Array.isArray(tempNewEvent.Files)) {
        tempNewEvent.Files = tempNewEvent.Files.filter(f => !f._failed);
    }

    const eventIndex = eventsData.findIndex(x => x.ID === tempNewEvent.ID);
    const gasItem = uiToGas(tempNewEvent);
    if (eventIndex > -1) gasItem._baseUpdatedAt = tempNewEvent.UpdatedAt || '';

    const filesToDelete = Array.isArray(tempNewEvent._filesToDelete) ? tempNewEvent._filesToDelete.slice() : [];

    // Optimistic UI
    const snapshot = JSON.parse(JSON.stringify(eventsData));
    const optimisticItem = { ...tempNewEvent };
    delete optimisticItem._filesToDelete;

    if (eventIndex > -1) {
        eventsData[eventIndex] = optimisticItem;
    } else {
        eventsData.unshift(optimisticItem);
    }
    api.saveCache('events', eventsData);
    renderEvents();
    if (calendarVisible) refreshCalendar();

    closeEventWizard();
    toast('保存しました', 'success');

    // 許可願の期限が過去なのにイベントがまだ先の場合は注意を促す（保存は妨げない）
    if (!isMeeting && optimisticItem.Kyoka_Deadline && optimisticItem.Kyoka_Deadline < todayISO()
        && (optimisticItem.Date_End || optimisticItem.Date) >= todayISO()) {
        toast(`許可願の期限（${optimisticItem.Kyoka_Deadline}）を過ぎています。至急対応してください`, 'error', 6000);
    }

    api.save('events', gasItem).then(savedGas => {
        const savedEvent = gasToUi(savedGas);
        const idx = eventsData.findIndex(x => x.ID === optimisticItem.ID);
        if (idx >= 0) {
            eventsData[idx] = savedEvent;
            api.saveCache('events', eventsData);
        }
        filesToDelete.forEach(driveId => { api.deleteFile(driveId).catch(() => {}); });
    }).catch(err => {
        eventsData.splice(0, eventsData.length, ...snapshot);
        api.saveCache('events', eventsData);
        renderEvents();
        if (calendarVisible) refreshCalendar();
        if (String(err.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 5000);
            refreshData();
        } else {
            toast('保存失敗: ' + err.message, 'error');
        }
    });
}

// ---- イベント削除（ウィザード内から） ----
function deleteFromEvWizard() {
    if (!editingEventId) return;
    const id = editingEventId;
    closeEventWizard();
    confirmDeleteEvent(id);
}

// ---- イベント削除（確認ダイアログ） ----
function confirmDeleteEvent(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => confirmDeleteEvent(id));
        return;
    }
    const ev = eventsData.find(x => x.ID === id);
    if (!ev) return;

    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <h3>「${escapeHtml(ev.Title || '(無題)')}」を削除</h3>
            <p>この操作は元に戻せます（削除直後のみ）。</p>
            <div class="confirm-dialog-actions">
                <button class="btn btn-secondary" onclick="this.closest('.confirm-dialog-overlay').remove()">キャンセル</button>
                <button class="btn btn-danger" id="confirm-ev-del-btn">削除する</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    bindModalEscape(overlay, () => overlay.remove());

    overlay.querySelector('#confirm-ev-del-btn').onclick = () => {
        overlay.remove();
        executeDeleteEvent(id);
    };
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

// Temporary storage for the event currently being created or edited in the modal
let tempNewEvent = null;

// 日付変更時に期限表示を即時更新する（期限は自動計算のみ・表示専用スパン）。
// 実際の保存値は saveEventFromWizard / saveQuickCreate で確定する。
// 許可願の期限が既に過ぎている場合は赤字で警告する。
function updateDeadlines(dateInput) {
    const newDate = dateInput.value;
    const cat = (tempNewEvent && tempNewEvent.Category) || 'normal';
    const isMeeting = cat === 'general' || cat === 'admin';
    const calc = isMeeting ? { kyoka: '', houkoku: '' } : calculateDeadlines(newDate);
    const kyokaPast = !!calc.kyoka && calc.kyoka < todayISO();

    // 編集ウィザード（Step 4 の期限表示）
    const wzKyoka = document.getElementById('wz-ev-kyoka-dl');
    const wzHoukoku = document.getElementById('wz-ev-houkoku-dl');
    if (wzKyoka) {
        wzKyoka.textContent = calc.kyoka || '---';
        wzKyoka.classList.toggle('deadline-past', kyokaPast);
        wzKyoka.title = kyokaPast ? '許可願の期限が既に過ぎています' : '';
    }
    if (wzHoukoku) wzHoukoku.textContent = calc.houkoku || '---';

    // クイック作成（日付の下の期限メモ）
    const qcNote = document.getElementById('qc-deadline-note');
    if (qcNote) {
        if (isMeeting || !newDate) {
            qcNote.innerHTML = '';
        } else {
            qcNote.innerHTML = `書類期限（自動計算）: 許可願 <strong class="${kyokaPast ? 'deadline-past' : ''}">${escapeHtml(calc.kyoka)}</strong> ／ 報告書 ${escapeHtml(calc.houkoku)}`
                + (kyokaPast ? '<br><span class="deadline-past">開催日まで10日を切っています。許可願を至急提出してください。</span>' : '');
        }
    }
}

function calculateDeadlines(dateStr) {
    if (!dateStr) return { kyoka: '', houkoku: '' };

    const eventDate = parseISODate(dateStr); // タイムゾーン安全
    const rules = CONFIG.DEADLINE_RULES;

    const kyokaDate = new Date(eventDate);
    kyokaDate.setDate(eventDate.getDate() + rules.kyoka); // 既定: -10日

    const houkokuDate = new Date(eventDate);
    houkokuDate.setDate(eventDate.getDate() + rules.houkoku); // 既定: +7日

    return {
        kyoka: toISODate(kyokaDate),
        houkoku: toISODate(houkokuDate)
    };
}

// 日付フォーマットは app.js の toISODate / todayISO を使用
