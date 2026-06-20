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
    u.Files = Array.isArray(g.Files) ? g.Files.map(f => f.url || f).join(',') : (g.Files || '');
    return u;
}

function uiToGas(u) {
    const time = (u.Event_Time || '').split(' - ');
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
        PartsList: u.PartsList ? (typeof u.PartsList === 'string' ? JSON.parse(u.PartsList) : u.PartsList) : [],
        AdminKyoka: u.Admin_Kyoka || '',
        AdminHoukoku: u.Admin_Houkoku || '',
        KyokaDeadline: u.Kyoka_Deadline || '',
        HoukokuDeadline: u.Houkoku_Deadline || '',
        Logistics: u.Meeting_Logistics || '',
        Remarks: u.Remarks || '',
        Belongings: u.Belongings || '',
        Files: (u.Files || '').split(',').filter(s => s.trim()).map(url => ({ name: '', url: url.trim() })),
        UpdatedBy: u.UpdatedBy || ''
    };
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

    // 担当者・実験名の候補をキャッシュから即構築（A1/A3）
    populateDatalists();

    if (document.getElementById('calendar-grid')) {
        initCalendar();
    } else if (document.getElementById('calendar')) {
        initFullCalendar();
    }
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
        refreshCalendar();
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
    refreshCalendar();
}
function onPeriodFilter(period) {
    filterState.period = period;
    document.querySelectorAll('.filter-chip[data-period]').forEach(c => c.classList.toggle('active', c.dataset.period === period));
    renderEvents();
}
function applyFilters(events) {
    const today = formatDate(new Date());
    return events.filter(e => {
        // カテゴリ
        if (filterState.category !== 'all' && (e.Category || 'normal') !== filterState.category) return false;
        // 期間
        const endDate = e.Date_End || e.Date;
        if (filterState.period === 'upcoming' && endDate < today) return false;
        if (filterState.period === 'past' && e.Date >= today) return false;
        // キーワード
        if (filterState.keyword) {
            const haystack = [e.Title, e.Location, e.Audience, e.Remarks, e.Experiments, e.Presenters, e.Admin_Kyoka, e.Admin_Houkoku]
                .filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(filterState.keyword)) return false;
        }
        return true;
    });
}

function refreshCalendar() {
    if (document.getElementById('calendar-grid')) {
        renderCalendar(currentMonth);
    } else if (window.globalCalendar) {
        // FullCalendar
        window.globalCalendar.refetchEvents();
    }
}

function initFullCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;
    // FullCalendarがまだ読み込み完了していなければリトライ
    if (typeof FullCalendar === 'undefined') {
        setTimeout(initFullCalendar, 50);
        return;
    }
    // スケルトンを非表示にしてカレンダー表示
    const skeleton = document.getElementById('calendar-skeleton');
    if (skeleton) skeleton.style.display = 'none';
    calendarEl.style.display = '';

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
            const endObj = new Date(info.endStr);
            endObj.setDate(endObj.getDate() - 1);
            const endDateStr = endObj.toISOString().split('T')[0];

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
                ev.Event_Time && '⏰ ' + ev.Event_Time,
                ev.Location && '📍 ' + ev.Location,
                ev.Audience && '👥 ' + ev.Audience
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
            // Sync with current month
            const currentDate = calendar.getDate();
            jumpInput.value = currentDate.toISOString().slice(0, 7);

            jumpInput.addEventListener('change', (e) => {
                if (e.target.value) {
                    calendar.gotoDate(e.target.value + '-01');
                }
            });

            // Keep input synced when navigating with prev/next
            calendar.on('datesSet', (info) => {
                jumpInput.value = info.start.toISOString().slice(0, 7);
            });
        }
    }
}

// --- Calendar Logic ---
let currentMonth = new Date();

function initCalendar() {
    const yPicker = document.getElementById('calendar-year');
    const mPicker = document.getElementById('calendar-month');

    // populate years (e.g., -2 to +3)
    const currentY = new Date().getFullYear();
    for (let i = currentY - 2; i <= currentY + 3; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = i;
        yPicker.appendChild(opt);
    }

    // populate months
    for (let i = 1; i <= 12; i++) {
        const opt = document.createElement('option');
        opt.value = i - 1; // 0-indexed
        opt.textContent = i;
        mPicker.appendChild(opt);
    }

    renderCalendar(currentMonth);
}

