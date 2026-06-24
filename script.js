// イベントデータ（GASから取得してここに保持）
let eventsData = [];

let holidaysData = {};

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
        UpdatedBy: u.UpdatedBy || '',
        CreatedAt: u.CreatedAt || ''  // 既存の作成日時を保持（更新・UNDO再作成で消さない）
    };
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

// ---- 起動 ----
document.addEventListener('DOMContentLoaded', () => {
    bootPage('events', init);
});

async function init() {
    holidaysData = await api.loadHolidaysCached();

    // キャッシュ即表示
    const cached = api.loadCache('events');
    if (cached && cached.items && cached.items.length > 0) {
        eventsData = cached.items;
    }

    populateDatalists();
    renderEvents();

    if (cached) updateSyncStatus('cached', cached.timestamp);
    else updateSyncStatus('initial-loading');

    refreshData();
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
        memberDl.innerHTML = members
            .filter(m => m.Active !== 'false' && m.Name)
            .map(m => `<option value="${escapeAttr(m.Name)}">${escapeAttr(m.Role || getMemberCategory(m.Category).label)}</option>`)
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
        if (calendarVisible) refreshCalendar();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (String(e).includes('unauthorized')) {
            api.clearToken();
            api.clearAllCache();
            location.reload();
            return;
        }
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

            // Open modal with pre-filled dates
            document.getElementById('category-selection-modal').classList.remove('hidden');
            document.getElementById('new-event-edit-modal').classList.add('hidden');
            document.getElementById('modal-overlay').classList.remove('hidden');

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

    document.getElementById('modal-overlay').classList.remove('hidden');
    const catModal = document.getElementById('category-selection-modal');
    if (catModal) catModal.classList.add('hidden');
    document.getElementById('new-event-edit-modal').classList.remove('hidden');

    const headerTitle = document.querySelector('#new-event-edit-modal h2');
    if (headerTitle) headerTitle.textContent = "イベント詳細";

    const actionButtons = document.getElementById('modal-action-buttons');
    if (actionButtons) {
        actionButtons.innerHTML = `
            <button class="btn btn-text" onclick="closeModal()">閉じる</button>
            <button class="btn btn-secondary display-mode-btn" onclick="enableModalEdit()">編集</button>
            <button class="btn btn-danger hidden edit-mode-btn${api.isAdmin() ? '' : ' admin-hidden'}" onclick="deleteModalEvent()">削除</button>
            <button class="btn btn-primary hidden edit-mode-btn" onclick="saveEventFromModal()">保存</button>
            <button class="btn btn-text hidden edit-mode-btn" onclick="cancelModalEdit('${id}')">キャンセル</button>
        `;
    }

    renderModalForm(eventData, false);

    // Show tab bar for existing events
    const container = document.getElementById('new-event-form-container');
    const tabBar = container.querySelector('.event-tab-bar');
    if (tabBar) tabBar.classList.remove('hidden');
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

    tbody.innerHTML = sorted.map(event => {
        const cat = getEventCategory(event.Category);
        let displayTitle = event.Title || '(無題)';
        if (cat.isMeeting && event.Meeting_Number) {
            displayTitle = `第${event.Meeting_Number}回 ${displayTitle}`;
        }
        const occ = occurrenceInfo(event);
        return `
            <tr class="clickable-row" onclick="viewEventInModal('${event.ID}')">
                <td class="cell-name" style="white-space:nowrap;">
                    ${escapeHtml(event.Date || '')} <span style="color:#888;">(${dayOfWeekJP(event.Date)})</span>
                    ${event.Date_End && event.Date_End !== event.Date ? '<br><span style="color:#888;font-size:0.8rem;">〜 ' + escapeHtml(event.Date_End) + '</span>' : ''}
                </td>
                <td>
                    <span style="font-weight:600;">${escapeHtml(displayTitle)}</span>
                    <span class="cat-badge" style="background:${cat.bg};color:${cat.text};margin-left:6px;">${cat.short}</span>
                    ${occ ? `<span class="occ-badge" title="通算${occ.total}回">${occ.num}回目</span>` : ''}
                </td>
                <td class="hide-mobile">${escapeHtml(event.Location || '')}</td>
                <td class="hide-mobile">${escapeHtml(event.Event_Time || '')}</td>
                <td class="cell-actions" onclick="event.stopPropagation()">
                    <button class="tbl-btn" onclick="viewEventInModal('${event.ID}')">詳細</button>
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
            const b = document.createElement('span');
            b.className = 'occ-badge';
            b.textContent = `${occ.num}回目 / 通算${occ.total}回`;
            dateDisplayEl.appendChild(b);
        }
    }

    // Special Date Inputs
    ['Date', 'Date_End'].forEach(df => {
        cardElement.querySelectorAll(`.edit-mode[data-field="${df}"]`).forEach(el => {
            el.value = eventData[df] || '';
        });
    });

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
        initTagInput(container, vals, '担当者を検索...');
    });

    // Title mapping overrides for Meeting Mode
    const titleDisplay = cardElement.querySelector('.display-mode[data-field="Title_Display"]');
    if (titleDisplay) {
        if (isMeeting) {
            titleDisplay.innerHTML = `<span style="font-size: 1.25rem; font-weight: bold; color: #464775;">回数：[ ${eventData.Meeting_Number || '?'} ] [ ${eventData.Title || ''} ]</span>`;
        } else {
            titleDisplay.innerHTML = `<span style="font-size: 1.25rem; font-weight: bold; color: #464775;">${eventData.Title || ''}</span>`;
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
            expFbTab.innerHTML = '<p style="color:#999; font-size:0.85rem;">実験が登録されていないため、実験の振り返りは入力できません。</p>';
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
                return `<span class="file-link" style="color:#999;">${name} (リンク切れ)</span>`;
            }).join('');
        } else {
            fileContainer.innerHTML = '<span style="color:#999;font-size:0.9rem;">なし</span>';
        }
    }

    if (fileListEdit) {
        renderEditFileList(fileListEdit, files);
    }
}

// ※ インラインカードの編集/削除/アコーディオン機能は廃止。
//   イベントの閲覧・編集・削除はすべてモーダル経由で行う:
//     表示  → viewEventInModal()
//     編集  → enableModalEdit()
//     保存  → saveEventFromModal()
//     削除  → deleteModalEvent()

// ---- タグ入力コンポーネント（検索可能な複数選択） ----

function getActiveMembers() {
    const cached = (api.loadCache('members') || {}).items || [];
    return cached.filter(m => m.Active !== 'false' && m.Name);
}

function initTagInput(container, selectedValues, placeholder) {
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
        const members = getActiveMembers();
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
                `<div class="tag-input-option" data-value="${escapeAttr(m.Name)}">${escapeHtml(m.Name)}${m.Furigana ? ' <span style="color:#999;font-size:0.8em;">(' + escapeHtml(m.Furigana) + ')</span>' : ''}</div>`
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
    initTagInput(row.querySelector('.presenter-tag-container'), presenters || [], '発表者を検索...');
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
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('category-selection-modal').classList.remove('hidden');
    document.getElementById('new-event-edit-modal').classList.add('hidden');
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
}

function startNewEvent(category, template) {
    // Hide category selection, show edit form
    document.getElementById('category-selection-modal').classList.add('hidden');
    document.getElementById('new-event-edit-modal').classList.remove('hidden');

    const newId = genId("ev_");
    const today = todayISO(); // ローカル日付（UTC変換による日付ズレを防ぐ）

    const startDate = window.tempStart || today;
    const endDate = window.tempEnd || "";
    window.tempStart = null;
    window.tempEnd = null;

    const titleMap = {
        'normal': '新規通常イベント',
        'other': '新規学内イベント',
        'general': '全体ミーティング',
        'admin': '幹部ミーティング'
    };

    let newEvent;
    if (template) {
        // 過去イベントから複製（日付・IDだけリセット）
        newEvent = { ...template };
        newEvent.ID = newId;
        newEvent.Date = startDate;
        newEvent.Date_End = endDate;
        newEvent.Title = (template.Title || '') + ' (複製)';
        newEvent.Kyoka_Deadline = '';
        newEvent.Houkoku_Deadline = '';
        toast('過去イベントを複製しました。日付などを編集してください', 'info', 4000);
    } else {
        newEvent = {
            ID: newId,
            Date: startDate,
            Date_End: endDate,
            Title: titleMap[category],
            Location: "", Meeting_Number: "", Category: category,
            Event_Time: "", Meeting_Logistics: "",
            Experiments: "", Presenters: "",
            Admin_Kyoka: "", Admin_Houkoku: "",
            Kyoka_Deadline: "", Houkoku_Deadline: "",
            Remarks: "", Belongings: "", Files: []
        };
    }

    // Auto calc initial deadlines（ミーティングには書類期限は無い）
    const isMeetingCat = category === 'general' || category === 'admin';
    if (isMeetingCat) {
        newEvent.Kyoka_Deadline = '';
        newEvent.Houkoku_Deadline = '';
    } else {
        const dHands = calculateDeadlines(startDate);
        newEvent.Kyoka_Deadline = dHands.kyoka;
        newEvent.Houkoku_Deadline = dHands.houkoku;
    }

    const headerTitle = document.querySelector('#new-event-edit-modal h2');
    if (headerTitle) headerTitle.textContent = "新規イベント作成";

    const actionButtons = document.getElementById('modal-action-buttons');
    if (actionButtons) {
        actionButtons.innerHTML = `
            <button class="btn btn-text" onclick="closeModal()">キャンセル</button>
            <button class="btn btn-primary" onclick="saveEventFromModal()">保存</button>
        `;
    }

    // We don't push to eventsData yet. We keep it temporary until "Save".
    // Render the form inside the modal using the template, force edit mode
    renderModalForm(newEvent, true);

    // Hide tab bar and feedback tab for new events
    const container = document.getElementById('new-event-form-container');
    const tabBar = container.querySelector('.event-tab-bar');
    if (tabBar) tabBar.classList.add('hidden');
    const fbPane = container.querySelector('[data-tab-pane="feedback"]');
    if (fbPane) fbPane.classList.add('hidden');
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

function enableModalEdit() {
    const card = document.getElementById('new-event-form-container').querySelector('.event-card');
    card.classList.add('editing');
    card.querySelectorAll('.display-mode').forEach(el => el.classList.add('hidden'));
    card.querySelectorAll('.edit-mode').forEach(el => el.classList.remove('hidden'));

    document.querySelectorAll('.display-mode-btn').forEach(b => b.classList.add('hidden'));
    document.querySelectorAll('.edit-mode-btn').forEach(b => b.classList.remove('hidden'));
}

function cancelModalEdit(originalId) {
    viewEventInModal(originalId); // reset view to original state
}

async function deleteModalEvent() {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => deleteModalEvent());
        return;
    }
    const id = tempNewEvent.ID;
    const eventIndex = eventsData.findIndex(e => e.ID === id);
    if (eventIndex < 0) return;
    const backup = eventsData[eventIndex];

    // UIから即削除（楽観的表示）
    eventsData.splice(eventIndex, 1);
    api.saveCache('events', eventsData);
    renderEvents();
    if (calendarVisible) refreshCalendar();
    closeModal();

    // サーバー削除を即時実行する（5秒待たないのでページ離脱でも確実に削除される）
    try {
        await api.delete('events', id);
    } catch (e) {
        // 失敗したら元に戻す
        eventsData.splice(eventIndex, 0, backup);
        api.saveCache('events', eventsData);
        renderEvents();
        if (calendarVisible) refreshCalendar();
        toast('削除失敗: ' + e.message, 'error');
        return;
    }

    // 削除確定後、UNDO（同一IDで再作成）を提示
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
            } catch (e) {
                toast('復元に失敗しました: ' + e.message, 'error');
            }
        },
        () => {},   // 確定処理は不要（既にサーバー削除済み）
        5000
    );
}

async function saveEventFromModal() {
    const eventIndex = eventsData.findIndex(e => e.ID === tempNewEvent.ID);
    const container = document.getElementById('new-event-form-container');
    const card = container.querySelector('.event-card');

    // Collect data from inputs（動的行の input は data-field を持たないので下のフィルタで自然に除外される）
    const inputs = card.querySelectorAll('.edit-mode');

    inputs.forEach(input => {
        const field = input.getAttribute('data-field');
        if (field && field !== 'Files') {
            tempNewEvent[field] = input.value;
        }
    });

    // Collect time from explicit selects
    const startSel = card.querySelector('.time-start-select');
    const endSel = card.querySelector('.time-end-select');
    if (startSel && endSel) {
        tempNewEvent.Event_Time = `${startSel.value} - ${endSel.value}`;
    }

    // Special meeting title handling
    if (tempNewEvent.Category === 'admin' || tempNewEvent.Category === 'general') {
        const metNum = card.querySelector('#meeting-num-input');
        const metName = card.querySelector('#meeting-name-input');
        if (metNum) tempNewEvent.Meeting_Number = metNum.value;
        if (metName) tempNewEvent.Title = metName.value;
    }

    // Collect experiments (flat format)
    const expContainer = card.querySelector('.experiments-container');
    if (expContainer) {
        const rows = expContainer.querySelectorAll('.experiment-row');
        const collectedExps = [];
        rows.forEach(row => {
            const name = (row.querySelector('.experiment-name')?.value || '').trim();
            const tagContainer = row.querySelector('.presenter-tag-container');
            const presenters = tagContainer?._tagInput ? tagContainer._tagInput.getValues() : [];
            if (name || presenters.length > 0) {
                collectedExps.push({ name, presenters });
            }
        });
        tempNewEvent.PartsList = JSON.stringify(collectedExps);
    }

    // Collect admin tag inputs
    card.querySelectorAll('.admin-tag-container').forEach(container => {
        const field = container.dataset.adminField;
        if (field && container._tagInput) {
            tempNewEvent[field] = container._tagInput.getValues().join(', ');
        }
    });

    // Recalculate deadlines explicitly（ミーティングには書類期限を付けない）
    if (tempNewEvent.Category === 'general' || tempNewEvent.Category === 'admin') {
        tempNewEvent.Kyoka_Deadline = '';
        tempNewEvent.Houkoku_Deadline = '';
    } else {
        const deadLines = calculateDeadlines(tempNewEvent.Date);
        tempNewEvent.Kyoka_Deadline = deadLines.kyoka;
        tempNewEvent.Houkoku_Deadline = deadLines.houkoku;
    }

    // GASに保存（編集時は競合検知用に読み込み時の版を添える）
    const gasItem = uiToGas(tempNewEvent);
    if (eventIndex > -1) gasItem._baseUpdatedAt = tempNewEvent.UpdatedAt || '';
    let savedEvent;
    try {
        const savedGas = await api.save('events', gasItem);
        savedEvent = gasToUi(savedGas);
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新の内容を読み込みます。', 'error', 5000);
            closeModal();
            tempNewEvent = null;
            await refreshData();
            return;
        }
        toast('保存失敗: ' + e.message, 'error');
        return;
    }

    if (eventIndex > -1) {
        eventsData[eventIndex] = savedEvent;
    } else {
        eventsData.unshift(savedEvent);
    }
    api.saveCache('events', eventsData);

    renderEvents();
    refreshCalendar();

    // Save experiment feedback (if any)
    await saveExperimentFeedback(card, savedEvent);

    closeModal();
    tempNewEvent = null;
    toast('保存しました', 'success');
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
// 実際の保存値は saveEventFromModal で確定する。
function updateDeadlines(dateInput) {
    const card = dateInput.closest('.event-card');
    const newDate = dateInput.value;
    if (!newDate) return;

    // カテゴリがミーティングなら期限は無し
    const cat = (tempNewEvent && tempNewEvent.Category) || 'normal';
    const isMeeting = cat === 'general' || cat === 'admin';
    const calculations = isMeeting ? { kyoka: '', houkoku: '' } : calculateDeadlines(newDate);

    const kyokaDisplay = card.querySelector('[data-field="Kyoka_Deadline"]');
    const houkokuDisplay = card.querySelector('[data-field="Houkoku_Deadline"]');
    if (kyokaDisplay) kyokaDisplay.textContent = calculations.kyoka;
    if (houkokuDisplay) houkokuDisplay.textContent = calculations.houkoku;
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

        tempNewEvent.Files.push({ name: file.name, size: file.size, _uploading: true });
        refreshEditFileList();

        try {
            const result = await api.uploadFile(file);
            const idx = tempNewEvent.Files.findIndex(f => f._uploading && f.name === file.name);
            if (idx >= 0) {
                tempNewEvent.Files[idx] = result;
            } else {
                tempNewEvent.Files.push(result);
            }
            toast(`「${file.name}」をアップロードしました`, 'success', 2000);
        } catch (e) {
            toast(`「${file.name}」のアップロード失敗: ${e.message}`, 'error');
            const idx = tempNewEvent.Files.findIndex(f => f._uploading && f.name === file.name);
            if (idx >= 0) tempNewEvent.Files.splice(idx, 1);
        }
        refreshEditFileList();
    }
}

async function removeFile(index) {
    if (!tempNewEvent || !Array.isArray(tempNewEvent.Files)) return;
    const file = tempNewEvent.Files[index];
    if (!file) return;

    if (file.driveId) {
        if (!api.isAdmin()) {
            showAdminAuthModal(() => removeFile(index));
            return;
        }
        try {
            await api.deleteFile(file.driveId);
        } catch (e) {
            if (e.message === 'ADMIN_REQUIRED') {
                showAdminAuthModal(() => removeFile(index));
                return;
            }
            console.warn('Drive file deletion failed:', e);
            toast('Driveファイルの削除に失敗しました（参照のみ解除します）', 'error', 4000);
        }
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
        return `
            <div class="file-item${uploading ? ' uploading' : ''}" data-index="${i}">
                <span class="file-name">${name}${uploading ? ' (アップロード中...)' : ''}</span>
                <span class="file-size">${size}</span>
                <div class="file-actions">
                    ${!uploading && f.url ? `<a href="${escapeAttr(f.url)}" target="_blank" rel="noopener" class="tbl-btn">開く</a>` : ''}
                    ${!uploading ? `<button class="tbl-btn tbl-btn-danger" onclick="removeFile(${i})" type="button">削除</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}
