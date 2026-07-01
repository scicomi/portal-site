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
        SeriesKey: u.SeriesKey || '',
        Positives: u.Positives || '',
        Reflections: u.Reflections || '',
        ReportStatus: u.ReportStatus || '',  // 報告書ステータスをイベント編集保存でも保持する
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
            const saveBtn = document.querySelector('.modal-content .btn-primary:not(.hidden), .event-card.editing .btn-primary:not(.hidden)');
            if (saveBtn) { e.preventDefault(); saveBtn.click(); }
        }
        return;
    }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openNewEventModal(); }
    if (e.key === '/' && document.getElementById('event-search')) {
        e.preventDefault();
        document.getElementById('event-search').focus();
    }
    if (e.key === 'Escape') closeAnyOpenModal();
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

// ---- 時刻選択肢を動的生成 ----
function populateTimeSelects() {
    function genOpts(startH, endH, withEmpty) {
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
    const modal = document.getElementById('new-event-form-container');
    if (!modal) return;
    const startSel = modal.querySelector('.time-start-select');
    const endSel = modal.querySelector('.time-end-select');
    if (startSel) { startSel.innerHTML = genOpts(9, 21, false); startSel.value = '13:00'; }
    if (endSel) { endSel.innerHTML = genOpts(9, 21, false); endSel.value = '16:00'; }
    const gatherSel = modal.querySelector('.gather-time-select');
    const dismissSel = modal.querySelector('.dismiss-time-select');
    if (gatherSel) gatherSel.innerHTML = genOpts(7, 21, true);
    if (dismissSel) dismissSel.innerHTML = genOpts(7, 21, true);
}

// ---- 起動 ----
document.addEventListener('DOMContentLoaded', () => {
    bootPage('events', init);
});

async function init() {
    bindOverlayClose(document.getElementById('modal-overlay'), closeModal);
    holidaysData = await api.loadHolidaysCached();
    populateTimeSelects();

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
        focusEventFromUrl();
    }

    if (cached) updateSyncStatus('cached', cached.timestamp);
    else updateSyncStatus('initial-loading');

    refreshData();
}

// ホーム等から ?event=<ID>（&tab=feedback）で来た場合、そのイベントの詳細モーダルを開く。
// データ未取得のうちは何もせず、refreshData 後に再度試みる（focusHandled で一度だけ実行）。
let eventFocusHandled = false;
function focusEventFromUrl() {
    if (eventFocusHandled) return;
    const params = new URLSearchParams(location.search);
    const id = params.get('event');
    if (!id) return;
    const ev = eventsData.find(e => e.ID === id);
    if (!ev) return; // まだ読み込まれていない → リフレッシュ後に再試行
    eventFocusHandled = true;
    viewEventInModal(id);
    if (params.get('tab') === 'feedback') {
        const container = document.getElementById('new-event-form-container');
        const fbBtn = container && container.querySelector('.event-tab[data-tab="feedback"]');
        if (fbBtn) switchEventTab(fbBtn);
    }
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
        const curFY = (function(){ const n = new Date(); return (n.getMonth()+1) >= 4 ? n.getFullYear() : n.getFullYear()-1; })();
        memberDl.innerHTML = members
            .filter(m => parseInt(m.FiscalYear || curFY) === curFY && m.Name)
            .map(m => {
                const role = m.Role || (m.Category === 'adviser' ? 'アドバイザー' : m.Category === 'coordinator' ? 'コーディネーター' : '');
                return `<option value="${escapeAttr(m.Name)}">${escapeAttr(role || 'メンバー')}</option>`;
            })
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
        focusEventFromUrl();
        if (calendarVisible) refreshCalendar();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
    }
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

function initFullCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;
    if (typeof FullCalendar === 'undefined') {
        setTimeout(initFullCalendar, 50);
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
            document.getElementById('new-event-edit-modal').classList.add('hidden');
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
            viewEventInModal(info.event.id);
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

function viewEventInModal(id) {
    const eventData = eventsData.find(e => e.ID === id);
    if (!eventData) return;

    _modalPrevFocus = document.activeElement;
    document.getElementById('modal-overlay').classList.remove('hidden');
    bindModalEscape(document.getElementById('modal-overlay'), closeModal);
    const catModal = document.getElementById('category-selection-modal');
    if (catModal) catModal.classList.add('hidden');
    document.getElementById('new-event-edit-modal').classList.remove('hidden');

    const headerTitle = document.querySelector('#new-event-edit-modal h2');
    if (headerTitle) headerTitle.textContent = "イベント詳細";

    const actionButtons = document.getElementById('modal-action-buttons');
    if (actionButtons) {
        actionButtons.innerHTML = `
            <button class="btn btn-text" onclick="closeModal()">閉じる</button>
            <button class="btn btn-secondary" onclick="closeModal(); openEventWizard('${id}')">編集</button>
        `;
    }

    renderModalForm(eventData, false);

    // Show tab bar for existing events
    const container = document.getElementById('new-event-form-container');
    const tabBar = container.querySelector('.event-tab-bar');
    if (tabBar) tabBar.classList.remove('hidden');

    const voteLink = container.querySelector('[data-field="VoteLink"]');
    if (voteLink) voteLink.href = 'vote.html?id=' + encodeURIComponent(id);
}

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
    tbody.innerHTML = sorted.map(ev => {
        const cat = getEventCategory(ev.Category);
        let displayTitle = ev.Title || '(無題)';
        if (cat.isMeeting && ev.Meeting_Number) {
            displayTitle = `第${ev.Meeting_Number}回 ${displayTitle}`;
        }
        const occ = occurrenceInfo(ev);
        return `
            <tr class="clickable-row" onclick="viewEventInModal('${ev.ID}')">
                <td class="cell-name" style="white-space:nowrap;">
                    ${escapeHtml(ev.Date || '')} <span class="text-muted">(${dayOfWeekJP(ev.Date)})</span>
                    ${ev.Date_End && ev.Date_End !== ev.Date ? '<br><span class="text-muted" style="font-size:0.8rem;">〜 ' + escapeHtml(ev.Date_End) + '</span>' : ''}
                </td>
                <td>
                    <span style="font-weight:600;">${escapeHtml(displayTitle)}</span>
                    <span class="cat-badge" style="background:${cat.bg};color:${cat.text};margin-left:6px;">${cat.short}</span>
                    ${occ ? `<a href="event-series.html?key=${encodeURIComponent(eventSeriesKey(ev))}" class="occ-badge occ-link" title="通算${occ.total}回 — シリーズ履歴を見る" onclick="event.stopPropagation();">${occ.num}回目</a>` : ''}
                </td>
                <td class="hide-mobile">${escapeHtml(ev.Location || '')}</td>
                <td class="hide-mobile">${escapeHtml(ev.Event_Time || '')}</td>
                <td onclick="event.stopPropagation()">
                    <div class="inline-actions">
                        <a class="inline-action-btn" href="vote.html?id=${encodeURIComponent(ev.ID)}" title="参加投票" style="text-decoration:none;">&#x2714;</a>
                        <button class="inline-action-btn" onclick="openEventWizard('${ev.ID}')" title="編集">&#9998;</button>
                        ${isAdmin ? `<button class="inline-action-btn danger" onclick="confirmDeleteEvent('${ev.ID}')" title="削除">&#x2715;</button>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// Populate fields within a card element
function populateFields(cardElement, eventData) {
    // Determine category to toggle sections
    const cat = eventData.Category || 'normal';
    const isMeeting = cat === 'general' || cat === 'admin';

    // Hide/Show event specific sections
    cardElement.querySelectorAll('.event-only-section').forEach(sec => {
        if (isMeeting) {
            sec.style.display = 'none';
        } else {
            sec.style.display = ''; // default
        }
    });

    // Hide/Show meeting only sections
    cardElement.querySelectorAll('.meeting-only-section').forEach(sec => {
        sec.style.display = isMeeting ? '' : 'none';
    });

    const remarksLabel = cardElement.querySelector('.remarks-label');
    if (remarksLabel) {
        remarksLabel.textContent = isMeeting ? '議題 / 備考' : '備考';
    }

    const fields = ['Title', 'Location', 'Audience', 'Meeting_Number', 'Date', 'Date_End', 'Event_Time', 'Meeting_Logistics', 'Remarks', 'Belongings', 'Positives', 'Reflections'];

    fields.forEach(field => {
        // Display elements
        let val = eventData[field] || '---';
        if (field === 'Date') return; // Skip basic Date, we handle it specially below
        if (field === 'Date_End') return; // Handled specially

        const displayEl = cardElement.querySelector(`.display-mode[data-field="${field}"]`);
        if (displayEl) {
            // text-area-view は CSS の white-space:pre-wrap で改行が出るので textContent でOK（XSS安全）
            displayEl.textContent = val;
        }

        // Input elements
        const inputEls = cardElement.querySelectorAll(`.edit-mode[data-field="${field}"]`);
        inputEls.forEach(el => {
            el.value = eventData[field] || '';
        });
    });

    // Special Date Display Logic
    const dateDisplayEl = cardElement.querySelector('.display-mode[data-field="Date_Display"]');
    if (dateDisplayEl) {
        if (eventData.Date_End && eventData.Date_End !== eventData.Date) {
            dateDisplayEl.textContent = `${eventData.Date} 〜 ${eventData.Date_End}`;
        } else {
            dateDisplayEl.textContent = eventData.Date || '---';
        }
        const occ = occurrenceInfo(eventData);
        if (occ) {
            const b = document.createElement('a');
            b.className = 'occ-badge occ-link';
            b.href = `event-series.html?key=${encodeURIComponent(eventSeriesKey(eventData))}`;
            b.title = 'シリーズ履歴を見る';
            b.textContent = `${occ.num}回目 / 通算${occ.total}回`;
            b.onclick = (e) => e.stopPropagation();
            dateDisplayEl.appendChild(b);
        }
    }

    // Special Date Inputs
    ['Date', 'Date_End'].forEach(df => {
        cardElement.querySelectorAll(`.edit-mode[data-field="${df}"]`).forEach(el => {
            el.value = eventData[df] || '';
        });
    });

    // 日付レンジピッカー（クリックでカレンダーを開く）を初期化
    initDateRangePicker(cardElement);

    // Deadlines & Admins Special Handling
    const adminFields = ['Admin_Kyoka', 'Admin_Houkoku', 'Kyoka_Deadline', 'Houkoku_Deadline'];
    adminFields.forEach(field => {
        const val = eventData[field] || '---';
        const displayEls = cardElement.querySelectorAll(`[data-field="${field}"]`);
        displayEls.forEach(el => {
            if (el.tagName === 'INPUT') {
                el.value = eventData[field] || '';
            } else {
                el.textContent = val;
            }
        });
    });

    // Time Selects in Edit mode
    if (eventData.Event_Time) {
        let [s, e] = eventData.Event_Time.split(' - ');
        const selStart = cardElement.querySelector('select[data-field="Time_Start"]');
        const selEnd = cardElement.querySelector('select[data-field="Time_End"]');
        if (selStart && s) selStart.value = s.trim();
        if (selEnd && e) selEnd.value = e.trim();
    }

    // Dynamic List for Experiments & Presenters (flat format)
    const expDisplay = cardElement.querySelector('.display-mode[data-field="Experiments_Display"]');
    const expContainer = cardElement.querySelector('.experiments-container');
    const expList = parsePartsList(eventData.PartsList);

    if (expDisplay) {
        let displayHtml = '';
        expList.forEach(item => {
            if (!item.name && item.presenters.length === 0) return;
            let expNameHtml;
            if (item.name) {
                const allExp = (api.loadCache('experiments') || {}).items || [];
                const match = allExp.find(e => e.Name === item.name);
                const href = match
                    ? `experiment-detail.html?id=${encodeURIComponent(match.ID)}`
                    : `experiments.html?focus=${encodeURIComponent(item.name)}`;
                expNameHtml = `<a href="${href}" class="exp-link-inline" title="実験内容を見る">${escapeHtml(item.name)}</a>`;
            } else {
                expNameHtml = '(未定)';
            }
            const presenterText = item.presenters.length > 0
                ? item.presenters.map(p => escapeHtml(p)).join(', ')
                : '未定';
            displayHtml += `<span class="tag tag-exp">${expNameHtml} <span class="tag-presenter">(${presenterText})</span></span>`;
        });
        expDisplay.innerHTML = displayHtml || '---';
    }

    if (expContainer) {
        expContainer.innerHTML = '';
        expList.forEach(item => {
            expContainer.appendChild(buildExperimentRow(item.name, item.presenters));
        });
    }

    // Initialize admin tag inputs
    cardElement.querySelectorAll('.admin-tag-container').forEach(container => {
        const field = container.dataset.adminField;
        const currentVal = eventData[field] || '';
        const vals = currentVal ? currentVal.split(',').map(s => s.trim()).filter(Boolean) : [];
        // 帯同(Accompany)はコーディネーター・アドバイザーのみ。
        // 許可願・報告書の担当はそれ以外のメンバーのみ。
        const isAccompany = field === 'Accompany';
        const filterFn = isAccompany ? isStaffMember : isRegularMember;
        const ph = isAccompany ? 'コーディネーター・アドバイザーを検索...' : '担当者を検索...';
        initTagInput(container, vals, ph, filterFn);
    });

    // Title mapping overrides for Meeting Mode
    const titleDisplay = cardElement.querySelector('.display-mode[data-field="Title_Display"]');
    if (titleDisplay) {
        if (isMeeting) {
            titleDisplay.innerHTML = `<span class="text-primary" style="font-size: 1.25rem;">回数：[ ${eventData.Meeting_Number || '?'} ] [ ${eventData.Title || ''} ]</span>`;
        } else {
            titleDisplay.innerHTML = `<span class="text-primary" style="font-size: 1.25rem;">${eventData.Title || ''}</span>`;
        }
    }
    const meetingNumInput = cardElement.querySelector('#meeting-num-input');
    if (meetingNumInput && isMeeting) {
        meetingNumInput.value = eventData.Meeting_Number || '';
    }
    const meetingTitleInput = cardElement.querySelector('#meeting-name-input');
    if (meetingTitleInput && isMeeting) {
        meetingTitleInput.value = eventData.Title || '';
    }

    // Populate series feedback history
    renderSeriesFeedback(cardElement, eventData);

    // Populate feedback tab
    const fbTabPositives = cardElement.querySelector('.fb-tab-positives');
    const fbTabReflections = cardElement.querySelector('.fb-tab-reflections');
    if (fbTabPositives) fbTabPositives.value = eventData.Positives || '';
    if (fbTabReflections) fbTabReflections.value = eventData.Reflections || '';

    const expFbTab = cardElement.querySelector('[data-field="ExpFeedback_Tab"]');
    if (expFbTab) {
        const expNames = new Set();
        expList.forEach(it => { if (it.name) expNames.add(it.name); });
        if (expNames.size > 0) {
            const experiments = (api.loadCache('experiments') || {}).items || [];
            expFbTab.innerHTML = [...expNames].map(name => {
                const exp = experiments.find(e => e.Name === name);
                const detailLink = exp
                    ? `<a href="experiment-detail.html?id=${encodeURIComponent(exp.ID)}" target="_blank" onclick="event.stopPropagation();">${escapeHtml(name)}</a>`
                    : escapeHtml(name);
                return `<div class="exp-fb-card" data-exp-name="${escapeAttr(name)}">
                    <div class="exp-fb-card-title">${detailLink}</div>
                    <div class="exp-fb-row">
                        <label>良かった点</label>
                        <textarea class="e1-input exp-fb-positive" rows="2" placeholder="この実験で良かったこと"></textarea>
                    </div>
                    <div class="exp-fb-row">
                        <label>改善点</label>
                        <textarea class="e1-input exp-fb-reflection" rows="2" placeholder="この実験の改善点"></textarea>
                    </div>
                </div>`;
            }).join('');
        } else {
            expFbTab.innerHTML = '<p class="text-hint" style="font-size:0.85rem;">実験が登録されていないため、実験の振り返りは入力できません。</p>';
        }
    }

    // File processing (Phase 2: Drive upload)
    const fileContainer = cardElement.querySelector('.display-mode[data-field="Files_Display"]');
    const fileListEdit = cardElement.querySelector('.file-list-edit');
    const files = Array.isArray(eventData.Files) ? eventData.Files : [];

    if (fileContainer) {
        if (files.length > 0) {
            fileContainer.innerHTML = files.map((f, i) => {
                const url = f.url || '';
                const name = escapeHtml(f.name || ('ファイル ' + (i + 1)));
                const size = f.size ? ' (' + formatFileSize(f.size) + ')' : '';
                if (/^https?:\/\//i.test(url)) {
                    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="file-link">${name}${size}</a>`;
                }
                return `<span class="file-link text-hint">${name} (リンク切れ)</span>`;
            }).join('');
        } else {
            fileContainer.innerHTML = '<span class="text-hint" style="font-size:0.9rem;">なし</span>';
        }
    }

    if (fileListEdit) {
        renderEditFileList(fileListEdit, files);
    }
}

// イベントの閲覧はモーダル、編集・作成・削除はウィザード経由:
//   表示  → viewEventInModal()
//   編集  → openEventWizard(id)
//   新規  → openNewEventModal() → startNewEvent() → openEventWizard()
//   削除  → confirmDeleteEvent(id)

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
    const curFY = (function(){ const n = new Date(); return (n.getMonth()+1) >= 4 ? n.getFullYear() : n.getFullYear()-1; })();
    return cached.filter(m => parseInt(m.FiscalYear || curFY) === curFY && m.Name);
}

// メンバーの役職判定（Role 優先、無ければ旧 Category から導出）
function memberRole(m) {
    return m.Role || (m.Category === 'adviser' ? 'アドバイザー' : m.Category === 'coordinator' ? 'コーディネーター' : '');
}
function isStaffMember(m) {
    const r = memberRole(m);
    return r === 'アドバイザー' || r === 'コーディネーター';
}
function isRegularMember(m) {
    return !isStaffMember(m);
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
            dropdown.innerHTML = filtered.slice(0, 15).map(m =>
                `<div class="tag-input-option" data-value="${escapeAttr(m.Name)}">${escapeHtml(m.Name)}${m.Furigana ? ' <span class="text-hint" style="font-size:0.8em;">(' + escapeHtml(m.Furigana) + ')</span>' : ''}</div>`
            ).join('');
        }
        dropdown.classList.remove('hidden');
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
    document.getElementById('new-event-edit-modal').classList.add('hidden');
    bindModalEscape(document.getElementById('modal-overlay'), closeModal);
    populateTemplateDropdown();
}

function populateTemplateDropdown() {
    const sel = document.getElementById('template-source');
    if (!sel) return;
    const sorted = eventsData.slice().sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
    sel.innerHTML = '<option value="">-- 過去イベントを選んで複製 --</option>' +
        sorted.slice(0, 50).map(e => {
            const catLabel = { normal: '通常', other: '学内', general: '全体', admin: '幹部' }[e.Category] || '';
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
    openEventWizard(null, category, template);
}

// ---- イベント ウィザード ----

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

function openEventWizard(editId, category, templateSrc) {
    editingEventId = editId || null;
    evWizardStep = 0;

    const existing = editingEventId ? eventsData.find(x => x.ID === editingEventId) : null;
    const isEdit = !!existing;

    let e;
    if (isEdit) {
        e = { ...existing, Files: Array.isArray(existing.Files) ? [...existing.Files] : [] };
        evWizardCategory = e.Category || 'normal';
    } else if (templateSrc) {
        const newId = genId('ev_');
        const startDate = window.tempStart || todayISO();
        const endDate = window.tempEnd || '';
        window.tempStart = null;
        window.tempEnd = null;
        e = { ...templateSrc };
        e.ID = newId;
        e.Date = startDate;
        e.Date_End = endDate;
        e.Title = (templateSrc.Title || '') + ' (複製)';
        e.Kyoka_Deadline = '';
        e.Houkoku_Deadline = '';
        e.Positives = '';
        e.Reflections = '';
        e.Files = [];
        e.CreatedAt = '';
        e.UpdatedAt = '';
        e.UpdatedBy = '';
        evWizardCategory = category || e.Category || 'normal';
        e.Category = evWizardCategory;
        toast('過去イベントを複製しました', 'info', 3000);
    } else {
        const newId = genId('ev_');
        const startDate = window.tempStart || todayISO();
        const endDate = window.tempEnd || '';
        window.tempStart = null;
        window.tempEnd = null;
        const titleMap = { normal: '', other: '', general: '', admin: '' };
        evWizardCategory = category || 'normal';
        const isMtg = evWizardCategory === 'general' || evWizardCategory === 'admin';
        const deadlines = isMtg ? { kyoka: '', houkoku: '' } : calculateDeadlines(startDate);
        e = {
            ID: newId, Date: startDate, Date_End: endDate,
            Title: titleMap[evWizardCategory] || '', Location: '', Audience: '',
            Meeting_Number: '', Category: evWizardCategory,
            Event_Time: '', Meeting_Logistics: '',
            PartsList: '', Accompany: '',
            Admin_Kyoka: '', Admin_Houkoku: '',
            Kyoka_Deadline: deadlines.kyoka, Houkoku_Deadline: deadlines.houkoku,
            Remarks: '', Belongings: '', Files: [],
            Gather_Time: '', Dismiss_Time: ''
        };
    }

    tempNewEvent = e;

    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const isAdmin = api.isAdmin();
    const catInfo = getEventCategory(evWizardCategory);

    const overlay = document.createElement('div');
    overlay.id = 'ev-wizard-overlay';
    overlay.className = 'wizard-overlay';
    overlay.onclick = (ev) => { if (ev.target === overlay) closeEventWizard(); };

    const timeStart = (e.Event_Time || '').split(' - ')[0]?.trim() || '13:00';
    const timeEnd = (e.Event_Time || '').split(' - ')[1]?.trim() || '16:00';

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
                    <label class="e1-label">ミーティング時間</label>
                    <div class="time-select-group">
                        <select class="e1-input" id="wz-ev-time-start">${genTimeOpts(9, 21, false)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="wz-ev-time-end">${genTimeOpts(9, 21, false)}</select>
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
                    <label class="e1-label">イベント時間</label>
                    <div class="time-select-group">
                        <select class="e1-input" id="wz-ev-time-start">${genTimeOpts(9, 21, false)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="wz-ev-time-end">${genTimeOpts(9, 21, false)}</select>
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
                    <div class="wizard-step-dot${i === 0 ? ' active' : ''}" data-dot="${i}" title="${s.label}">${i + 1}</div>
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
    tempNewEvent.Location = (document.getElementById('wz-ev-location')?.value || '').trim();
    tempNewEvent.Category = evWizardCategory;
    tempNewEvent.Date = document.getElementById('wz-ev-date')?.value || '';
    tempNewEvent.Date_End = document.getElementById('wz-ev-date-end')?.value || '';
    tempNewEvent.Remarks = (document.getElementById('wz-ev-remarks')?.value || '');

    const ts = document.getElementById('wz-ev-time-start')?.value || '';
    const te = document.getElementById('wz-ev-time-end')?.value || '';
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
                eventsData.splice(eventIndex, 0, restored);
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

function renderModalForm(eventData, isEditMode = true) {
    tempNewEvent = { ...eventData, Files: Array.isArray(eventData.Files) ? [...eventData.Files] : [] };
    const container = document.getElementById('new-event-form-container');
    container.innerHTML = ''; // clear

    const template = document.getElementById('event-template');
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.event-card');
    card.setAttribute('data-id', eventData.ID);

    // We only need the details section, not the accordion header
    const summary = card.querySelector('.event-summary');
    summary.style.display = 'none';

    const details = card.querySelector('.event-details');
    details.classList.remove('collapsed');

    // Populate and force Edit Mode
    populateFields(card, eventData);

    // Title input is missing in details (it was in summary). Add it dynamically.
    const detailsContainer = card.querySelector('.detail-section.top-section') || card.querySelector('.event-details');
    // If it's pure Event mode, inject the standard title at the top if it got removed, else it's in template. 
    // Wait, with the new template Title input is already there for both modes. So we don't need programmatic injection
    container.appendChild(card);

    if (isEditMode) {
        card.classList.add('editing');
        card.querySelectorAll('.display-mode').forEach(el => el.classList.add('hidden'));
        card.querySelectorAll('.edit-mode').forEach(el => el.classList.remove('hidden'));
    } else {
        card.classList.remove('editing');
        card.querySelectorAll('.display-mode').forEach(el => el.classList.remove('hidden'));
        card.querySelectorAll('.edit-mode').forEach(el => el.classList.add('hidden'));
    }
}


async function saveExperimentFeedback(card, eventData) {
    const fbCards = card.querySelectorAll('.exp-fb-card');
    if (!fbCards.length) return;

    let experiments = (api.loadCache('experiments') || {}).items;
    if (!experiments) {
        try { experiments = await api.list('experiments'); api.saveCache('experiments', experiments); } catch (_) { return; }
    }

    for (const fbCard of fbCards) {
        const expName = fbCard.dataset.expName;
        const posText = (fbCard.querySelector('.exp-fb-positive')?.value || '').trim();
        const refText = (fbCard.querySelector('.exp-fb-reflection')?.value || '').trim();
        if (!posText && !refText) continue;

        const exp = experiments.find(e => e.Name === expName);
        if (!exp) continue;

        let changed = false;

        if (posText) {
            const entries = parseFeedbackEntries(exp.Positives);
            entries.push({
                id: genFeedbackId(),
                date: eventData.Date || todayISO(),
                eventId: eventData.ID || '',
                eventTitle: eventData.Title || '',
                text: posText
            });
            exp.Positives = stringifyFeedbackEntries(entries);
            changed = true;
        }

        if (refText) {
            const entries = parseFeedbackEntries(exp.Reflections);
            entries.push({
                id: genFeedbackId(),
                date: eventData.Date || todayISO(),
                eventId: eventData.ID || '',
                eventTitle: eventData.Title || '',
                text: refText
            });
            exp.Reflections = stringifyFeedbackEntries(entries);
            changed = true;
        }

        if (changed) {
            try {
                const saved = await api.save('experiments', { ...exp, _baseUpdatedAt: exp.UpdatedAt || '' });
                const idx = experiments.findIndex(e => e.ID === exp.ID);
                if (idx >= 0) experiments[idx] = saved;
            } catch (e) {
                console.warn('Experiment feedback save failed for', expName, e);
            }
        }
    }

    api.saveCache('experiments', experiments);
}

async function processExperimentFeedbackBg(feedbackData, eventData) {
    let experiments = (api.loadCache('experiments') || {}).items;
    if (!experiments) {
        try { experiments = await api.list('experiments'); api.saveCache('experiments', experiments); } catch (_) { return; }
    }

    for (const fb of feedbackData) {
        const exp = experiments.find(e => e.Name === fb.expName);
        if (!exp) continue;

        let changed = false;

        if (fb.posText) {
            const entries = parseFeedbackEntries(exp.Positives);
            entries.push({
                id: genFeedbackId(),
                date: eventData.Date || todayISO(),
                eventId: eventData.ID || '',
                eventTitle: eventData.Title || '',
                text: fb.posText
            });
            exp.Positives = stringifyFeedbackEntries(entries);
            changed = true;
        }

        if (fb.refText) {
            const entries = parseFeedbackEntries(exp.Reflections);
            entries.push({
                id: genFeedbackId(),
                date: eventData.Date || todayISO(),
                eventId: eventData.ID || '',
                eventTitle: eventData.Title || '',
                text: fb.refText
            });
            exp.Reflections = stringifyFeedbackEntries(entries);
            changed = true;
        }

        if (changed) {
            try {
                const saved = await api.save('experiments', { ...exp, _baseUpdatedAt: exp.UpdatedAt || '' });
                const idx = experiments.findIndex(e => e.ID === exp.ID);
                if (idx >= 0) experiments[idx] = saved;
            } catch (e) {
                console.warn('Experiment feedback save failed for', fb.expName, e);
            }
        }
    }

    api.saveCache('experiments', experiments);
}

// ---- シリーズ過去振り返り表示 ----

function renderSeriesFeedback(cardElement, eventData) {
    const container = cardElement.querySelector('[data-field="SeriesFeedback"]');
    if (!container) return;

    const key = eventSeriesKey(eventData);
    if (!key) { container.classList.add('hidden'); return; }

    const series = eventsData
        .filter(x => eventSeriesKey(x) === key && x.ID !== eventData.ID && x.Date)
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));

    if (series.length === 0) { container.classList.add('hidden'); return; }

    const currentFy = getFiscalYear(todayISO());
    const grouped = {};
    series.forEach(ev => {
        const fy = getFiscalYear(ev.Date);
        const label = fy ? `${fy}年度` : '日付なし';
        if (!grouped[label]) grouped[label] = [];
        grouped[label].push(ev);
    });

    const fyKeys = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
    const seriesKeyEncoded = encodeURIComponent(key);

    let html = `<div class="sfb-header">
        <span class="sfb-title">過去の振り返り（通算${series.length + 1}回）</span>
        <a href="event-series.html?key=${escapeAttr(seriesKeyEncoded)}" class="sfb-link">シリーズ全履歴を見る &rarr;</a>
    </div>`;

    html += fyKeys.map((fy, fyIdx) => {
        const events = grouped[fy];
        const isRecent = fyIdx < 2;

        return events.map(ev => {
            const expList = parsePartsList(ev.PartsList);
            const expNames = expList.map(it => it.name).filter(Boolean);
            const pos = (ev.Positives || '').trim();
            const ref = (ev.Reflections || '').trim();
            const hasFeedback = pos || ref;

            return `<div class="sfb-year-group">
                <div class="sfb-year-header ${isRecent ? 'open' : ''}" onclick="this.classList.toggle('open'); this.nextElementSibling.classList.toggle('hidden');">
                    <span class="sfb-toggle">${isRecent ? '&#9660;' : '&#9654;'}</span>
                    <span class="sfb-year-label">${escapeHtml(fy)}</span>
                    <span class="sfb-event-date">${escapeHtml(ev.Date)} (${dayOfWeekJP(ev.Date)})</span>
                    ${!hasFeedback ? '<span class="sfb-no-fb">振り返りなし</span>' : ''}
                </div>
                <div class="sfb-year-body ${isRecent ? '' : 'hidden'}">
                    <div class="sfb-meta">
                        ${ev.Location ? `<span>場所: ${escapeHtml(ev.Location)}</span>` : ''}
                        ${ev.Audience ? `<span>対象: ${escapeHtml(ev.Audience)}</span>` : ''}
                        ${expNames.length > 0 ? `<span>実験: ${expNames.map(n => escapeHtml(n)).join(', ')}</span>` : ''}
                    </div>
                    ${pos ? `<div class="sfb-entry sfb-positive"><span class="sfb-icon">&#9675;</span><span class="sfb-label">良かった点</span><span class="sfb-text">${escapeHtml(pos)}</span></div>` : ''}
                    ${ref ? `<div class="sfb-entry sfb-reflection"><span class="sfb-icon">&#9651;</span><span class="sfb-label">改善点</span><span class="sfb-text">${escapeHtml(ref)}</span></div>` : ''}
                    ${!hasFeedback ? '<p class="sfb-empty">この年度の振り返りは未記入です</p>' : ''}
                    <a href="events.html?event=${encodeURIComponent(ev.ID)}&tab=feedback" class="sfb-detail-link" onclick="event.stopPropagation();">このイベントの詳細 &rarr;</a>
                </div>
            </div>`;
        }).join('');
    }).join('');

    container.innerHTML = html;
    container.classList.remove('hidden');
}

// ---- タブ切り替え ----

function switchEventTab(btn) {
    const card = btn.closest('.event-card') || document.querySelector('#new-event-form-container .event-card');
    if (!card) return;
    card.querySelectorAll('.event-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    card.querySelectorAll('.event-tab-pane').forEach(p => {
        p.classList.toggle('hidden', p.dataset.tabPane !== target);
    });
}

async function saveFeedbackFromTab() {
    if (!tempNewEvent) return;
    const container = document.getElementById('new-event-form-container');
    const card = container.querySelector('.event-card');
    const eventIndex = eventsData.findIndex(e => e.ID === tempNewEvent.ID);
    if (eventIndex < 0) { toast('イベントが見つかりません', 'error'); return; }

    const positives = card.querySelector('.fb-tab-positives')?.value || '';
    const reflections = card.querySelector('.fb-tab-reflections')?.value || '';

    const updated = { ...eventsData[eventIndex] };
    updated.Positives = positives;
    updated.Reflections = reflections;

    const gasItem = uiToGas(updated);
    gasItem._baseUpdatedAt = updated.UpdatedAt || '';

    try {
        const savedGas = await api.save('events', gasItem);
        const savedEvent = gasToUi(savedGas);
        eventsData[eventIndex] = savedEvent;
        tempNewEvent = { ...savedEvent, Files: Array.isArray(savedEvent.Files) ? [...savedEvent.Files] : [] };
        api.saveCache('events', eventsData);

        await saveExperimentFeedback(card, savedEvent);

        toast('振り返りを保存しました', 'success');
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人が編集しました。最新を読み込みます。', 'error', 5000);
            closeModal();
            await refreshData();
            return;
        }
        toast('保存失敗: ' + e.message, 'error');
    }
}

// 日付変更時に期限表示を即時更新する（期限は自動計算のみ・表示専用スパン）。
// 実際の保存値は saveEventFromWizard で確定する。
function updateDeadlines(dateInput) {
    const card = dateInput.closest('.event-card');
    const newDate = dateInput.value;
    if (!newDate) return;

    const cat = (tempNewEvent && tempNewEvent.Category) || 'normal';
    const isMeeting = cat === 'general' || cat === 'admin';
    const calculations = isMeeting ? { kyoka: '', houkoku: '' } : calculateDeadlines(newDate);

    // Wizard context
    const wzKyoka = document.getElementById('wz-ev-kyoka-dl');
    const wzHoukoku = document.getElementById('wz-ev-houkoku-dl');
    if (wzKyoka) wzKyoka.textContent = calculations.kyoka;
    if (wzHoukoku) wzHoukoku.textContent = calculations.houkoku;

    // Modal context
    if (card) {
        const kyokaDisplay = card.querySelector('[data-field="Kyoka_Deadline"]');
        const houkokuDisplay = card.querySelector('[data-field="Houkoku_Deadline"]');
        if (kyokaDisplay) kyokaDisplay.textContent = calculations.kyoka;
        if (houkokuDisplay) houkokuDisplay.textContent = calculations.houkoku;
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

// ---- Phase 2: ファイルアップロード (Google Drive) ----

function allowDrop(ev) {
    ev.preventDefault();
}

function handleDrop(ev) {
    ev.preventDefault();
    ev.currentTarget.classList.remove('dragover');

    const files = [];
    if (ev.dataTransfer.items) {
        [...ev.dataTransfer.items].forEach(item => {
            if (item.kind === 'file') files.push(item.getAsFile());
        });
    } else if (ev.dataTransfer.files) {
        files.push(...ev.dataTransfer.files);
    }
    if (files.length > 0) uploadFiles(files);
}

function handleFileSelect(input) {
    const files = Array.from(input.files);
    if (files.length > 0) uploadFiles(files);
    input.value = '';
}

async function uploadFiles(fileList) {
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
        refreshEditFileList();

        try {
            const result = await api.uploadFile(file);
            const idx = tempNewEvent.Files.indexOf(placeholder);
            if (idx >= 0) {
                tempNewEvent.Files[idx] = result;
            } else {
                tempNewEvent.Files.push(result);
            }
            toast(`「${file.name}」をアップロードしました`, 'success', 2000);
        } catch (e) {
            toast(`「${file.name}」のアップロード失敗: ${e.message}`, 'error');
            const idx = tempNewEvent.Files.indexOf(placeholder);
            if (idx >= 0) {
                tempNewEvent.Files[idx] = { name: file.name, size: file.size, _failed: true };
            }
        }
        refreshEditFileList();
    }
}

function removeFile(index) {
    if (!tempNewEvent || !Array.isArray(tempNewEvent.Files)) return;
    const file = tempNewEvent.Files[index];
    if (!file) return;

    if (file.driveId) {
        if (!Array.isArray(tempNewEvent._filesToDelete)) tempNewEvent._filesToDelete = [];
        tempNewEvent._filesToDelete.push(file.driveId);
    }
    tempNewEvent.Files.splice(index, 1);
    refreshEditFileList();
}

function refreshEditFileList() {
    const card = document.querySelector('#new-event-form-container .event-card');
    if (!card || !tempNewEvent) return;
    const el = card.querySelector('.file-list-edit');
    if (el) renderEditFileList(el, tempNewEvent.Files);
}

function renderEditFileList(container, files) {
    if (!files || files.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = files.map((f, i) => {
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
                    ${!uploading ? `<button class="tbl-btn tbl-btn-danger" onclick="removeFile(${i})" type="button">削除</button>` : ''}
                    ${uploading ? `<button class="tbl-btn tbl-btn-danger" onclick="removeFile(${i})" type="button">キャンセル</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}