function renderCalendar(date) {
    const year = date.getFullYear();
    const month = date.getMonth();

    document.getElementById('calendar-year').value = year;
    document.getElementById('calendar-month').value = month;

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // Start from the Sunday before the 1st
    const startDate = new Date(firstDay);
    startDate.setDate(firstDay.getDate() - firstDay.getDay());

    // End on the Saturday after the last day
    const endDate = new Date(lastDay);
    endDate.setDate(lastDay.getDate() + (6 - lastDay.getDay()));

    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';

    let loopDate = new Date(startDate);
    while (loopDate <= endDate) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        if (loopDate.getMonth() !== month) {
            cell.classList.add('other-month');
        }

        const dateStrCurrent = formatDate(loopDate);
        if (holidaysData[dateStrCurrent]) {
            cell.classList.add('holiday');
            cell.title = holidaysData[dateStrCurrent];
        }

        // Click on cell to start new event
        cell.onclick = () => {
            window.tempStart = dateStrCurrent;
            window.tempEnd = ""; // Custom calendar only selects 1 day for now
            openNewEventModal();
        };

        // Check for "today"
        const today = new Date();
        if (loopDate.toDateString() === today.toDateString()) {
            cell.classList.add('today');
        }

        // Date Number
        const dayNum = document.createElement('span');
        dayNum.className = 'day-number';
        dayNum.textContent = loopDate.getDate();
        cell.appendChild(dayNum);

        // Find events for this day traversing Date_End
        const dateStr = formatDate(loopDate);
        const dayEvents = eventsData.filter(e => {
            if (!e.Date_End || e.Date_End === e.Date) {
                return e.Date === dateStr;
            }
            return dateStr >= e.Date && dateStr <= e.Date_End;
        });

        dayEvents.forEach(ev => {
            const evChip = document.createElement('div');
            evChip.className = `cal-event cat-${ev.Category || 'normal'}`;

            let displayTitle = ev.Title;
            if ((ev.Category === 'admin' || ev.Category === 'general') && ev.Meeting_Number) {
                displayTitle = `第${ev.Meeting_Number}回 ${ev.Title}`;
            }
            evChip.textContent = displayTitle;

            evChip.title = displayTitle; // Tooltip
            evChip.onclick = (e) => {
                e.stopPropagation();
                viewEventInModal(ev.ID);
            };
            cell.appendChild(evChip);
        });

        grid.appendChild(cell);

        // Next day
        loopDate.setDate(loopDate.getDate() + 1);
    }
}

function prevMonth() {
    currentMonth.setMonth(currentMonth.getMonth() - 1);
    renderCalendar(currentMonth);
}

function nextMonth() {
    currentMonth.setMonth(currentMonth.getMonth() + 1);
    renderCalendar(currentMonth);
}

function jumpToMonthSelect() {
    const y = parseInt(document.getElementById('calendar-year').value);
    const m = parseInt(document.getElementById('calendar-month').value);
    currentMonth = new Date(y, m, 1);
    renderCalendar(currentMonth);
}

function viewEventInModal(id) {
    const eventData = eventsData.find(e => e.ID === id);
    if (!eventData) return;

    document.getElementById('modal-overlay').classList.remove('hidden');
    const catModal = document.getElementById('category-selection-modal');
    if (catModal) catModal.classList.add('hidden');
    document.getElementById('new-event-edit-modal').classList.remove('hidden');

    const headerTitle = document.querySelector('#new-event-edit-modal h2');
    if (headerTitle) headerTitle.textContent = "📝 イベント詳細";

    const actionButtons = document.getElementById('modal-action-buttons');
    if (actionButtons) {
        actionButtons.innerHTML = `
            <button class="btn btn-text" onclick="closeModal()">閉じる</button>
            <button class="btn btn-secondary display-mode-btn" onclick="enableModalEdit()">✏️ 編集</button>
            <button class="btn btn-danger hidden edit-mode-btn" onclick="deleteModalEvent()">🗑️ 削除</button>
            <button class="btn btn-primary hidden edit-mode-btn" onclick="saveEventFromModal()">💾 保存</button>
            <button class="btn btn-text hidden edit-mode-btn" onclick="cancelModalEdit('${id}')">キャンセル</button>
        `;
    }

    renderModalForm(eventData, false);
}

