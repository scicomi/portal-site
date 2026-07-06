/**
 * ホームページ（ダッシュボード）
 */

document.addEventListener('DOMContentLoaded', () => {
    bootPage('home', init);
});

// 書類（許可願・報告書）の提出ステータス定義（config.js に集約）
const REPORT_STATUS = CONFIG.REPORT_STATUS;
const KYOKA_STATUS = CONFIG.KYOKA_STATUS;

// 出欠一括回答（vote.html と同じキーで名前選択を端末に記憶する）
const VOTE_MEMBER_KEY = 'scicomi_vote_member';
const VOTE_LABELS = { attend: '参加', absent: '不参加', undecided: '未定' };
let allVotes = null;        // null = 未取得（読み込み中表示に使う）
let allMembersData = [];

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
    if (cachedMb) {
        allMembersData = cachedMb.items || [];
        renderMembersCard(allMembersData);
    }
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

        latestEvents = all.events;  // 正準形を保持（書類ステータス保存に使う）
        allMembersData = all.members || [];
        renderEventsCard(all.events);
        renderFeedbackPending(all.events);
        updateActionNeeded();
        renderMembersCard(all.members);
        renderStats(all);
        updateSyncStatus('fresh', Date.now());
        loadVotesAndRenderBulk();
    } catch (e) {
        if (e.handled) return;
        updateSyncStatus('error', null, e.message);
        renderLoadError();
    }
}

// 初回読み込みに失敗（キャッシュも無い）場合、「読み込み中」スピナーが残り続けないよう
// エラー表示＋再読み込みボタンに置き換える。キャッシュ表示済みのカードには触らない。
function renderLoadError() {
    document.querySelectorAll('#upcoming-events .loading-text, #member-summary .loading-text, #bulk-vote-list .loading-text').forEach(el => {
        el.outerHTML = `<li class="empty-state">
            <div class="empty-text">データを読み込めませんでした</div>
            <div class="empty-hint">通信環境を確認して、もう一度お試しください</div>
            <button type="button" class="btn btn-secondary" onclick="refreshData(true)">再読み込み</button>
        </li>`;
    });
}

// ---- 出欠一括回答 ----

async function loadVotesAndRenderBulk() {
    try {
        allVotes = await api.listVotes();
    } catch (_) {
        allVotes = [];
    }
    renderBulkVote();
}

// 出欠の回答はコーディネーター・アドバイザーを対象外にする
function isVoteEligibleMember(m) {
    const r = memberRoleOf(m);
    return r !== 'アドバイザー' && r !== 'コーディネーター';
}

function renderBulkVote() {
    const select = document.getElementById('bulk-vote-member');
    if (!select) return;

    const curFY = currentFiscalYear();
    const eligible = (allMembersData || [])
        .filter(m => m.Name && m.Active !== 'false' && parseInt(m.FiscalYear || curFY) === curFY && isVoteEligibleMember(m))
        .sort((a, b) => (a.Name || '').localeCompare(b.Name || '', 'ja'));

    const saved = localStorage.getItem(VOTE_MEMBER_KEY) || '';
    select.innerHTML = '<option value="">-- 名前を選択 --</option>' + eligible.map(m =>
        `<option value="${escapeAttr(m.ID)}" ${m.ID === saved ? 'selected' : ''}>${escapeHtml(m.Name)}</option>`
    ).join('');
    select.onchange = () => {
        if (select.value) localStorage.setItem(VOTE_MEMBER_KEY, select.value);
        else localStorage.removeItem(VOTE_MEMBER_KEY);
        renderBulkVoteList();
    };
    renderBulkVoteList();
}

function renderBulkVoteList() {
    const listEl = document.getElementById('bulk-vote-list');
    if (!listEl) return;
    if (allVotes === null) {
        listEl.innerHTML = '<li class="loading-text">読み込み中</li>';
        return;
    }
    const memberId = document.getElementById('bulk-vote-member')?.value || '';
    const today = todayISO();
    const upcoming = (latestEvents || [])
        .filter(e => (e.DateEnd || e.Date) >= today)
        .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''))
        .slice(0, 10);

    if (upcoming.length === 0) {
        listEl.innerHTML = '<li class="empty-state"><span class="empty-text">今後の予定はありません</span></li>';
        return;
    }

    const staffIds = new Set((allMembersData || []).filter(m => !isVoteEligibleMember(m)).map(m => m.ID));
    const byEvent = {};
    (allVotes || []).forEach(v => {
        if (staffIds.has(v.memberId)) return;
        const b = byEvent[v.eventId] || (byEvent[v.eventId] = { attend: 0, absent: 0, undecided: 0, mine: '' });
        if (b[v.status] !== undefined) b[v.status]++;
        if (memberId && v.memberId === memberId) b.mine = v.status;
    });

    listEl.innerHTML = upcoming.map(e => {
        let title = e.Title || '(無題)';
        const c = getEventCategory(e.Category);
        if (c.isMeeting && e.MeetingNumber) title = `第${e.MeetingNumber}回 ${title}`;
        const agg = byEvent[e.ID] || { attend: 0, absent: 0, undecided: 0, mine: '' };
        const btns = memberId ? `
            <span class="bv-btns" data-event-id="${escapeAttr(e.ID)}">
                ${Object.keys(VOTE_LABELS).map(st =>
                    `<button type="button" class="bv-btn bv-${st} ${agg.mine === st ? 'active' : ''}" data-status="${st}">${VOTE_LABELS[st]}</button>`
                ).join('')}
            </span>` : '';
        return `<li class="bv-row">
            <span class="dl-date">${shortDate(e.Date)}</span>
            <span class="dl-title">
                <a href="event-series.html?event=${encodeURIComponent(e.ID)}" class="report-event-link">${escapeHtml(title)}</a>
                <span class="bv-counts">参加${agg.attend}・不参加${agg.absent}・未定${agg.undecided}</span>
            </span>
            ${btns}
        </li>`;
    }).join('');

    listEl.querySelectorAll('.bv-btns').forEach(box => {
        box.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.bv-btn');
            if (btn) submitBulkVote(box.dataset.eventId, btn.dataset.status);
        });
    });
}

