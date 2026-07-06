// イベントデータ（GASから取得してここに保持）
let eventsData = [];


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
            if (action === 'series' || action === 'open') return; // <a> のデフォルト遷移に任せる
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

    const filtered = applyFilters(eventsData);
    const sorted = filtered.slice().sort((a, b) => {
        if (filterState.period === 'past') return (b.Date || '').localeCompare(a.Date || '');
        return (a.Date || '').localeCompare(b.Date || '');
    });

    const periodLabel = { upcoming: '今後のイベント', past: '過去のイベント', all: '全てのイベント' };
    heading.textContent = `${periodLabel[filterState.period]} (${sorted.length}件)`;

    if (sorted.length === 0) {
        // 何を変えれば表示されるのかが分かるヒントを添える
        const hasNarrowing = filterState.keyword || filterState.category !== 'all';
        const hint = hasNarrowing
            ? '検索キーワードやカテゴリの絞り込みを変更してみてください'
            : (filterState.period === 'upcoming' && eventsData.length > 0
                ? '「過去」または「全期間」に切り替えると過去のイベントを確認できます'
                : '');
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">
            <div class="empty-text">該当するイベントはありません</div>
            ${hint ? `<div class="empty-hint">${hint}</div>` : ''}
        </td></tr>`;
        return;
    }

    // 削除ボタンは全員に表示し、非管理者はタップ時に管理者認証を挟む（各ページ共通ルール）
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
                    <a href="event-series.html?event=${encodeURIComponent(ev.ID)}" data-action="open" style="font-weight:600;color:inherit;text-decoration:none;">${escapeHtml(displayTitle)}</a>
                    <span class="cat-badge" style="background:${cat.bg};color:${cat.text};margin-left:6px;">${cat.short}</span>
                    ${occ ? `<a href="event-series.html?key=${encodeURIComponent(eventSeriesKey(ev))}" class="occ-badge occ-link" title="通算${occ.total}回 — シリーズ履歴を見る" data-action="series">${occ.num}回目</a>` : ''}
                    ${voteBadge}
                </td>
                <td class="hide-mobile">${escapeHtml(ev.Location || '')}</td>
                <td class="hide-mobile">${escapeHtml(ev.Event_Time || '')}</td>
                <td data-action-cell>
                    <div class="inline-actions">
                        <button class="inline-action-btn" data-action="duplicate" title="複製して新規作成">&#x29C9;</button>
                        <button class="inline-action-btn" data-action="edit" title="編集">&#9998;</button>
                        <button class="inline-action-btn danger" data-action="delete" title="削除">&#x2715;</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
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
        Title: template ? (template.Title || '') : '',
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
                <button id="qc-save" class="btn btn-primary" onclick="saveQuickCreate()" title="作成後はイベント詳細ページが開き、残りの項目を追記できます">作成</button>
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
        btn.textContent = '作成';
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