// Render all events
function renderEvents() {
    const listContainer = document.getElementById('event-list');
    const template = document.getElementById('event-template');

    listContainer.innerHTML = ''; // Clear current

    // フィルタ＆ソート（今後＝昇順、過去＝降順、全部＝昇順）
    const filtered = applyFilters(eventsData);
    const sorted = filtered.slice().sort((a, b) => {
        if (filterState.period === 'past') return (b.Date || '').localeCompare(a.Date || '');
        return (a.Date || '').localeCompare(b.Date || '');
    });

    const heading = document.createElement('h3');
    heading.style.marginBottom = '1rem';
    const periodLabel = { upcoming: '🌟 今後のイベント', past: '📜 過去のイベント', all: '📋 全てのイベント' };
    heading.textContent = `${periodLabel[filterState.period]} (${sorted.length}件)`;
    listContainer.appendChild(heading);

    if (sorted.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<div class="empty-icon">📭</div>該当するイベントはありません';
        listContainer.appendChild(empty);
        return;
    }

    sorted.forEach(event => {
        const clone = template.content.cloneNode(true);
        const card = clone.querySelector('.event-card');
        card.setAttribute('data-id', event.ID);

        // Populate Summary
        clone.querySelector('.event-date-badge').textContent = `${event.Date} (${dayOfWeekJP(event.Date)})`;

        // Display Time instead of Target
        const timeDisplay = clone.querySelector('.event-time-display');
        if (timeDisplay) timeDisplay.textContent = event.Event_Time || '--:--';

        let displayTitle = event.Title;
        if ((event.Category === 'admin' || event.Category === 'general') && event.Meeting_Number) {
            displayTitle = `第${event.Meeting_Number}回 ${event.Title}`;
        }
        clone.querySelector('.event-title').textContent = displayTitle;

        // Populate Fields
        populateFields(card, event);

        // Make whole summary clickable to view modal
        const summary = clone.querySelector('.event-summary');
        if (summary) {
            summary.onclick = (e) => {
                e.stopPropagation();
                viewEventInModal(event.ID);
            };
        }

        listContainer.appendChild(clone);
    });
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
        remarksLabel.textContent = isMeeting ? '📝 議題 / 備考' : '📝 備考';
    }

    const fields = ['Title', 'Location', 'Audience', 'Meeting_Number', 'Date', 'Date_End', 'Event_Time', 'Meeting_Logistics', 'Remarks', 'Belongings'];

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

    // Dynamic List for Experiments & Presenters (Parts Based)
    const expDisplay = cardElement.querySelector('.display-mode[data-field="Experiments_Display"]');
    const partsContainer = cardElement.querySelector('.parts-container');

    // Data parsing assumption: JSON string of parts or simple string
    // For now we map legacy "Experiments" to "一部"
    let partsData = [];
    try {
        if (eventData.PartsList) {
            partsData = JSON.parse(eventData.PartsList);
        } else if (eventData.Experiments) {
            // Legacy fallack
            const expArray = eventData.Experiments.split(',');
            const preArray = (eventData.Presenters || "").split(',');
            const exps = expArray.map((e, i) => ({ name: e.trim(), presenter: (preArray[i] || '').trim() }));
            partsData = [{ partName: "一部", items: exps }];
        } else {
            partsData = [{ partName: "一部", items: [{ name: "", presenter: "" }] }];
        }
    } catch (e) {
        partsData = [{ partName: "一部", items: [{ name: "", presenter: "" }] }];
    }

    if (expDisplay && partsContainer) {
        // Render Display Mode (Tabular format groups tags by Part)
        // ※ 全てのユーザー入力は escapeHtml で安全化（XSS・表示崩れ防止）
        // ※ 実験名は実験ページへのリンクに（A3：相互リンク）
        let displayHtml = '';
        partsData.forEach(p => {
            if (p.items.length === 0 || (p.items.length === 1 && !p.items[0].name && !p.items[0].presenter)) return;
            displayHtml += `<div class="part-title">【${escapeHtml(p.partName || '部なし')}】</div><div style="margin-bottom: 10px;">`;
            p.items.forEach(item => {
                if (!item.name && !item.presenter) return;
                const expName = item.name
                    ? `<a href="experiments.html?focus=${encodeURIComponent(item.name)}" class="exp-link-inline" title="実験内容を見る">${escapeHtml(item.name)}</a>`
                    : '(未定)';
                displayHtml += `<span class="tag tag-exp">${expName} <span class="tag-presenter">(${escapeHtml(item.presenter || '未定')})</span></span>`;
            });
            displayHtml += `</div>`;
        });
        expDisplay.innerHTML = displayHtml || '---';

        // Render Edit Mode Inputs（担当者欄は member-datalist 連携：A1）
        partsContainer.innerHTML = '';
        partsData.forEach(p => {
            const block = document.createElement('div');
            block.className = 'part-block';
            const itemsToRender = p.items.length > 0 ? p.items : [{ name: '', presenter: '' }];
            let rowsHtml = itemsToRender.map(item => buildDynamicRow(item.name, item.presenter)).join('');
            block.innerHTML = `
                <div class="part-header">
                    <div>
                        <input type="text" class="e1-input part-name-input" value="${escapeAttr(p.partName)}" placeholder="部の名前 (例: 一部)">
                    </div>
                    <div class="part-actions">
                        <button class="btn btn-secondary btn-sm" onclick="copyDynamicPart(this)" type="button">📑 部のコピー</button>
                        <button class="btn btn-danger-text btn-sm" onclick="removeDynamicPart(this)" type="button">🗑️ 部の削除</button>
                    </div>
                </div>
                <div class="dynamic-wrapper">${rowsHtml}</div>
                <button class="btn-add-exp" onclick="addDynamicItem(this)" type="button">＋ 実験を追加</button>
            `;
            partsContainer.appendChild(block);
        });
    }

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

    // File processing
    const fileContainer = cardElement.querySelector(`.display-mode[data-field="Files_Display"]`);
    const fileInput = cardElement.querySelector(`input[data-field="Files"]`);
    if (fileContainer && fileInput) {
        if (eventData.Files) {
            fileInput.value = eventData.Files;
            const urls = eventData.Files.split(',').filter(u => u.trim());
            fileContainer.innerHTML = urls.map((url, i) => {
                const safe = encodeURI(url.trim());
                // http(s) のみ許可（javascript: 等を弾く）
                const ok = /^https?:\/\//i.test(url.trim());
                return ok
                    ? `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener" class="file-link">📄 関連ファイル ${i + 1}</a>`
                    : `<span class="file-link" style="color:#999;">⚠️ 無効なURL ${i + 1}</span>`;
            }).join('');
        } else {
            fileContainer.innerHTML = '<span style="color:#999;font-size:0.9rem;">なし</span>';
            fileInput.value = "";
        }
    }
}

