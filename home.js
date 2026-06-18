/**
 * ホームページ（ダッシュボード）
 */

document.addEventListener('DOMContentLoaded', () => {
    bootPage('home', init);
});

async function init() {
    // 1. 各リソースをキャッシュから即表示
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

    // 2. 裏でまとめて取得
    try {
        updateSyncStatus('syncing-bg');
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

async function refreshData() { await init(); }

function renderWelcome() {
    const hour = new Date().getHours();
    let greeting = 'こんにちは';
    if (hour < 11) greeting = 'おはようございます';
    else if (hour >= 18) greeting = 'こんばんは';
    document.getElementById('welcome-msg').textContent = `${greeting}！今日も活動を楽しんでいきましょう。`;
}

function renderStats(all) {
    const today = new Date().toISOString().slice(0, 10);
    const upcomingCount = (all.events || []).filter(e => (e.DateEnd || e.Date) >= today).length;
    document.getElementById('stat-events').textContent = (all.events || []).length;
    document.getElementById('stat-upcoming').textContent = upcomingCount;
    document.getElementById('stat-members').textContent = (all.members || []).filter(m => m.Active !== 'false').length;
    document.getElementById('stat-experiments').textContent = (all.experiments || []).length;
}

function renderEventsCard(events) {
    const container = document.getElementById('upcoming-events');
    const today = new Date().toISOString().slice(0, 10);

    const upcoming = (events || [])
        .filter(e => (e.DateEnd || e.Date) >= today)
        .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''))
        .slice(0, 5);

    if (upcoming.length === 0) {
        container.innerHTML = '<li style="color:#999;justify-content:center;">予定なし</li>';
        return;
    }

    const catColors = {
        normal: { bg: '#fecaca', color: '#7c2d2d', label: '通常' },
        other: { bg: '#bbf7d0', color: '#14532d', label: '学内' },
        general: { bg: '#bfdbfe', color: '#1e3a5f', label: '全体' },
        admin: { bg: '#fde68a', color: '#78350f', label: '幹部' }
    };

    container.innerHTML = upcoming.map(e => {
        const c = catColors[e.Category] || catColors.normal;
        let title = e.Title || '(無題)';
        if ((e.Category === 'admin' || e.Category === 'general') && e.MeetingNumber) {
            title = `第${e.MeetingNumber}回 ${title}`;
        }
        return `
            <li>
                <span class="dl-date">${formatShortDate(e.Date)}</span>
                <span class="dl-title">${escapeHtml(title)}</span>
                <span class="dl-badge" style="background:${c.bg};color:${c.color};">${c.label}</span>
            </li>
        `;
    }).join('');

    // 期限カード
    renderDeadlinesCard(events);
}

function renderDeadlinesCard(events) {
    const container = document.getElementById('upcoming-deadlines');
    const today = new Date().toISOString().slice(0, 10);
    const in30days = new Date(); in30days.setDate(in30days.getDate() + 30);
    const in30 = in30days.toISOString().slice(0, 10);

    const deadlines = [];
    (events || []).forEach(e => {
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

    container.innerHTML = deadlines.slice(0, 5).map(d => `
        <li>
            <span class="dl-date">${formatShortDate(d.date)}</span>
            <span class="dl-title">${escapeHtml(d.type)} (${escapeHtml(d.event)})</span>
            <span class="dl-badge" style="background:#fee2e2;color:#7c2d2d;">${escapeHtml(d.admin || '未定')}</span>
        </li>
    `).join('');
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
        <li><span class="dl-date">🛠️ 工作</span><span class="dl-title">${workshop.length}種類</span></li>
        <li><span class="dl-date">🎭 実験ショー</span><span class="dl-title">${show.length}種類</span></li>
        <li><span class="dl-date">✨ その他</span><span class="dl-title">${other.length}種類</span></li>
        ${experiments.slice(0, 4).map(e => `
            <li>
                <span class="dl-date">${e.Category === 'workshop' ? '🛠️' : e.Category === 'show' ? '🎭' : '✨'}</span>
                <span class="dl-title">${escapeHtml(e.Name)}</span>
            </li>
        `).join('')}
    `;
}

// ---- helpers ----
function formatShortDate(d) {
    if (!d) return '';
    const parts = String(d).split('-');
    if (parts.length < 3) return d;
    return `${parts[1]}/${parts[2]}`;
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
