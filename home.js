/**
 * ホームページ（ダッシュボード）
 */

// リスト行クリックで詳細ページへ(遷移先はこのサイト内の event-series.html のみ)
registerActions({ 'home-goto': el => { const h = el.dataset.href || ''; if (/^event-series\.html\?/.test(h)) location.href = h; } });

document.addEventListener('DOMContentLoaded', () => {
    bootPage('home', init);
});

const REPORT_STATUS = CONFIG.REPORT_STATUS;
const KYOKA_STATUS = CONFIG.KYOKA_STATUS;

let allMembersData = [];

let latestEvents = [];
let latestVotes = [];
let holidaysData = {};

async function init() {
    const cachedEv = api.loadCache('events');
    const cachedMb = api.loadCache('members');
    const cachedEx = api.loadCache('experiments');
    const cachedVo = api.loadCache('votes');

    if (cachedEv) latestEvents = cachedEv.items || [];
    if (cachedVo) latestVotes = cachedVo.items || [];
    if (cachedEv) { renderEventsCard(cachedEv.items || []); renderFeedbackPending(cachedEv.items || []); updateActionNeeded(); }
    if (cachedMb) {
        allMembersData = cachedMb.items || [];
    }
    if (cachedMb) renderIdentityBanners(latestEvents, allMembersData, latestVotes);
    renderStats({
        events: cachedEv ? cachedEv.items : [],
        members: cachedMb ? cachedMb.items : [],
        experiments: cachedEx ? cachedEx.items : []
    });
    renderWelcome();
    renderLineInvite();
    renderSiteLinks();

    updateSyncStatus(cachedEv ? 'cached' : 'initial-loading', cachedEv ? cachedEv.timestamp : null);

    initHomeCalendar();
    api.loadHolidaysCached().then(data => {
        holidaysData = data || {};
        applyHolidaysToCalendar();
    });

    await refreshData(false);
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
    try {
        const all = await api.listAll();
        api.saveCache('events', all.events);
        api.saveCache('members', all.members);
        api.saveCache('experiments', all.experiments);

        latestEvents = all.events;
        allMembersData = all.members || [];
        latestVotes = all.votes;
        api.saveCache('votes', latestVotes);
        renderEventsCard(all.events);
        renderFeedbackPending(all.events);
        updateActionNeeded();
        renderIdentityBanners(latestEvents, allMembersData, latestVotes);
        renderStats(all);
        refreshHomeCalendar();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
        renderLoadError();
    }
}

function renderLoadError() {
    toast('データを読み込めませんでした。通信環境を確認して、もう一度お試しください', 'error');
}

// ---- ホームのメッセージ（管理者が任意の文章を掲載できる。リッチテキスト対応） ----

function renderWelcome() {
    const el = document.getElementById('welcome-msg');
    if (!el) return;
    const custom = localStorage.getItem(CONFIG.WELCOME_MESSAGE_KEY);
    const body = custom || '今日も活動を楽しんでいきましょう。';
    el.innerHTML = sanitizeRichHtml(body);

    const editBtn = document.getElementById('welcome-edit-btn');
    if (editBtn) editBtn.classList.toggle('hidden', !api.isAdmin());
}

function editWelcomeMessage() {
    const area = document.getElementById('welcome-editor-area');
    const msgEl = document.getElementById('welcome-msg');
    const editBtn = document.getElementById('welcome-edit-btn');
    if (!area) return;

    msgEl.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';
    area.classList.remove('hidden');

    const custom = localStorage.getItem(CONFIG.WELCOME_MESSAGE_KEY) || '';
    area.innerHTML = `
        <div id="welcome-rich-editor"></div>
        <div class="action-buttons" style="margin-top:8px;">
            <button type="button" class="btn btn-text" onclick="cancelWelcomeEdit()">キャンセル</button>
            <button type="button" class="btn btn-primary" style="width:auto;" onclick="saveWelcomeMessage()">保存</button>
        </div>
    `;
    createRichEditor(
        document.getElementById('welcome-rich-editor'),
        custom,
        { placeholder: '今日も活動を楽しんでいきましょう。' }
    );
}