// ※ インラインカードの編集/削除/アコーディオン機能は廃止。
//   イベントの閲覧・編集・削除はすべてモーダル経由で行う:
//     表示  → viewEventInModal()
//     編集  → enableModalEdit()
//     保存  → saveEventFromModal()
//     削除  → deleteModalEvent()

// Dynamic List Actions

/**
 * 実験1行のHTMLを生成（実験名・担当者）。
 * 担当者欄は member-datalist と紐付け、実験名欄は experiment-datalist と紐付ける（A1）。
 * 値は escapeAttr で必ず安全化する。
 */
function buildDynamicRow(expName, presenter) {
    return `
        <div class="dynamic-row">
            <input type="text" class="e1-input experiment-name" style="flex:5" value="${escapeAttr(expName || '')}" placeholder="実験名" list="experiment-datalist">
            <input type="text" class="e1-input presenter-name" style="flex:3" value="${escapeAttr(presenter || '')}" placeholder="担当者" list="member-datalist">
            <button class="btn-del" onclick="removeDynamicItem(this)" type="button">✖</button>
        </div>
    `;
}

function addDynamicPart(btn) {
    const container = btn.parentElement.querySelector('.parts-container');
    const block = document.createElement('div');
    block.className = 'part-block';
    block.innerHTML = `
        <div class="part-header">
            <div>
                <input type="text" class="e1-input part-name-input" value="新規の部" placeholder="部の名前 (例: 一部)">
            </div>
            <div class="part-actions">
                <button class="btn btn-secondary btn-sm" onclick="copyDynamicPart(this)" type="button">📑 部のコピー</button>
                <button class="btn btn-danger-text btn-sm" onclick="removeDynamicPart(this)" type="button">🗑️ 部の削除</button>
            </div>
        </div>
        <div class="dynamic-wrapper">${buildDynamicRow('', '')}</div>
        <button class="btn-add-exp" onclick="addDynamicItem(this)" type="button">＋ 実験を追加</button>
    `;
    container.appendChild(block);
}

