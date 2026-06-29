/**
 * ホームページ（ダッシュボード）
 */

document.addEventListener('DOMContentLoaded', () => {
    bootPage('home', init);
});

// 報告書ステータス（''=未提出 / coordinator / clc）
const REPORT_STATUS = {
    '':            { label: '未提出',                color: '#9ca3af' },
    'coordinator': { label: 'コーディネーター提出済', color: '#f59e0b' },
    'clc':         { label: 'CLC提出済',            color: '#10b981' }
};

// 報告書ステータスの保存に使う、GAS 正準形（listAll 由来）のイベント配列。
// UI形（イベントページが書いたキャッシュ）を誤って保存して列がずれるのを防ぐため、
// 正準形と判定できる場合のみセットする。
let latestEvents = [];
function looksGasForm(items) {
    if (!items || items.length === 0) return true;
    const e = items[0];
    return ('HoukokuDeadline' in e) && !('Houkoku_Deadline' in e);
}

async function init() {
    const cachedEv = api.loadCache('events');
    const cachedMb = api.loadCache('members');
    const cachedEx = api.loadCache('experiments');

    // latestEvents（報告書ステータス保存に使う）は GAS正準形のときだけ採用する。
    // 表示用カードは新旧どちらのキャッシュでも動くよう各 render 側で吸収する。
    if (cachedEv && looksGasForm(cachedEv.items)) latestEvents = cachedEv.items || [];
    if (cachedEv) { renderEventsCard(cachedEv.items || []); renderFeedbackPending(cachedEv.items || []); updateActionNeeded(); }
    if (cachedMb) renderMembersCard(cachedMb.items || []);
    renderStats({
        events: cachedEv ? cachedEv.items : [],
        members: cachedMb ? cachedMb.items : [],
        experiments: cachedEx ? cachedEx.items : []
    });
    renderWelcome();

    updateSyncStatus(cachedEv ? 'cached' : 'initial-loading', cachedEv ? cachedEv.timestamp : null);

    await refreshData(false);
}

async function refreshData(isManual = false) {
    updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
    try {
        const all = await api.listAll();
        api.saveCache('events', all.events);
        api.saveCache('members', all.members);
        api.saveCache('experiments', all.experiments);

        latestEvents = all.events;  // 正準形を保持（報告書ステータス保存に使う）
        renderEventsCard(all.events);
        renderFeedbackPending(all.events);
        updateActionNeeded();
        renderMembersCard(all.members);
        renderStats(all);
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
    }
}

function renderWelcome() {
    const hour = new Date().getHours();
    let greeting = 'こんにちは';
    if (hour < 11) greeting = 'おはようございます';
    else if (hour >= 18) greeting = 'こんばんは';
    const custom = localStorage.getItem('scicomi_welcome_message');
    const body = custom || '今日も活動を楽しんでいきましょう。';
    document.getElementById('welcome-msg').textContent = `${greeting} -- ${body}`;
}

function renderStats(all) {
    const today = todayISO();
    const upcomingCount = (all.events || []).filter(e => (e.DateEnd || e.Date_End || e.Date) >= today).length;
    document.getElementById('stat-upcoming').textContent = upcomingCount;
    const curFY = (function(){ const n = new Date(); return (n.getMonth()+1) >= 4 ? n.getFullYear() : n.getFullYear()-1; })();
    document.getElementById('stat-members').textContent = (all.members || []).filter(m => parseInt(m.FiscalYear || curFY) === curFY).length;
    document.getElementById('stat-experiments').textContent = (all.experiments || []).length;
}

function renderEventsCard(events) {
    const container = document.getElementById('upcoming-events');
    const today = todayISO();

    const upcoming = (events || [])
        .filter(e => (e.DateEnd || e.Date_End || e.Date) >= today)
        .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''))
        .slice(0, 5);

    if (upcoming.length === 0) {
        container.innerHTML = '<li class="empty-state"><span class="empty-text">予定なし</span></li>';
    } else {
        container.innerHTML = upcoming.map(e => {
            const c = getEventCategory(e.Category);
            let title = e.Title || '(無題)';
            const meetingNo = e.MeetingNumber || e.Meeting_Number;
            if (c.isMeeting && meetingNo) {
                title = `第${meetingNo}回 ${title}`;
            }
            return `
                <li onclick="location.href='events.html?event=${encodeURIComponent(e.ID)}'" style="cursor:pointer;">
                    <span class="dl-date">${shortDate(e.Date)}</span>
                    <span class="dl-title">${escapeHtml(title)}</span>
                    <span class="dl-badge" style="background:${c.bg};color:${c.text};">${c.short}</span>
                </li>
            `;
        }).join('');
    }

    renderReportsCard(events);
}