async function submitBulkVote(eventId, status) {
    const memberId = document.getElementById('bulk-vote-member')?.value || '';
    if (!memberId) { toast('先に名前を選択してください', 'info'); return; }

    // 楽観的更新（失敗時は巻き戻す）
    const idx = allVotes.findIndex(v => v.eventId === eventId && v.memberId === memberId);
    const before = idx >= 0 ? { ...allVotes[idx] } : null;
    if (before && before.status === status) return;
    if (idx >= 0) allVotes[idx] = { ...allVotes[idx], status };
    else allVotes.push({ eventId, memberId, status, updatedAt: '' });
    renderBulkVoteList();

    try {
        const saved = await api.submitVote({ eventId, memberId, status });
        const j = allVotes.findIndex(v => v.eventId === eventId && v.memberId === memberId);
        if (j >= 0) allVotes[j] = saved;
        toast(`「${VOTE_LABELS[status]}」で回答しました`, 'success', 2000);
    } catch (e) {
        const j = allVotes.findIndex(v => v.eventId === eventId && v.memberId === memberId);
        if (before) { if (j >= 0) allVotes[j] = before; }
        else if (j >= 0) allVotes.splice(j, 1);
        renderBulkVoteList();
        toast('回答に失敗しました: ' + e.message, 'error');
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
    const curFY = currentFiscalYear();
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
        container.innerHTML = '<li class="empty-state"><span class="empty-text">今後の予定はありません</span></li>';
    } else {
        container.innerHTML = upcoming.map(e => {
            const c = getEventCategory(e.Category);
            let title = e.Title || '(無題)';
            const meetingNo = e.MeetingNumber || e.Meeting_Number;
            if (c.isMeeting && meetingNo) {
                title = `第${meetingNo}回 ${title}`;
            }
            // 行全体タップでも、キーボード(Tab→Enter)でリンクからでも開けるようにする
            return `
                <li onclick="location.href='event-series.html?event=${encodeURIComponent(e.ID)}'" style="cursor:pointer;">
                    <span class="dl-date">${shortDate(e.Date)}</span>
                    <span class="dl-title"><a href="event-series.html?event=${encodeURIComponent(e.ID)}" class="report-event-link">${escapeHtml(title)}</a></span>
                    <span class="dl-badge" style="background:${c.bg};color:${c.text};">${c.short}</span>
                </li>
            `;
        }).join('');
    }

    renderKyokaCard(events);
    renderReportsCard(events);
}