function removeDynamicPart(btn) {
    const block = btn.closest('.part-block');
    if (block) {
        block.remove();
    }
}

function copyDynamicPart(btn) {
    const original = btn.closest('.part-block');
    const clone = original.cloneNode(true);
    // Append clone after original
    original.parentNode.insertBefore(clone, original.nextSibling);

    // Increment the part name
    const nameInput = clone.querySelector('.part-name-input');
    if (nameInput) {
        const kanjiList = ['一部', '二部', '三部', '四部', '五部', '六部', '七部', '八部', '九部', '十部'];
        let currentVal = nameInput.value.replace(/\s*\(コピー\)$/, '');
        let idx = kanjiList.indexOf(currentVal);
        if (idx !== -1 && idx < kanjiList.length - 1) {
            nameInput.value = kanjiList[idx + 1];
        } else {
            nameInput.value = currentVal + " (コピー)";
        }
    }
}

function addDynamicItem(btn) {
    const wrapper = btn.closest('.part-block').querySelector('.dynamic-wrapper');
    const temp = document.createElement('div');
    temp.innerHTML = buildDynamicRow('', '');
    wrapper.appendChild(temp.firstElementChild);
}

function removeDynamicItem(btn) {
    const item = btn.closest('.dynamic-row');
    const wrapper = item.parentElement;
    item.remove();
    // Ensure at least one remains
    if (wrapper.children.length === 0) {
        addDynamicItem(wrapper.parentElement.querySelector('.btn-add-exp'));
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
            return `<option value="${e.ID}">${e.Date} ${catLabel}: ${escapeHtmlSimple(e.Title)}</option>`;
        }).join('');
    sel.value = '';
}

function escapeHtmlSimple(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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
    const today = new Date().toISOString().split('T')[0];

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
            Remarks: "", Belongings: "", Files: ""
        };
    }

    // Auto calc initial deadlines
    const dHands = calculateDeadlines(startDate);
    newEvent.Kyoka_Deadline = dHands.kyoka;
    newEvent.Houkoku_Deadline = dHands.houkoku;

    const headerTitle = document.querySelector('#new-event-edit-modal h2');
    if (headerTitle) headerTitle.textContent = "✨ 新規イベント作成";

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
}

// Temporary storage for the event currently being created or edited in the modal
let tempNewEvent = null;