function cancelWelcomeEdit() {
    const area = document.getElementById('welcome-editor-area');
    const msgEl = document.getElementById('welcome-msg');
    const editBtn = document.getElementById('welcome-edit-btn');
    area.classList.add('hidden');
    area.innerHTML = '';
    msgEl.style.display = '';
    if (editBtn) editBtn.style.display = '';
}

async function saveWelcomeMessage() {
    const editor = document.getElementById('welcome-rich-editor')?._richEditor;
    if (!editor) return;
    const value = editor.getHtml();
    try {
        await api.adminSetConfig('welcome_message', value);
        if (value) localStorage.setItem(CONFIG.WELCOME_MESSAGE_KEY, value);
        else localStorage.removeItem(CONFIG.WELCOME_MESSAGE_KEY);
        invalidateSettingsCache();
        toast('メッセージを保存しました', 'success');
        cancelWelcomeEdit();
        renderWelcome();
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
    }
}

// ---- LINE公式アカウントの友だち追加案内（設定画面の「友だち追加URL」を表示するだけ） ----

function renderLineInvite() {
    const card = document.getElementById('line-invite-card');
    const link = document.getElementById('line-invite-link');
    if (!card || !link) return;
    const cfg = _readCachedSiteSettings() || {};
    const url = (cfg.line_add_friend_url || '').trim();
    if (!url) {
        card.classList.add('hidden');
        return;
    }
    link.href = safeHttpUrl(url);
    card.classList.remove('hidden');
}

// ---- ダッシュボード ----

function renderStats(all) {
    const today = todayISO();
    const upcomingCount = (all.events || []).filter(e => (e.DateEnd || e.Date) >= today).length;
    document.getElementById('stat-upcoming').textContent = upcomingCount;
    const curFY = currentFiscalYear();
    document.getElementById('stat-members').textContent = (all.members || []).filter(m => parseInt(m.FiscalYear || curFY) === curFY).length;
    document.getElementById('stat-experiments').textContent = (all.experiments || []).length;
}

function renderEventsCard(events) {
    renderKyokaCard(events);
    renderReportsCard(events);
}

// ---- ホームのミニカレンダー（概要）。読み取り専用: 予定の追加・選択は不可、タップで詳細ページへ ----

let homeCalendar = null;

// 日付セルに付けるクラス（祝日）。祝日データは遅れて届くので、届いたら applyHolidaysToCalendar で付け直す
function holidayClassNames(arg) {
    return holidaysData[toISODate(arg.date)] ? ['holiday'] : [];
}

// 祝日データが届いたあとに、表示中のセルへ祝日のクラスを反映する。
// refetchEvents では日付セルが描き直されないので、オプションを差し替えて再評価させる。
function applyHolidaysToCalendar() {
    if (homeCalendar) homeCalendar.setOption('dayCellClassNames', arg => holidayClassNames(arg));
}