// 「期限が近い報告書」カード。報告書（HoukokuDeadline）だけを対象に、
// 締切日・担当者・イベント名を表示し、タップで提出ステータス（未提出→コーディネーター→CLC）を管理する。
// ※ 期限アラートの色分け／残り日数バッジは廃止（書類アラート不要のため）。
function renderReportsCard(events) {
    const container = document.getElementById('upcoming-deadlines');
    if (!container) return;
    const today = todayISO();
    const in30 = toISODate((() => { const d = new Date(); d.setDate(d.getDate() + 30); return d; })());
    const past90 = toISODate((() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })());

    const reports = [];
    (events || []).forEach(e => {
        // ミーティング（全体MTG/幹部MTG）には報告書が無いので除外
        if (e.Category === 'general' || e.Category === 'admin') return;
        // 報告書期限は GAS形(HoukokuDeadline) / UI形(Houkoku_Deadline) のどちらでも拾う。
        // これが GAS形のみ参照だったため、イベントページが書いた UI形キャッシュだと空表示になっていた。
        const deadline = e.HoukokuDeadline || e.Houkoku_Deadline || '';
        if (!deadline) return;
        const status = e.ReportStatus || '';
        // CLC提出済（完了）は表示しない。締切が直近30日以内、または過去90日以内の未完了分を表示。
        if (status === 'clc') return;
        if (deadline > in30 || deadline < past90) return;
        reports.push({ id: e.ID, date: deadline, event: e.Title, admin: e.AdminHoukoku || e.Admin_Houkoku || '', status });
    });
    reports.sort((a, b) => a.date.localeCompare(b.date));

    if (reports.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = reports.slice(0, 8).map(r => {
        const overdue = r.date < today;
        const options = Object.keys(REPORT_STATUS).map(v =>
            `<option value="${v}" ${v === r.status ? 'selected' : ''}>${REPORT_STATUS[v].label}</option>`
        ).join('');
        return `
        <li class="report-row">
            <span class="dl-date">${shortDate(r.date)}${overdue ? '<span class="report-overdue">超過</span>' : ''}</span>
            <span class="dl-title">
                <a href="events.html?event=${encodeURIComponent(r.id)}&tab=feedback" class="report-event-link">${escapeHtml(r.event || '(無題)')}</a>
                ${r.admin ? `<span class="report-admin">担当: ${escapeHtml(r.admin)}</span>` : ''}
            </span>
            <select class="report-status-select status-${r.status || 'none'}" onchange="setReportStatus('${r.id}', this.value)" title="提出ステータスを変更">
                ${options}
            </select>
        </li>`;
    }).join('');
}

// 報告書ステータスを更新（楽観的UI + 競合検知）。GAS 正準形イベントに対してのみ実行する。
async function setReportStatus(id, value) {
    const ev = latestEvents.find(e => e.ID === id);
    if (!ev) { toast('データを読み込み中です。少し待ってから操作してください。', 'info', 3000); return; }
    const prev = ev.ReportStatus || '';
    if (prev === value) return;

    ev.ReportStatus = value;
    api.saveCache('events', latestEvents);
    renderReportsCard(latestEvents);

    const label = (REPORT_STATUS[value] || REPORT_STATUS['']).label;
    try {
        const saved = await api.save('events', { ...ev, _baseUpdatedAt: ev.UpdatedAt || '' });
        Object.assign(ev, saved);
        api.saveCache('events', latestEvents);
        toast(`報告書ステータスを「${label}」にしました`, 'success', 2000);
    } catch (e) {
        ev.ReportStatus = prev;
        renderReportsCard(latestEvents);
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 4000);
            refreshData();
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    }
}

function renderMembersCard(members) {
    const container = document.getElementById('member-summary');
    const curFY = (function(){ const n = new Date(); return (n.getMonth()+1) >= 4 ? n.getFullYear() : n.getFullYear()-1; })();
    const fy = members.filter(m => parseInt(m.FiscalYear || curFY) === curFY);

    function effectiveRole(m) {
        if (m.Role) return m.Role;
        if (m.Category === 'adviser') return 'アドバイザー';
        if (m.Category === 'coordinator') return 'コーディネーター';
        return '';
    }

    const advisers = fy.filter(m => effectiveRole(m) === 'アドバイザー');
    const coordinators = fy.filter(m => effectiveRole(m) === 'コーディネーター');
    const regular = fy.filter(m => { const r = effectiveRole(m); return r !== 'アドバイザー' && r !== 'コーディネーター'; });
    const withRole = regular.filter(m => effectiveRole(m));

    container.innerHTML = `
        <li><span class="dl-date">アドバイザー</span><span class="dl-title">${advisers.length}名</span></li>
        <li><span class="dl-date">コーディネーター</span><span class="dl-title">${coordinators.length}名</span></li>
        <li><span class="dl-date">メンバー</span><span class="dl-title">${regular.length}名</span></li>
        ${withRole.slice(0, 4).map(m => `
            <li><span class="dl-date" style="min-width:90px;">${escapeHtml(effectiveRole(m))}</span><span class="dl-title">${escapeHtml(m.Name)}</span></li>
        `).join('')}
    `;
}

function renderFeedbackPending(events) {
    const container = document.getElementById('feedback-pending');
    if (!container) return;
    const today = todayISO();
    const pending = (events || [])
        .filter(e => {
            if (e.Category === 'general' || e.Category === 'admin') return false;
            const endDate = e.DateEnd || e.Date_End || e.Date;
            if (!endDate || endDate >= today) return false;
            return !(e.Positives || '').trim() && !(e.Reflections || '').trim();
        })
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))
        .slice(0, 5);

    if (pending.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = pending.map(e => {
        return `<li onclick="location.href='events.html?event=${encodeURIComponent(e.ID)}&tab=feedback'" style="cursor:pointer;">
            <span class="dl-date">${shortDate(e.Date)}</span>
            <span class="dl-title">${escapeHtml(e.Title || '(無題)')}</span>
            <span class="dl-badge badge-warning">未記入</span>
        </li>`;
    }).join('');
}

function updateActionNeeded() {
    const section = document.getElementById('action-needed');
    if (!section) return;
    const deadlines = document.getElementById('upcoming-deadlines');
    const feedback = document.getElementById('feedback-pending');
    const hasContent = (deadlines && deadlines.children.length > 0) || (feedback && feedback.children.length > 0);
    section.style.display = hasContent ? '' : 'none';
}