function renderModalForm(eventData, isEditMode = true) {
    tempNewEvent = { ...eventData };
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

function deleteModalEvent() {
    const id = tempNewEvent.ID;
    const eventIndex = eventsData.findIndex(e => e.ID === id);
    if (eventIndex < 0) return;
    const backup = eventsData[eventIndex];

    // UIから即削除
    eventsData.splice(eventIndex, 1);
    api.saveCache('events', eventsData);
    renderEvents();
    refreshCalendar();
    closeModal();

    toastUndo(
        `「${backup.Title}」を削除しました`,
        () => {
            eventsData.splice(eventIndex, 0, backup);
            api.saveCache('events', eventsData);
            renderEvents();
            refreshCalendar();
        },
        async () => {
            await api.delete('events', id);
            toast('削除を確定しました', 'success', 2000);
        },
        5000
    );
}

async function saveEventFromModal() {
    const eventIndex = eventsData.findIndex(e => e.ID === tempNewEvent.ID);
    const container = document.getElementById('new-event-form-container');
    const card = container.querySelector('.event-card');

    // Collect data from inputs
    const inputs = card.querySelectorAll('.edit-mode:not(.dynamic-item input)');

    inputs.forEach(input => {
        const field = input.getAttribute('data-field');
        if (field) {
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

    // Collect dynamic lists (Parts structure)
    const partsContainer = card.querySelector('.parts-container');
    if (partsContainer) {
        const blocks = partsContainer.querySelectorAll('.part-block');
        const partsList = [];

        const flatExps = [];
        const flatPres = [];

        blocks.forEach(block => {
            const partName = block.querySelector('.part-name-input').value;
            const rows = block.querySelectorAll('.dynamic-row');
            const items = [];
            rows.forEach(row => {
                const exp = row.querySelector('.experiment-name').value.trim();
                const pre = row.querySelector('.presenter-name').value.trim();
                if (exp || pre) {
                    items.push({ name: exp, presenter: pre });
                    flatExps.push(exp);
                    flatPres.push(pre);
                }
            });
            partsList.push({ partName: partName, items: items });
        });

        tempNewEvent.PartsList = JSON.stringify(partsList);
        tempNewEvent.Experiments = flatExps.join(',');
        tempNewEvent.Presenters = flatPres.join(',');
    }

    // Recalculate deadlines explicitly
    const deadLines = calculateDeadlines(tempNewEvent.Date);
    tempNewEvent.Kyoka_Deadline = deadLines.kyoka;
    tempNewEvent.Houkoku_Deadline = deadLines.houkoku;

    // GASに保存
    let savedEvent;
    try {
        const savedGas = await api.save('events', uiToGas(tempNewEvent));
        savedEvent = gasToUi(savedGas);
    } catch (e) {
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

    closeModal();
    tempNewEvent = null;
    toast('保存しました', 'success');
}

// Update Deadlines on Date Change
function updateDeadlines(dateInput) {
    const card = dateInput.closest('.event-card');
    const newDate = dateInput.value;

    if (!newDate) return;

    const calculations = calculateDeadlines(newDate);

    // Update the READ ONLY display span next to the input (if we were displaying it there)
    // But since we are in edit mode, we might want to update invisible inputs or just displayed text?
    // In this UI, deadlines are Auto-calculated. Users might manually override?
    // The requirement says "Auto set on Date input. Manual override possible."
    // So we need inputs for deadlines too? 
    // Wait, requirement: "Behavior: Auto-set on Event_Date input. Manual overwrite also possible."
    // My HTML currently doesn't have INPUTS for deadlines, only display spans.
    // Let's add Inputs for deadlines or just rely on display for now?
    // "UI Requirement: Center Left: Timeline... Center Right: Experiments... and Deadlines"
    // "Logic: Auto calculate... manual overwrite possible."

    // I should add hidden inputs for deadlines or make the deadline display editable.
    // For now, I'll just update the display logic in the object context.
    // Actually, let's just update the display spans directly for feedback.

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

function formatDate(date) {
    const y = date.getFullYear();
    const m = ('0' + (date.getMonth() + 1)).slice(-2);
    const d = ('0' + date.getDate()).slice(-2);
    return `${y}-${m}-${d}`;
}

// File Drag & Drop (Visual only)
function allowDrop(ev) {
    ev.preventDefault();
}

function handleDrop(ev, element) {
    ev.preventDefault();

    if (ev.dataTransfer.items) {
        // Use DataTransferItemList interface to access the file(s)
        [...ev.dataTransfer.items].forEach((item, i) => {
            // If dropped items aren't files, reject them
            if (item.kind === 'file') {
                const file = item.getAsFile();
                console.log(`... file[${i}].name = ${file.name}`);
                alert(`ファイル "${file.name}" を受け付けました（保存機能は未実装）`);
            }
        });
    }
}
