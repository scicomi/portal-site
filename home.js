/**
 * ホームページ（ダッシュボード）
 */

document.addEventListener('DOMContentLoaded', () => {
    bootPage('home', init);
});

async function init() {
    const cachedEv = api.loadCache('events');
    const cachedMb = api.loadCache('members');
    const cachedEx = api.loadCache('experiments');

    if (cachedEv) renderEventsCard(cachedEv.items || []);
    if (cachedMb) renderMembersCard(cachedMb.items || []);
    if (cachedEx) renderExperimentsCard(cachedEx.items || []);
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

        renderEventsCard(all.events);
        renderMembersCard(all.members);
        renderExperimentsCard(all.experiments);
        renderStats(all);
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

function renderWelcome() {
    const hour = new Date().getHours();
    let greeting = 'こんにちは';
    if (hour < 11) greeting = 'おはようございます';
    else if (hour >= 18) greeting = 'こんばんは';
    document.getElementById('welcome-msg').textContent = `${greeting} -- 今日も活動を楽しんでいきましょう。`;
}

function renderStats(all) {
    const today = todayISO();
    const upcomingCount = (all.events || []).filter(e => (e.DateEnd || e.Date) >= today).length;
    document.getElementById('stat-events').textContent = (all.events || []).length;
    document.getElementById('stat-upcoming').textContent = upcomingCount;
    document.getElementById('stat-members').textContent = (all.members || []).filter(m => m.Active !== 'false').length;
    document.getElementById('stat-experiments').textContent = (all.experiments || []).length;
}

function renderEventsCard(events) {
    const container = document.getElementById('upcoming-events');
    const today = todayISO();

    const upcoming = (events || [])
        .filter(e => (e.DateEnd || e.Date) >= today)
        .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''))
        .slice(0, 5);

    if (upcoming.length === 0) {
        container.innerHTML = '<li style="color:#999;justify-content:center;">予定なし</li>';
    } else {
        container.innerHTML = upcoming.map(e => {
            const c = getEventCategory(e.Category);
            let title = e.Title || '(無題)';
            if (c.isMeeting && e.MeetingNumber) {
                title = `第${e.MeetingNumber}回 ${title}`;
            }
            return `
                <li onclick="location.href='events.html'" style="cursor:pointer;">
                    <span class="dl-date">${shortDate(e.Date)}</span>
                    <span class="dl-title">${escapeHtml(title)}</span>
                    <span class="dl-badge" style="background:${c.bg};color:${c.text};">${c.short}</span>
                </li>
            `;
        }).join('');
    }

    renderDeadlinesCard(events);
}

function renderDeadlinesCard(events) {
    const container = document.getElementById('upcoming-deadlines');
    const today = todayISO();
    const in30 = toISODate((() => { const d = new Date(); d.setDate(d.getDate() + 30); return d; })());

    const deadlines = [];
    (events || []).forEach(e => {
        // ミーティング（全体MTG/幹部MTG）には書類期限が無いので除外
        if (e.Category === 'general' || e.Category === 'admin') return;
        if (e.KyokaDeadline && e.KyokaDeadline >= today && e.KyokaDeadline <= in30) {
            deadlines.push({ date: e.KyokaDeadline, type: '許可願', event: e.Title, admin: e.AdminKyoka });
        }
        if (e.HoukokuDeadline && e.HoukokuDeadline >= today && e.HoukokuDeadline <= in30) {
            deadlines.push({ date: e.HoukokuDeadline, type: '報告書', event: e.Title, admin: e.AdminHoukoku });
        }
    });
    deadlines.sort((a, b) => a.date.localeCompare(b.date));

    if (deadlines.length === 0) {
        container.innerHTML = '<li style="color:#999;justify-content:center;">30日以内の期限なし</li>';
        return;
    }

    container.innerHTML = deadlines.slice(0, 6).map(d => {
        const u = deadlineUrgency(d.date);
        return `
        <li class="deadline-row ${u.cls}">
            <span class="dl-date">${shortDate(d.date)}</span>
            <span class="dl-title">${escapeHtml(d.type)} <span style="color:#999;">(${escapeHtml(d.event)})</span></span>
            <span class="dl-badge" style="background:${u.bg};color:${u.text};">${u.daysLabel}</span>
        </li>`;
    }).join('');
}

function deadlineUrgency(dateISO) {
    const days = daysBetween(todayISO(), dateISO);
    const A = CONFIG.DEADLINE_ALERT;
    if (days <= A.danger) {
        return { cls: 'urgent', bg: '#fee2e2', text: '#991b1b', daysLabel: days <= 0 ? '今日!' : `あと${days}日` };
    }
    if (days <= A.warning) {
        return { cls: 'soon', bg: '#fef3c7', text: '#92400e', daysLabel: `あと${days}日` };
    }
    return { cls: '', bg: '#dcfce7', text: '#166534', daysLabel: `あと${days}日` };
}

function renderMembersCard(members) {
    const container = document.getElementById('member-summary');
    const advisers = members.filter(m => m.Category === 'adviser' && m.Active !== 'false');
    const coordinators = members.filter(m => m.Category === 'coordinator' && m.Active !== 'false');
    const regular = members.filter(m => m.Category === 'member' && m.Active !== 'false');

    container.innerHTML = `
        <li><span class="dl-date">アドバイザー</span><span class="dl-title">${advisers.length}名</span></li>
        <li><span class="dl-date">コーディネーター</span><span class="dl-title">${coordinators.length}名</span></li>
        <li><span class="dl-date">メンバー</span><span class="dl-title">${regular.length}名</span></li>
        ${regular.filter(m => m.Role).slice(0, 4).map(m => `
            <li><span class="dl-date" style="min-width:90px;">${escapeHtml(m.Role || '')}</span><span class="dl-title">${escapeHtml(m.Name)}</span></li>
        `).join('')}
    `;
}

function renderExperimentsCard(experiments) {
    const container = document.getElementById('exp-summary');
    const workshop = experiments.filter(e => e.Category === 'workshop');
    const show = experiments.filter(e => e.Category === 'show');
    const other = experiments.filter(e => e.Category === 'other');

    container.innerHTML = `
        <li><span class="dl-date">工作</span><span class="dl-title">${workshop.length}種類</span></li>
        <li><span class="dl-date">実験ショー</span><span class="dl-title">${show.length}種類</span></li>
        <li><span class="dl-date">その他</span><span class="dl-title">${other.length}種類</span></li>
        ${experiments.slice(0, 4).map(e => `
            <li>
                <span class="dl-date" style="min-width:70px;">${escapeHtml(getExperimentCategory(e.Category).label)}</span>
                <span class="dl-title">${escapeHtml(e.Name)}</span>
            </li>
        `).join('')}
    `;
}