// 「許可願の期限」カード。イベント開催前に必要な書類なので、
// 期限が30日以内（超過含む）かつイベントがまだ終わっていない未提出分を表示する。
function renderKyokaCard(events) {
    const container = document.getElementById('upcoming-kyoka');
    if (!container) return;
    const today = todayISO();
    const in30 = toISODate((() => { const d = new Date(); d.setDate(d.getDate() + 30); return d; })());

    const items = [];
    (events || []).forEach(e => {
        // ミーティングには許可願が無い
        if (e.Category === 'general' || e.Category === 'admin') return;
        // GAS形 / UI形どちらのキャッシュでも拾う
        const deadline = e.KyokaDeadline || e.Kyoka_Deadline || '';
        if (!deadline) return;
        if ((e.KyokaStatus || '') === 'submitted') return;
        const endDate = e.DateEnd || e.Date_End || e.Date;
        if (!endDate || endDate < today) return; // イベントが終わっていれば対象外
        if (deadline > in30) return;             // 30日より先はまだ表示しない
        items.push({ id: e.ID, date: deadline, event: e.Title, admin: e.AdminKyoka || e.Admin_Kyoka || '', status: e.KyokaStatus || '' });
    });
    items.sort((a, b) => a.date.localeCompare(b.date));

    if (items.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = items.slice(0, 8).map(r => {
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

    container.querySelectorAll('.report-status-select[data-event-id]').forEach(sel => {
        sel.addEventListener('change', () => setDocStatus(sel.dataset.eventId, 'KyokaStatus', sel.value));
    });
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
                <a href="event-series.html?event=${encodeURIComponent(r.id)}&tab=feedback" class="report-event-link">${escapeHtml(r.event || '(無題)')}</a>
                ${r.admin ? `<span class="report-admin">担当: ${escapeHtml(r.admin)}</span>` : ''}
            </span>
            <select class="report-status-select status-${docStatusClass(REPORT_STATUS, r.status)}" data-event-id="${escapeAttr(r.id)}" title="提出ステータスを変更">
                ${options}
            </select>
        </li>`;
    }).join('');

    container.querySelectorAll('.report-status-select[data-event-id]').forEach(sel => {
        sel.addEventListener('change', () => setDocStatus(sel.dataset.eventId, 'ReportStatus', sel.value));
    });
}

// 書類ステータス（許可願/報告書）を更新（楽観的UI + 競合検知）。GAS 正準形イベントに対してのみ実行する。
async function setDocStatus(id, field, value) {
    const ev = latestEvents.find(e => e.ID === id);
    if (!ev) { toast('データを読み込み中です。少し待ってから操作してください。', 'info', 3000); return; }
    const prev = ev[field] || '';
    if (prev === value) return;

    const isKyoka = field === 'KyokaStatus';
    const statusDef = isKyoka ? KYOKA_STATUS : REPORT_STATUS;
    const docName = isKyoka ? '許可願' : '報告書';
    const rerender = () => { renderKyokaCard(latestEvents); renderReportsCard(latestEvents); updateActionNeeded(); };

    ev[field] = value;
    api.saveCache('events', latestEvents);
    rerender();

    const label = (statusDef[value] || statusDef['']).label;
    try {
        const saved = await api.save('events', { ...ev, _baseUpdatedAt: ev.UpdatedAt || '' });
        Object.assign(ev, saved);
        api.saveCache('events', latestEvents);
        toast(`${docName}ステータスを「${label}」にしました`, 'success', 2000);
    } catch (e) {
        ev[field] = prev;
        rerender();
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
    const curFY = currentFiscalYear();
    const fy = members.filter(m => parseInt(m.FiscalYear || curFY) === curFY);

    if (fy.length === 0) {
        container.innerHTML = '<li class="empty-state"><span class="empty-text">今年度のメンバーが登録されていません</span></li>';
        return;
    }

    const advisers = fy.filter(m => memberRoleOf(m) === 'アドバイザー');
    const coordinators = fy.filter(m => memberRoleOf(m) === 'コーディネーター');
    const regular = fy.filter(m => { const r = memberRoleOf(m); return r !== 'アドバイザー' && r !== 'コーディネーター'; });
    const withRole = regular.filter(m => memberRoleOf(m));

    container.innerHTML = `
        <li><span class="dl-date">アドバイザー</span><span class="dl-title">${advisers.length}名</span></li>
        <li><span class="dl-date">コーディネーター</span><span class="dl-title">${coordinators.length}名</span></li>
        <li><span class="dl-date">メンバー</span><span class="dl-title">${regular.length}名</span></li>
        ${withRole.slice(0, 4).map(m => `
            <li><span class="dl-date" style="min-width:90px;">${escapeHtml(memberRoleOf(m))}</span><span class="dl-title">${escapeHtml(m.Name)}</span></li>
        `).join('')}
    `;
}

function renderFeedbackPending(events) {
    const container = document.getElementById('feedback-pending');
    if (!container) return;
    const today = todayISO();
    // 終了から2週間を過ぎたイベントはもう通知しない（古い未記入で埋まらないように）
    const cutoff = toISODate((() => { const d = new Date(); d.setDate(d.getDate() - 14); return d; })());
    const pending = (events || [])
        .filter(e => {
            if (e.Category === 'general' || e.Category === 'admin') return false;
            const endDate = e.DateEnd || e.Date_End || e.Date;
            if (!endDate || endDate >= today || endDate < cutoff) return false;
            return !(e.Positives || '').trim() && !(e.Reflections || '').trim();
        })
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))
        .slice(0, 5);

    if (pending.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = pending.map(e => {
        const url = `event-series.html?event=${encodeURIComponent(e.ID)}&tab=feedback`;
        return `<li onclick="location.href='${url}'" style="cursor:pointer;">
            <span class="dl-date">${shortDate(e.Date)}</span>
            <span class="dl-title"><a href="${url}" class="report-event-link">${escapeHtml(e.Title || '(無題)')}</a></span>
            <span class="dl-badge badge-warning">未記入</span>
        </li>`;
    }).join('');
}

function updateActionNeeded() {
    const section = document.getElementById('action-needed');
    if (!section) return;
    // 中身のあるカードだけ表示し、1つも無ければセクションごと隠す
    let hasContent = false;
    ['upcoming-kyoka', 'upcoming-deadlines', 'feedback-pending'].forEach(id => {
        const list = document.getElementById(id);
        if (!list) return;
        const card = list.closest('.dash-card');
        const has = list.children.length > 0;
        if (card) card.style.display = has ? '' : 'none';
        if (has) hasContent = true;
    });
    section.style.display = hasContent ? '' : 'none';
}