function initHomeCalendar() {
    const el = document.getElementById('home-calendar');
    if (!el || homeCalendar || el.dataset.loadFailed) return;   // 作成済み・読み込み失敗の案内済みなら何もしない
    // FullCalendar は <script defer> なので、DOMContentLoaded の時点で未定義なら読み込みに失敗している（待っても来ない）
    if (typeof FullCalendar === 'undefined') {
        el.dataset.loadFailed = '1';
        el.innerHTML = '<div class="text-hint" style="padding:16px; text-align:center;">カレンダーを読み込めませんでした。通信環境を確認して、ページを再読み込みしてください。</div>';
        return;
    }
    homeCalendar = new FullCalendar.Calendar(el, {
        initialView: 'dayGridMonth',
        locale: 'ja',
        height: 'auto',
        dayMaxEvents: 2,
        headerToolbar: { left: 'prev', center: 'title', right: 'today next' },
        buttonText: { today: '今日' },
        now: jstNowAsLocalDate,   // 「今日」の強調と「今日」ボタンは、端末のタイムゾーンではなく日本時間で数える
        dayCellClassNames: holidayClassNames,
        events: function (fetchInfo, successCallback) {
            const fcEvents = (latestEvents || []).map(e => {
                const cat = getEventCategory(e.Category);
                let displayTitle = e.Title;
                const meetingNo = e.MeetingNumber;
                if (cat.isMeeting && meetingNo) {
                    displayTitle = `第${meetingNo}回 ${displayTitle}`;
                }
                let endDate = null;
                const rawEnd = e.DateEnd;
                if (rawEnd) {
                    endDate = addDaysISO(rawEnd, 1);
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
        }
    });
    homeCalendar.render();

    // 中央の「2026年9月」をタップすると年月ピッカーを開く
    if (!el.dataset.jumpBound) {
        el.dataset.jumpBound = '1';
        el.addEventListener('click', (ev) => {
            if (ev.target.closest('.fc-toolbar-title')) openHomeCalendarJumpPicker();
        });
    }
}

// カレンダー中央の年月タイトルから開く、大きめの年月ピッカー（‹ 年 › ＋ 12か月ボタン）。
function openHomeCalendarJumpPicker() {
    if (!homeCalendar) return;
    const card = document.querySelector('.home-calendar-card');
    if (!card) return;
    if (card.querySelector('.cal-jump-pop')) { closeHomeCalendarJumpPicker(); return; }

    const cur = homeCalendar.getDate();
    let year = cur.getFullYear();
    const curY = cur.getFullYear();
    const curM = cur.getMonth();
    const now = jstNowAsLocalDate();   // 「今月」の強調は、端末ではなく日本時間で数える

    const pop = document.createElement('div');
    pop.className = 'cal-jump-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '年月を選択');

    const render = () => {
        pop.innerHTML = `
            <div class="cal-jump-year">
                <button type="button" class="cal-jump-nav" data-y="-1" aria-label="前の年">‹</button>
                <span class="cal-jump-year-label">${year}年</span>
                <button type="button" class="cal-jump-nav" data-y="1" aria-label="次の年">›</button>
            </div>
            <div class="cal-jump-months">
                ${Array.from({ length: 12 }, (_, i) => {
                    const cls = [
                        'cal-jump-month',
                        (year === curY && i === curM) ? 'is-current' : '',
                        (year === now.getFullYear() && i === now.getMonth()) ? 'is-today' : ''
                    ].join(' ').trim();
                    return `<button type="button" class="${cls}" data-m="${i}">${i + 1}月</button>`;
                }).join('')}
            </div>`;
    };
    render();

    pop.addEventListener('click', (ev) => {
        const nav = ev.target.closest('.cal-jump-nav');
        if (nav) { year += Number(nav.dataset.y); render(); return; }
        const mb = ev.target.closest('.cal-jump-month');
        if (mb) {
            homeCalendar.gotoDate(new Date(year, Number(mb.dataset.m), 1));
            closeHomeCalendarJumpPicker();
        }
    });

    card.appendChild(pop);

    // 閉じる操作: 外側クリック / Esc
    setTimeout(() => {
        document.addEventListener('click', onHomeCalendarPickerOutside, true);
        document.addEventListener('keydown', onHomeCalendarPickerKey);
    }, 0);
}

function closeHomeCalendarJumpPicker() {
    document.querySelectorAll('.cal-jump-pop').forEach(n => n.remove());
    document.removeEventListener('click', onHomeCalendarPickerOutside, true);
    document.removeEventListener('keydown', onHomeCalendarPickerKey);
}

function onHomeCalendarPickerOutside(ev) {
    if (ev.target.closest('.cal-jump-pop') || ev.target.closest('.fc-toolbar-title')) return;
    closeHomeCalendarJumpPicker();
}

function onHomeCalendarPickerKey(ev) {
    if (ev.key === 'Escape') closeHomeCalendarJumpPicker();
}

function refreshHomeCalendar() {
    if (homeCalendar) homeCalendar.refetchEvents();
    else initHomeCalendar();
}

// 中身が前回と同じなら DOM を作り直さない。裏の再読込のたびに作り直すと、開いているセレクトが閉じたり、
// 選びかけの値が消えたりするため。作り直したら true。
function setHtmlIfChanged(el, html) {
    if (el._lastHtml === html) return false;
    el._lastHtml = html;
    el.innerHTML = html;
    return true;
}

// 「対応が必要」の件数バッジに出す総数（一覧は先頭の数件だけ表示するので、表示件数とは別に持つ）
function setActionTotal(container, total) {
    container.dataset.total = String(total);
}

function renderKyokaCard(events) {
    const container = document.getElementById('upcoming-kyoka');
    if (!container) return;
    const today = todayISO();
    const in30 = addDaysISO(todayISO(), 30);

    const items = [];
    (events || []).forEach(e => {
        if (isMeetingCategory(e.Category)) return;
        const deadline = e.KyokaDeadline || '';
        if (!deadline) return;
        if ((e.KyokaStatus || '') === 'submitted') return;
        const endDate = e.DateEnd || e.Date;
        if (!endDate || endDate < today) return;
        if (deadline > in30) return;
        items.push({ id: e.ID, date: deadline, event: e.Title, admin: e.AdminKyoka || '', status: e.KyokaStatus || '' });
    });
    items.sort((a, b) => a.date.localeCompare(b.date));
    setActionTotal(container, items.length);

    const html = items.slice(0, 8).map(r => {
        const overdue = r.date < today;
        const options = Object.keys(KYOKA_STATUS).map(v =>
            `<option value="${v}" ${v === r.status ? 'selected' : ''}>${KYOKA_STATUS[v].label}</option>`
        ).join('');
        return `
        <li class="report-row">
            <span class="dl-date">${shortDate(r.date)}${overdue ? '<span class="report-overdue">超過</span>' : ''}</span>
            <span class="dl-title">
                <a href="event-series.html?event=${encodeURIComponent(r.id)}" class="report-event-link">${escapeHtml(r.event || '(無題)')}</a>
                ${r.admin ? `<span class="report-admin">担当: ${escapeHtml(r.admin)}</span>` : ''}
            </span>
            <select class="report-status-select status-${docStatusClass(KYOKA_STATUS, r.status)}" data-event-id="${escapeAttr(r.id)}" title="提出ステータスを変更">
                ${options}
            </select>
        </li>`;
    }).join('');

    if (!setHtmlIfChanged(container, html)) return;
    container.querySelectorAll('.report-status-select[data-event-id]').forEach(sel => {
        sel.addEventListener('change', () => setDocStatus(sel.dataset.eventId, 'KyokaStatus', sel.value));
    });
}

function renderReportsCard(events) {
    const container = document.getElementById('upcoming-deadlines');
    if (!container) return;
    const today = todayISO();
    const in30 = addDaysISO(todayISO(), 30);
    const past90 = addDaysISO(todayISO(), -90);

    const reports = [];
    (events || []).forEach(e => {
        if (isMeetingCategory(e.Category)) return;
        const deadline = e.HoukokuDeadline || '';
        if (!deadline) return;
        const status = e.ReportStatus || '';
        if (status === 'clc') return;
        if (deadline > in30 || deadline < past90) return;
        reports.push({ id: e.ID, date: deadline, event: e.Title, admin: e.AdminHoukoku || '', status });
    });
    reports.sort((a, b) => a.date.localeCompare(b.date));
    setActionTotal(container, reports.length);

    const html = reports.slice(0, 8).map(r => {
        const overdue = r.date < today;
        const options = Object.keys(REPORT_STATUS).map(v =>
            `<option value="${v}" ${v === r.status ? 'selected' : ''}>${REPORT_STATUS[v].label}</option>`
        ).join('');
        return `
        <li class="report-row">
            <span class="dl-date">${shortDate(r.date)}${overdue ? '<span class="report-overdue">超過</span>' : ''}</span>
            <span class="dl-title">
                <a href="event-series.html?event=${encodeURIComponent(r.id)}&tab=feedback" class="report-event-link">${escapeHtml(r.event || '(無題)')}</a>
                ${r.admin ? `<span class="report-admin">担当: ${escapeHtml(r.admin)}</span>` : ''}
            </span>
            <select class="report-status-select status-${docStatusClass(REPORT_STATUS, r.status)}" data-event-id="${escapeAttr(r.id)}" title="提出ステータスを変更">
                ${options}
            </select>
        </li>`;
    }).join('');

    if (!setHtmlIfChanged(container, html)) return;
    container.querySelectorAll('.report-status-select[data-event-id]').forEach(sel => {
        sel.addEventListener('change', () => setDocStatus(sel.dataset.eventId, 'ReportStatus', sel.value));
    });
}

async function setDocStatus(id, field, value) {
    const ev = latestEvents.find(e => e.ID === id);
    if (!ev) { toast('データを読み込み中です。少し待ってから操作してください。', 'info', 3000); return; }
    if ((ev[field] || '') === value) return;

    const isKyoka = field === 'KyokaStatus';
    const statusDef = isKyoka ? KYOKA_STATUS : REPORT_STATUS;
    const docName = isKyoka ? '許可願' : '報告書';
    const rerender = () => { renderKyokaCard(latestEvents); renderReportsCard(latestEvents); updateActionNeeded(); };
    const label = (statusDef[value] || statusDef['']).label;

    // 楽観更新・直列化・競合トースト・ロールバックは saveEventPatch（app.js）に任せる
    await saveEventPatch(id, { [field]: value }, {
        getEvent: evId => latestEvents.find(e => e.ID === evId),
        persist: () => api.saveCache('events', latestEvents),
        onOptimistic: rerender,
        onRollback: rerender,
        onConflict: () => refreshData(),
        successMessage: `${docName}ステータスを「${label}」にしました`
    });
}

function renderFeedbackPending(events) {
    const container = document.getElementById('feedback-pending');
    if (!container) return;
    const today = todayISO();
    const cutoff = addDaysISO(todayISO(), -14);
    const pending = (events || [])
        .filter(e => {
            if (isMeetingCategory(e.Category)) return false;
            const endDate = e.DateEnd || e.Date;
            if (!endDate || endDate >= today || endDate < cutoff) return false;
            return !(e.Positives || '').trim() && !(e.Reflections || '').trim();
        })
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
    setActionTotal(container, pending.length);

    container.innerHTML = pending.slice(0, 5).map(e => {
        const url = `event-series.html?event=${encodeURIComponent(e.ID)}&tab=feedback`;
        return `<li data-action="home-goto" data-href="${escapeAttr(url)}" style="cursor:pointer;">
            <span class="dl-date">${shortDate(e.Date)}</span>
            <span class="dl-title"><a href="${url}" class="report-event-link">${escapeHtml(e.Title || '(無題)')}</a></span>
            <span class="dl-badge badge-warning">未記入</span>
        </li>`;
    }).join('');
}

// ホーム上部の2つの通知バナーをまとめて出し分ける。
// 名前（VOTE_MEMBER_KEY）が未設定なら「名前を選択」バナー、設定済みなら出欠未回答バナーを出す
// （両方同時には出さない。名前が無ければ未回答判定もできないため）。
function renderIdentityBanners(events, members, votes) {
    const memberId = getValidSavedVoteMemberId(members);   // 存在しない名前（年度コピー等）は破棄して選び直してもらう
    if (!memberId) {
        renderNameSelectBanner(members);
        hideVoteReminderBanner();
    } else {
        hideNameSelectBanner();
        renderVoteReminder(events, members, votes, memberId);
    }
}

function hideNameSelectBanner() {
    const banner = document.getElementById('name-select-banner');
    if (banner) banner.classList.add('hidden');
}

function hideVoteReminderBanner() {
    const banner = document.getElementById('vote-reminder-banner');
    if (banner) banner.classList.add('hidden');
}

// 「あなたの名前」が端末に未記憶なら、ホームで選んでもらう（旧: ログイン直後のポップアップを廃止し、こちらに統一）。
function renderNameSelectBanner(members) {
    const banner = document.getElementById('name-select-banner');
    if (!banner) return;
    if (!members || members.length === 0) { banner.classList.add('hidden'); return; }

    const sel = document.getElementById('name-select-banner-select');
    const btn = document.getElementById('name-select-banner-btn');
    const eligible = voteEligibleMembers(members);
    if (eligible.length === 0) { banner.classList.add('hidden'); return; }

    const groups = groupMembersByGrade(eligible);
    // 裏の再読込でも、選びかけの名前を消さない（選択肢が同じなら作り直さず、変わっても選んだ値を戻す）
    const picked = sel.value;
    const changed = setHtmlIfChanged(sel, '<option value="">-- 名前を選択 --</option>' +
        groups.map(g => `<optgroup label="${escapeAttr(g.label)}">${g.members.map(m => `<option value="${escapeAttr(m.ID)}">${escapeHtml(m.Name)}</option>`).join('')}</optgroup>`).join(''));
    if (changed && picked && eligible.some(m => m.ID === picked)) sel.value = picked;
    btn.disabled = !sel.value;
    sel.onchange = () => { btn.disabled = !sel.value; };
    const applyName = () => {
        if (!sel.value) return;
        const chosen = eligible.find(m => m.ID === sel.value);
        setSavedVoteMemberId(sel.value);
        sel.value = '';   // 後で名前を外してバナーが再び出たとき、前の選択を残さない
        toast(`「${chosen ? chosen.Name : '名前'}」を設定しました`, 'success', 2500);
        renderIdentityBanners(latestEvents, allMembersData, latestVotes);
    };
    btn.onclick = applyName;
    // 名前を選んだ状態で Enter を押しても設定できるようにする（キーボード操作の自然さ）
    sel.onkeydown = (e) => { if (e.key === 'Enter' && sel.value) { e.preventDefault(); applyName(); } };
    banner.classList.remove('hidden');
}

// 締切前の予定に出欠未回答なら通知バナーを出す（幹部会は出欠対象外なので除外）。
// 具体的な予定名は出さず、件数だけ知らせる（詳細は「出欠を回答」から確認できる）。
function renderVoteReminder(events, members, votes, memberId) {
    const banner = document.getElementById('vote-reminder-banner');
    if (!banner) return;

    const today = todayISO();
    const pending = (events || [])
        .filter(e => e.Category !== 'admin')
        .filter(e => (e.DateEnd || e.Date) >= today)
        .filter(e => !voteDeadlinePassed(e))
        .filter(e => voteEligibleMembers(members, e).some(m => m.ID === memberId))
        .filter(e => !(votes || []).some(v => v.eventId === e.ID && v.memberId === memberId))
        .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));

    if (pending.length === 0) { banner.classList.add('hidden'); return; }

    const first = pending[0];
    const textEl = document.getElementById('vote-reminder-text');
    const linkEl = document.getElementById('vote-reminder-link');
    textEl.textContent = `出欠が未回答の予定が${pending.length}件あります`;
    linkEl.href = `event-series.html?event=${encodeURIComponent(first.ID)}&vote=1`;
    banner.classList.remove('hidden');
}

// 「対応が必要」の各カード（許可願・報告書・振り返り）を個別に開閉する。
// 済んだ区分だけを畳めるよう、セクション全体ではなく見出し単位のトグルにしている。
function toggleActionCard(btn) {
    const list = document.getElementById(btn.getAttribute('aria-controls'));
    if (!list) return;
    const open = list.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    const card = btn.closest('.dash-card');
    if (card) card.classList.toggle('dash-card--collapsed', !open);
}

function updateActionNeeded() {
    const section = document.getElementById('action-needed');
    if (!section) return;
    let hasContent = false;
    ['upcoming-kyoka', 'upcoming-deadlines', 'feedback-pending'].forEach(id => {
        const list = document.getElementById(id);
        if (!list) return;
        const card = list.closest('.dash-card');
        // 一覧は先頭の数件だけなので、件数は描画時に記録した総数を使う
        const count = list.dataset.total !== undefined ? Number(list.dataset.total) : list.children.length;
        const has = count > 0;
        // 畳んでいても残件数が分かるよう、見出し右の件数バッジを更新する
        const countEl = document.getElementById('count-' + id);
        if (countEl) countEl.textContent = has ? String(count) : '';
        if (card) card.style.display = has ? '' : 'none';
        if (has) hasContent = true;
    });
    section.style.display = hasContent ? '' : 'none';
}

// ---- リンク集（設定画面で登録した外部リンクをホーム最下部に並べる） ----

function renderSiteLinks() {
    const section = document.getElementById('site-links-section');
    const list = document.getElementById('site-links-list');
    if (!section || !list) return;
    const cfg = _readCachedSiteSettings() || {};
    const links = parseSiteLinks(cfg.site_links);
    if (links.length === 0) {
        list.innerHTML = '';
        section.style.display = 'none';
        return;
    }
    list.innerHTML = links.map(l => {
        const host = siteLinkHost(l.url);
        return `
        <a class="site-link" href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">
            <span class="site-link-label">${escapeHtml(l.label)}</span>
            ${host ? `<span class="site-link-host">${escapeHtml(host)}</span>` : ''}
        </a>`;
    }).join('');
    section.style.display = '';
}
