/**
 * イベント別ページ（シリーズ＋イベント詳細）
 *
 * 1ページで2モードを持つ:
 *   - 一覧モード   … ?key も ?event も無い。全シリーズ（同名イベントのまとまり）をカードで一覧。
 *   - 詳細モード   … ?key=<シリーズキー> または ?event=<イベントID>。
 *                     タブ = イベント詳細 / 振り返り / 統計・開催履歴。
 *
 * イベント詳細タブがこのサイトの「イベント1件の正規ページ」。
 * 旧・詳細モーダル（events.html）と投票サマリー・書類ステータスをここに統合した。
 * データは GAS 正準形（DateEnd / TimeStart / AdminKyoka 等）で扱う。
 */

let allEventsData = [];      // GAS正準形
let seriesEvents = [];       // 表示中シリーズ（日付降順）
let seriesKey = '';
let seriesFbFilter = 'all';
let currentEventId = '';     // 詳細タブで選択中の開催回
let indexMode = false;
let indexFilter = 'event';   // 一覧モードのフィルタ: event / meeting / all
let membersCache = [];
let experimentsCache = [];
const votesCache = {};       // eventId -> votes[]
let scrollToFeedback = false;

// 許可願・報告書の提出ステータス定義
const KYOKA_STATUS = {
    '':          { label: '未提出', color: '#9ca3af' },
    'submitted': { label: '提出済', color: '#10b981' }
};
const REPORT_STATUS = {
    '':            { label: '未提出',                 color: '#9ca3af' },
    'coordinator': { label: 'コーディネーター提出済', color: '#f59e0b' },
    'clc':         { label: 'CLC提出済',              color: '#10b981' }
};

function seriesKeyNormalize(e) {
    const k = (e.SeriesKey && String(e.SeriesKey).trim()) || (e.Title || '');
    return k.replace(/\s+/g, '').replace(/^第\d+回/, '');
}

// events キャッシュはイベントページが UI形（Event_Time 等）で書くことがあるため、
// GAS正準形へ正規化してから使う（script.js の cacheItemsToUi の逆向き）。
function toGasForm(e) {
    if (!e || !('Event_Time' in e)) return e;
    const g = { ...e };
    const t = (e.Event_Time || '').split(' - ');
    g.DateEnd = e.Date_End || '';
    g.TimeStart = (t[0] || '').trim();
    g.TimeEnd = (t[1] || '').trim();
    g.GatherTime = e.Gather_Time || '';
    g.DismissTime = e.Dismiss_Time || '';
    g.Logistics = e.Meeting_Logistics || '';
    g.AdminKyoka = e.Admin_Kyoka || '';
    g.AdminHoukoku = e.Admin_Houkoku || '';
    g.KyokaDeadline = e.Kyoka_Deadline || '';
    g.HoukokuDeadline = e.Houkoku_Deadline || '';
    g.MeetingNumber = e.Meeting_Number || '';
    return g;
}

document.addEventListener('DOMContentLoaded', () => {
    bootPage('series', init);
});

async function init() {
    const params = new URLSearchParams(location.search);
    seriesKey = params.get('key') || '';
    currentEventId = params.get('event') || '';
    scrollToFeedback = params.get('tab') === 'feedback';
    indexMode = !seriesKey && !currentEventId;

    document.getElementById(indexMode ? 'series-index' : 'series-view').classList.remove('hidden');
    if (indexMode) document.title = 'イベント別ページ | SciComi Portal';

    loadAuxData(); // メンバー・実験は補助情報。裏で読み込み、揃い次第再描画する。

    const cached = api.loadCache('events');
    if (cached && cached.items && cached.items.length > 0) {
        allEventsData = cached.items.map(toGasForm);
        onDataReady(false);
        updateSyncStatus('cached', cached.timestamp);
    } else {
        updateSyncStatus('initial-loading');
    }

    try {
        allEventsData = await api.list('events');
        api.saveCache('events', allEventsData);
        onDataReady(true);
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        if (!indexMode && seriesEvents.length === 0) {
            document.getElementById('series-loading').textContent = 'データの読み込みに失敗しました';
        }
        updateSyncStatus('error', null, e.message);
    }
}

async function loadAuxData() {
    let members = (api.loadCache('members') || {}).items;
    let experiments = (api.loadCache('experiments') || {}).items;
    if (!members) {
        try { members = await api.list('members'); api.saveCache('members', members); } catch (_) { members = []; }
    }
    if (!experiments) {
        try { experiments = await api.list('experiments'); api.saveCache('experiments', experiments); } catch (_) { experiments = []; }
    }
    membersCache = members || [];
    experimentsCache = experiments || [];
    // 実験リンク・未回答数の表示が変わるので、詳細を描画済みなら再描画
    if (!indexMode && seriesEvents.length > 0) renderDetail();
}

function onDataReady(isFresh) {
    if (indexMode) {
        renderSeriesIndex();
        return;
    }

    // ?event=<ID> だけで来た場合はイベントからシリーズキーを導出する
    if (currentEventId && !seriesKey) {
        const ev = allEventsData.find(e => e.ID === currentEventId);
        if (!ev) {
            if (isFresh) document.getElementById('series-loading').textContent = 'イベントが見つかりません';
            return;
        }
        seriesKey = seriesKeyNormalize(ev);
    }

    filterSeries();
    if (seriesEvents.length === 0) {
        if (isFresh) document.getElementById('series-loading').textContent = '該当するイベントが見つかりません';
        return;
    }
    renderAll();
}

function filterSeries() {
    seriesEvents = allEventsData
        .filter(ev => seriesKeyNormalize(ev) === seriesKey && ev.Date)
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
}

// ====== 一覧モード（シリーズ一覧） ======

function onSeriesIndexFilter(f) {
    indexFilter = f;
    document.querySelectorAll('.filter-chip[data-sidx]').forEach(c => c.classList.toggle('active', c.dataset.sidx === f));
    renderSeriesIndex();
}

function buildSeriesIndex() {
    const map = {};
    allEventsData.forEach(ev => {
        if (!ev.Date) return;
        const key = seriesKeyNormalize(ev);
        if (!key) return;
        (map[key] || (map[key] = [])).push(ev);
    });
    const today = todayISO();
    return Object.keys(map).map(key => {
        const events = map[key].slice().sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
        const latest = events[0];
        const next = events
            .filter(e => (e.DateEnd || e.Date) >= today)
            .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''))[0] || null;
        return {
            key,
            title: (latest.Title || '(無題)').replace(/^第\d+回\s*/, ''),
            count: events.length,
            latestDate: latest.Date,
            next,
            category: latest.Category || 'normal',
            location: latest.Location || ''
        };
    });
}

function renderSeriesIndex() {
    const grid = document.getElementById('series-index-grid');
    if (!grid) return;
    const q = (document.getElementById('series-index-search')?.value || '').toLowerCase().trim();

    let list = buildSeriesIndex();
    list = list.filter(s => {
        const isMtg = s.category === 'general' || s.category === 'admin';
        if (indexFilter === 'event' && isMtg) return false;
        if (indexFilter === 'meeting' && !isMtg) return false;
        if (q && !(s.title.toLowerCase().includes(q) || s.location.toLowerCase().includes(q))) return false;
        return true;
    });

    // 次回開催が近いものを先頭に、あとは直近開催が新しい順
    list.sort((a, b) => {
        if (a.next && b.next) return a.next.Date.localeCompare(b.next.Date);
        if (a.next) return -1;
        if (b.next) return 1;
        return (b.latestDate || '').localeCompare(a.latestDate || '');
    });

    if (list.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="padding:30px 20px;">該当する催しはありません</div>';
        return;
    }

    grid.innerHTML = list.map(s => {
        const cat = getEventCategory(s.category);
        return `<a class="series-index-card" href="event-series.html?key=${encodeURIComponent(s.key)}">
            <div class="series-index-head">
                <span class="series-index-title">${escapeHtml(s.title)}</span>
                <span class="cat-badge" style="background:${cat.bg};color:${cat.text};">${cat.short}</span>
            </div>
            <div class="series-index-meta">
                <span class="occ-badge">通算${s.count}回</span>
                ${s.next
                    ? `<span class="series-index-next">次回 ${escapeHtml(s.next.Date)} (${dayOfWeekJP(s.next.Date)})</span>`
                    : `<span class="text-muted">直近 ${escapeHtml(s.latestDate || '---')}</span>`}
            </div>
            ${s.location ? `<div class="series-index-loc">${escapeHtml(s.location)}</div>` : ''}
        </a>`;
    }).join('');
}

// ====== 詳細モード ======

function renderAll() {
    document.getElementById('series-loading').classList.add('hidden');
    document.getElementById('series-content').classList.remove('hidden');

    // 選択中の開催回を決める: URL指定 > 次回開催 > 最新
    if (!currentEventId || !seriesEvents.some(e => e.ID === currentEventId)) {
        const today = todayISO();
        const upcoming = seriesEvents
            .filter(e => (e.DateEnd || e.Date) >= today)
            .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''))[0];
        currentEventId = (upcoming || seriesEvents[0]).ID;
    }

    const title = seriesEvents[0].Title || seriesKey;
    const displayTitle = title.replace(/^第\d+回\s*/, '');
    document.getElementById('series-title').textContent = displayTitle;
    document.title = `${displayTitle} | SciComi Portal`;

    const years = seriesEvents.map(ev => ev.Date.slice(0, 4)).filter(Boolean);
    const earliest = Math.min(...years.map(Number));
    document.getElementById('series-subtitle').textContent =
        seriesEvents.length > 1 ? `通算${seriesEvents.length}回開催（${earliest}年〜）` : '';

    renderSafetyInfo();
    renderOccurrenceSelector();
    renderDetail();
    renderFeedbackTimeline();
    renderStats();
    renderOverview();

    if (scrollToFeedback) {
        scrollToFeedback = false;
        setTimeout(() => {
            const el = document.getElementById('series-detail-feedback');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
    }
}

function currentEvent() {
    return seriesEvents.find(e => e.ID === currentEventId) || seriesEvents[0];
}

// 開催回セレクタ（複数回開催のシリーズだけ表示）
function renderOccurrenceSelector() {
    const box = document.getElementById('series-occ-selector');
    if (!box) return;
    if (seriesEvents.length < 2) { box.innerHTML = ''; return; }

    const today = todayISO();
    const asc = seriesEvents.slice().sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
    const options = seriesEvents.map(ev => {
        const n = asc.findIndex(x => x.ID === ev.ID) + 1;
        const isUpcoming = (ev.DateEnd || ev.Date) >= today;
        const label = `${ev.Date} (${dayOfWeekJP(ev.Date)}) — ${n}回目${isUpcoming ? '（予定）' : ''}`;
        return `<option value="${escapeAttr(ev.ID)}" ${ev.ID === currentEventId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');

    box.innerHTML = `
        <div class="occ-selector-row">
            <label class="occ-selector-label">開催回</label>
            <select class="e1-input occ-selector-select" onchange="selectOccurrence(this.value)">${options}</select>
        </div>`;
}

function selectOccurrence(id) {
    if (!seriesEvents.some(e => e.ID === id)) return;
    currentEventId = id;
    history.replaceState(null, '', `event-series.html?key=${encodeURIComponent(seriesKey)}&event=${encodeURIComponent(id)}`);
    renderSafetyInfo();
    renderOccurrenceSelector();
    renderDetail();
}

// 統計・振り返りタブから特定の開催回の詳細へ飛ぶ
function openOccurrence(id) {
    selectOccurrence(id);
    const detailTab = document.querySelector('.expd-tab[data-tab="detail"]');
    if (detailTab) switchSeriesTab(detailTab);
    const detail = document.getElementById('series-detail');
    if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- 緊急連絡先・現地情報 ----

function renderSafetyInfo() {
    const card = document.getElementById('series-safety-card');
    if (!card) return;

    // 選択中の開催回を優先し、無ければ同シリーズの他の回から補完する
    let info = null;
    const cur = currentEvent();
    if (cur && (cur.Address || cur.EmergencyHospital || cur.EmergencyPolice)) {
        info = cur;
    } else {
        for (const ev of seriesEvents) {
            if (ev.Address || ev.EmergencyHospital || ev.EmergencyPolice) { info = ev; break; }
        }
    }

    if (!info) {
        card.classList.add('hidden');
        return;
    }
    card.classList.remove('hidden');

    const addressEl = document.getElementById('series-address');
    const hospitalEl = document.getElementById('series-hospital');
    const policeEl = document.getElementById('series-police');
    if (addressEl) addressEl.textContent = info.Address || '---';
    if (hospitalEl) hospitalEl.innerHTML = formatTelLink(info.EmergencyHospital);
    if (policeEl) policeEl.innerHTML = formatTelLink(info.EmergencyPolice);
}

function formatTelLink(text) {
    if (!text) return '---';
    // "施設名：0186-45-0223" のようなフォーマットから電話番号を抽出してリンク化
    const match = text.match(/([\d\-]+)$/);
    if (match) {
        const tel = match[1];
        const telDigits = tel.replace(/-/g, '');
        return `${escapeHtml(text.replace(tel, ''))}<a href="tel:${escapeAttr(telDigits)}" class="series-tel-link">${escapeHtml(tel)}</a>`;
    }
    return escapeHtml(text);
}

// ---- イベント詳細タブ ----

// 未入力チェックリスト（案C: 枠だけ作成→あとから追記、の「あとから」を可視化する）
function missingFields(ev) {
    const isMeeting = ev.Category === 'general' || ev.Category === 'admin';
    const miss = [];
    if (!ev.Location) miss.push('場所');
    if (!ev.TimeStart) miss.push('時間');
    if (!isMeeting) {
        if (!ev.Audience) miss.push('対象・人数');
        if (normalizeParts(ev.PartsList).filter(p => p.name).length === 0) miss.push('実験内容');
        if (!ev.GatherTime) miss.push('集合時間');
        if (!ev.AdminKyoka) miss.push('許可願の担当');
        if (!ev.AdminHoukoku) miss.push('報告書の担当');
    }
    return miss;
}

function expLinkHtml(name) {
    const match = experimentsCache.find(e => e.Name === name);
    const href = match
        ? `experiment-detail.html?id=${encodeURIComponent(match.ID)}`
        : `experiments.html?focus=${encodeURIComponent(name)}`;
    return `<a href="${href}" class="exp-link-inline" title="実験内容を見る">${escapeHtml(name)}</a>`;
}

function renderDetail() {
    const box = document.getElementById('series-detail');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }

    const isMeeting = ev.Category === 'general' || ev.Category === 'admin';
    const cat = getEventCategory(ev.Category);
    const today = todayISO();
    const isUpcoming = (ev.DateEnd || ev.Date) >= today;

    const asc = seriesEvents.slice().sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
    const occNum = asc.findIndex(x => x.ID === ev.ID) + 1;

    let displayTitle = ev.Title || '(無題)';
    if (isMeeting && ev.MeetingNumber) displayTitle = `第${ev.MeetingNumber}回 ${displayTitle}`;

    // 未入力チェックリスト（今後の開催のみ）
    const miss = isUpcoming ? missingFields(ev) : [];
    const checklistHtml = miss.length > 0 ? `
        <div class="detail-checklist">
            <span class="detail-checklist-label">未入力の項目:</span>
            ${miss.map(m => `<span class="checklist-chip">${escapeHtml(m)}</span>`).join('')}
            <a href="events.html?edit=${encodeURIComponent(ev.ID)}" class="detail-checklist-link">編集して追記 &rarr;</a>
        </div>` : '';

    // 実験・発表者
    const parts = normalizeParts(ev.PartsList).filter(p => p.name || (p.presenters && p.presenters.length));
    const expHtml = parts.length > 0
        ? parts.map(p => {
            const nameHtml = p.name ? expLinkHtml(p.name) : '(未定)';
            const presenters = (p.presenters && p.presenters.length) ? p.presenters.map(escapeHtml).join(', ') : '未定';
            return `<span class="tag tag-exp">${nameHtml} <span class="tag-presenter">(${presenters})</span></span>`;
        }).join('')
        : '---';

    // 関連ファイル
    const files = Array.isArray(ev.Files) ? ev.Files : [];
    const filesHtml = files.length > 0
        ? files.map((f, i) => {
            const url = f.url || '';
            const name = escapeHtml(f.name || ('ファイル ' + (i + 1)));
            const size = f.size ? ' (' + formatFileSize(f.size) + ')' : '';
            if (/^https?:\/\//i.test(url)) {
                return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="file-link">${name}${size}</a>`;
            }
            return `<span class="file-link text-hint">${name} (リンク切れ)</span>`;
        }).join('')
        : '<span class="text-hint" style="font-size:0.9rem;">なし</span>';

    // 書類（許可願・報告書: 期限＋担当＋ステータス変更）
    const kyokaOverdue = ev.KyokaDeadline && ev.KyokaDeadline < today && (ev.KyokaStatus || '') !== 'submitted';
    const houkokuOverdue = ev.HoukokuDeadline && ev.HoukokuDeadline < today && (ev.ReportStatus || '') !== 'clc';
    const docsHtml = `
        <div class="doc-status-row">
            <span class="doc-status-name">許可願</span>
            <span class="doc-status-info">期限 <span class="tag-deadline ${kyokaOverdue ? 'deadline-past' : ''}">${escapeHtml(ev.KyokaDeadline || '---')}</span>
                ／ 担当 <strong>${escapeHtml(ev.AdminKyoka || '未定')}</strong></span>
            <select class="report-status-select status-${(ev.KyokaStatus || '') === 'submitted' ? 'clc' : 'none'}" data-doc="KyokaStatus" title="許可願の提出ステータスを変更">
                ${Object.keys(KYOKA_STATUS).map(v => `<option value="${v}" ${v === (ev.KyokaStatus || '') ? 'selected' : ''}>${KYOKA_STATUS[v].label}</option>`).join('')}
            </select>
        </div>
        <div class="doc-status-row">
            <span class="doc-status-name">報告書</span>
            <span class="doc-status-info">期限 <span class="tag-deadline ${houkokuOverdue ? 'deadline-past' : ''}">${escapeHtml(ev.HoukokuDeadline || '---')}</span>
                ／ 担当 <strong>${escapeHtml(ev.AdminHoukoku || '未定')}</strong></span>
            <select class="report-status-select status-${escapeAttr(ev.ReportStatus || 'none')}" data-doc="ReportStatus" title="報告書の提出ステータスを変更">
                ${Object.keys(REPORT_STATUS).map(v => `<option value="${v}" ${v === (ev.ReportStatus || '') ? 'selected' : ''}>${REPORT_STATUS[v].label}</option>`).join('')}
            </select>
        </div>`;

    // 集合・解散
    const gatherDismiss = (ev.GatherTime || ev.DismissTime)
        ? [ev.GatherTime && `集合 ${escapeHtml(ev.GatherTime)}`, ev.DismissTime && `解散 ${escapeHtml(ev.DismissTime)}`].filter(Boolean).join(' / ')
        : '---';

    const dateStr = `${escapeHtml(ev.Date)} (${dayOfWeekJP(ev.Date)})`
        + (ev.DateEnd && ev.DateEnd !== ev.Date ? ` 〜 ${escapeHtml(ev.DateEnd)} (${dayOfWeekJP(ev.DateEnd)})` : '');
    const timeStr = (ev.TimeStart && ev.TimeEnd) ? `${escapeHtml(ev.TimeStart)} 〜 ${escapeHtml(ev.TimeEnd)}` : '未定';

    box.innerHTML = `
        <div class="detail-head">
            <div class="detail-head-left">
                <span class="cat-badge" style="background:${cat.bg};color:${cat.text};">${cat.short}</span>
                ${seriesEvents.length > 1 ? `<span class="occ-badge">${occNum}回目 / 通算${seriesEvents.length}回</span>` : ''}
                ${isUpcoming ? '<span class="occ-badge occ-upcoming">開催予定</span>' : ''}
            </div>
            <div class="detail-head-actions">
                <a class="btn btn-secondary btn-sm" href="events.html?edit=${encodeURIComponent(ev.ID)}">編集</a>
                <a class="btn btn-secondary btn-sm" href="events.html?duplicate=${encodeURIComponent(ev.ID)}" title="この回の内容を引き継いで新しい開催を作る">複製して新規作成</a>
            </div>
        </div>
        ${checklistHtml}
        <table class="d1-table series-detail-table">
            <tr>
                <th style="width:140px;">${isMeeting ? 'ミーティング名' : 'イベント名'}</th>
                <td><span class="text-primary" style="font-size:1.15rem; font-weight:600;">${escapeHtml(displayTitle)}</span></td>
            </tr>
            <tr><th>日にち</th><td>${dateStr}</td></tr>
            <tr><th>時間</th><td>${timeStr}</td></tr>
            ${!isMeeting ? `<tr><th>集合・解散</th><td>${gatherDismiss}</td></tr>` : ''}
            <tr><th>場所</th><td>${ev.Location
                ? `${escapeHtml(ev.Location)} <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.Location)}" target="_blank" rel="noopener" class="series-map-link">&#x1F4CD; 地図</a>`
                : '---'}</td></tr>
            ${!isMeeting ? `<tr><th>対象・人数</th><td>${escapeHtml(ev.Audience || '---')}</td></tr>` : ''}
            ${!isMeeting ? `<tr><th>実験内容・発表者</th><td>${expHtml}</td></tr>` : ''}
            ${!isMeeting && ev.Logistics ? `<tr><th>スケジュール・運搬</th><td style="white-space:pre-wrap;">${escapeHtml(ev.Logistics)}</td></tr>` : ''}
            ${!isMeeting && ev.Accompany ? `<tr><th>帯同</th><td>${escapeHtml(ev.Accompany)}</td></tr>` : ''}
            <tr><th>${isMeeting ? '議題 / 備考' : '備考'}</th><td style="white-space:pre-wrap;">${escapeHtml(ev.Remarks || '---')}</td></tr>
            ${!isMeeting || files.length > 0 ? `<tr><th>関連ファイル</th><td class="file-list">${filesHtml}</td></tr>` : ''}
            ${!isMeeting ? `<tr><th>書類</th><td>${docsHtml}</td></tr>` : ''}
        </table>

        <div class="detail-section-card" id="series-detail-votes">
            <h3 class="detail-section-title">参加状況</h3>
            <div id="series-vote-summary" class="loading-text" style="padding:8px 0;">読み込み中</div>
            <a class="btn btn-secondary btn-sm" href="vote.html?id=${encodeURIComponent(ev.ID)}">投票ページを開く（回答・変更）</a>
        </div>

        <div class="detail-section-card" id="series-detail-feedback">
            <h3 class="detail-section-title">この回の振り返り</h3>
            <div class="e1-group">
                <label class="e1-label">良かった点</label>
                <textarea class="e1-input" id="series-fb-positives" rows="3" placeholder="会場・運営で良かったこと">${escapeHtml(ev.Positives || '')}</textarea>
            </div>
            <div class="e1-group">
                <label class="e1-label">改善点</label>
                <textarea class="e1-input" id="series-fb-reflections" rows="3" placeholder="会場・運営の改善点">${escapeHtml(ev.Reflections || '')}</textarea>
            </div>
            ${!isMeeting ? `
            <div id="series-exp-feedback">
                ${parts.filter(p => p.name).map(p => `
                    <div class="exp-fb-card" data-exp-name="${escapeAttr(p.name)}">
                        <div class="exp-fb-card-title">${expLinkHtml(p.name)} の振り返り（実験ページに蓄積されます）</div>
                        <div class="exp-fb-row">
                            <label>良かった点</label>
                            <textarea class="e1-input exp-fb-positive" rows="2" placeholder="この実験で良かったこと"></textarea>
                        </div>
                        <div class="exp-fb-row">
                            <label>改善点</label>
                            <textarea class="e1-input exp-fb-reflection" rows="2" placeholder="この実験の改善点"></textarea>
                        </div>
                    </div>`).join('')}
            </div>` : ''}
            <div style="margin-top:12px; text-align:right;">
                <button class="btn btn-primary-solid" style="width:auto; padding:8px 24px;" onclick="saveDetailFeedback()">振り返りを保存</button>
            </div>
        </div>
    `;

    // 書類ステータスの変更を保存
    box.querySelectorAll('.report-status-select[data-doc]').forEach(sel => {
        sel.addEventListener('change', () => saveDocStatus(ev.ID, sel.dataset.doc, sel.value));
    });

    renderVoteSummary(ev);
}

// ---- 参加状況（投票サマリー） ----

async function renderVoteSummary(ev) {
    const box = document.getElementById('series-vote-summary');
    if (!box) return;
    try {
        let votes = votesCache[ev.ID];
        if (!votes) {
            votes = await api.getEventVotes(ev.ID);
            votesCache[ev.ID] = votes;
        }
        // 描画中に開催回が切り替わっていたら何もしない
        if (currentEventId !== ev.ID) return;

        const counts = { attend: 0, absent: 0, undecided: 0 };
        const voted = new Set();
        votes.forEach(v => {
            if (counts[v.status] !== undefined) counts[v.status]++;
            voted.add(v.memberId);
        });

        // 未回答 = イベント年度の在籍メンバー − 回答済み
        const eventFY = getFiscalYear(ev.Date) || currentFiscalYear();
        const eligible = membersCache.filter(m => {
            if (m.Active === 'false') return false;
            const fy = m.FiscalYear ? parseInt(m.FiscalYear) : currentFiscalYear();
            return fy === eventFY;
        });
        const noAnswer = Math.max(0, eligible.length - voted.size);

        box.classList.remove('loading-text');
        box.innerHTML = `
            <div class="vote-mini-summary">
                <span class="vote-mini vote-mini-attend">参加 <strong>${counts.attend}</strong></span>
                <span class="vote-mini vote-mini-absent">不参加 <strong>${counts.absent}</strong></span>
                <span class="vote-mini vote-mini-undecided">未定 <strong>${counts.undecided}</strong></span>
                ${eligible.length > 0 ? `<span class="vote-mini vote-mini-noanswer">未回答 <strong>${noAnswer}</strong></span>` : ''}
            </div>`;
    } catch (_) {
        box.classList.remove('loading-text');
        box.innerHTML = '<span class="text-hint" style="font-size:0.85rem;">参加状況を取得できませんでした</span>';
    }
}

// ---- 書類ステータス・振り返りの保存（楽観的UI + 競合検知） ----

async function saveDocStatus(id, field, value) {
    const ev = allEventsData.find(e => e.ID === id);
    if (!ev) return;
    const prev = ev[field] || '';
    if (prev === value) return;

    ev[field] = value;
    api.saveCache('events', allEventsData);
    filterSeries();
    renderDetail();

    const def = field === 'KyokaStatus' ? KYOKA_STATUS : REPORT_STATUS;
    const docName = field === 'KyokaStatus' ? '許可願' : '報告書';
    try {
        const saved = await api.save('events', { ...ev, _baseUpdatedAt: ev.UpdatedAt || '' });
        Object.assign(ev, saved);
        api.saveCache('events', allEventsData);
        toast(`${docName}を「${(def[value] || def['']).label}」にしました`, 'success', 2000);
    } catch (e) {
        ev[field] = prev;
        filterSeries();
        renderDetail();
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 4000);
            init();
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    }
}

async function saveDetailFeedback() {
    const ev = currentEvent();
    if (!ev) return;

    const positives = document.getElementById('series-fb-positives')?.value || '';
    const reflections = document.getElementById('series-fb-reflections')?.value || '';

    try {
        const saved = await api.save('events', {
            ...ev, Positives: positives, Reflections: reflections,
            _baseUpdatedAt: ev.UpdatedAt || ''
        });
        const idx = allEventsData.findIndex(e => e.ID === ev.ID);
        if (idx >= 0) allEventsData[idx] = saved;
        api.saveCache('events', allEventsData);
        filterSeries();

        await saveExperimentFeedbackEntries(saved);

        toast('振り返りを保存しました', 'success');
        renderDetail();
        renderFeedbackTimeline();
        renderStats();
        renderOverview();
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 5000);
            init();
            return;
        }
        toast('保存失敗: ' + e.message, 'error');
    }
}

// 実験ごとの振り返りを、対応する実験レコード（Positives/Reflections の履歴JSON）へ追記する
async function saveExperimentFeedbackEntries(eventData) {
    const fbCards = document.querySelectorAll('#series-exp-feedback .exp-fb-card');
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

        if (posText) {
            const entries = parseFeedbackEntries(exp.Positives);
            entries.push({
                id: genFeedbackId(), date: eventData.Date || todayISO(),
                eventId: eventData.ID || '', eventTitle: eventData.Title || '', text: posText
            });
            exp.Positives = stringifyFeedbackEntries(entries);
        }
        if (refText) {
            const entries = parseFeedbackEntries(exp.Reflections);
            entries.push({
                id: genFeedbackId(), date: eventData.Date || todayISO(),
                eventId: eventData.ID || '', eventTitle: eventData.Title || '', text: refText
            });
            exp.Reflections = stringifyFeedbackEntries(entries);
        }

        try {
            const saved = await api.save('experiments', { ...exp, _baseUpdatedAt: exp.UpdatedAt || '' });
            const idx = experiments.findIndex(e => e.ID === exp.ID);
            if (idx >= 0) experiments[idx] = saved;
        } catch (e) {
            console.warn('Experiment feedback save failed for', expName, e);
        }
    }

    api.saveCache('experiments', experiments);
    experimentsCache = experiments;
}

// ---- 振り返りタイムラインタブ ----

function renderFeedbackTimeline() {
    const container = document.getElementById('series-feedback-timeline');

    const grouped = {};
    seriesEvents.forEach(ev => {
        const fy = getFiscalYear(ev.Date);
        const label = fy ? `${fy}年度` : '日付なし';
        const pos = (ev.Positives || '').trim();
        const ref = (ev.Reflections || '').trim();
        if (!pos && !ref) return;
        if (!grouped[label]) grouped[label] = [];
        grouped[label].push({ ev, pos, ref });
    });

    const fyKeys = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

    if (fyKeys.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:30px 20px;">振り返りはまだありません</div>';
        return;
    }

    container.innerHTML = fyKeys.map((fy, fyIdx) => {
        const items = grouped[fy];
        const isRecent = fyIdx < 2;

        const entries = [];
        items.forEach(({ ev, pos, ref }) => {
            if (pos && (seriesFbFilter === 'all' || seriesFbFilter === 'positive')) {
                entries.push({ type: 'positive', text: pos, date: ev.Date, id: ev.ID });
            }
            if (ref && (seriesFbFilter === 'all' || seriesFbFilter === 'reflection')) {
                entries.push({ type: 'reflection', text: ref, date: ev.Date, id: ev.ID });
            }
        });
        if (entries.length === 0) return '';

        return `<div class="fy-group">
            <div class="fy-header ${isRecent ? 'open' : ''}" onclick="this.classList.toggle('open'); this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.fy-toggle').innerHTML = this.classList.contains('open') ? '&#9660;' : '&#9654;';">
                <span class="fy-toggle">${isRecent ? '&#9660;' : '&#9654;'}</span>
                <span class="fy-label">${escapeHtml(fy)}</span>
                <span class="fy-count">${entries.length}件</span>
            </div>
            <div class="fy-body ${isRecent ? '' : 'hidden'}">
                ${entries.map(f => {
                    const isPos = f.type === 'positive';
                    return `<div class="sfb-entry ${isPos ? 'sfb-positive' : 'sfb-reflection'}">
                        <span class="sfb-icon">${isPos ? '&#9675;' : '&#9651;'}</span>
                        <span class="sfb-label">${isPos ? '良かった点' : '改善点'}</span>
                        <span class="sfb-text">${escapeHtml(f.text)}</span>
                        <button type="button" class="sfb-event-link" onclick="openOccurrence('${escapeAttr(f.id)}')">${escapeHtml(f.date)}</button>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }).join('');
}

function filterSeriesFb(type) {
    seriesFbFilter = type;
    document.querySelectorAll('[data-fb]').forEach(c =>
        c.classList.toggle('active', c.dataset.fb === type)
    );
    renderFeedbackTimeline();
}

// ---- 統計・開催履歴タブ ----

function renderStats() {
    const container = document.getElementById('series-stats');

    const expCount = {};
    const locations = [];
    let totalPos = 0;
    let totalRef = 0;

    seriesEvents.forEach(ev => {
        if (ev.Location) locations.push({ fy: getFiscalYear(ev.Date), loc: ev.Location });

        if (ev.Positives && ev.Positives.trim()) totalPos++;
        if (ev.Reflections && ev.Reflections.trim()) totalRef++;

        normalizeParts(ev.PartsList).forEach(it => {
            if (it.name) expCount[it.name] = (expCount[it.name] || 0) + 1;
        });
    });

    const topExps = Object.entries(expCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    const locHistory = locations
        .sort((a, b) => (a.fy || 0) - (b.fy || 0))
        .map(l => `${l.fy || '?'}年度: ${l.loc}`);

    let html = '<div class="series-stats-grid">';

    html += `<div class="stats-card">
        <h3 class="stats-card-title">開催回数</h3>
        <div class="stats-big-number">${seriesEvents.length}<span class="stats-unit">回</span></div>
    </div>`;

    html += `<div class="stats-card">
        <h3 class="stats-card-title">振り返り記入率</h3>
        <div class="stats-big-number">${seriesEvents.length > 0 ? Math.round(((totalPos + totalRef) / (seriesEvents.length * 2)) * 100) : 0}<span class="stats-unit">%</span></div>
        <p class="stats-detail">良かった点: ${totalPos}件 / 改善点: ${totalRef}件</p>
    </div>`;

    if (topExps.length > 0) {
        html += `<div class="stats-card stats-card-wide">
            <h3 class="stats-card-title">よく使われた実験</h3>
            <div class="stats-bar-chart">
                ${topExps.map(([name, count]) => {
                    const pct = Math.round((count / seriesEvents.length) * 100);
                    return `<div class="stats-bar-row">
                        <span class="stats-bar-label">${escapeHtml(name)}</span>
                        <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${pct}%;"></div></div>
                        <span class="stats-bar-value">${count}回</span>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }

    if (locHistory.length > 1) {
        html += `<div class="stats-card stats-card-wide">
            <h3 class="stats-card-title">場所の変遷</h3>
            <div class="stats-location-timeline">
                ${locHistory.map(l => `<span class="stats-loc-chip">${escapeHtml(l)}</span>`).join('<span class="stats-loc-arrow">&rarr;</span>')}
            </div>
        </div>`;
    }

    html += '</div>';
    container.innerHTML = html;
}

// 開催履歴（旧「概要」タブのカード。統計タブへ統合）
function renderOverview() {
    const container = document.getElementById('series-overview-list');

    container.innerHTML = seriesEvents.map((ev, idx) => {
        const fy = getFiscalYear(ev.Date);
        const fyLabel = fy ? `${fy}年度` : '';
        const isLatest = idx === 0;
        const cat = getEventCategory(ev.Category || 'normal');

        const expNames = [...new Set(normalizeParts(ev.PartsList).map(it => it.name).filter(Boolean))];
        const pos = (ev.Positives || '').trim();
        const ref = (ev.Reflections || '').trim();

        return `<div class="series-card ${isLatest ? 'series-card-latest' : ''}">
            <div class="series-card-header">
                <span class="series-fy-label">${escapeHtml(fyLabel)}${isLatest ? ' <span class="series-latest-tag">最新</span>' : ''}</span>
                <span class="cat-badge" style="background:${cat.bg};color:${cat.text};">${cat.short}</span>
            </div>
            <div class="series-card-body">
                <div class="series-card-meta">
                    <div><strong>${escapeHtml(ev.Date)}</strong> (${dayOfWeekJP(ev.Date)})${ev.DateEnd && ev.DateEnd !== ev.Date ? ` 〜 ${escapeHtml(ev.DateEnd)}` : ''}</div>
                    ${ev.Location ? `<div class="series-location-row">
                        <span>場所: ${escapeHtml(ev.Location)}</span>
                        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.Location)}" target="_blank" rel="noopener" class="series-map-link" onclick="event.stopPropagation();" title="Google Maps で開く">&#x1F4CD; 地図</a>
                    </div>` : ''}
                    ${ev.Audience ? `<div>対象: ${escapeHtml(ev.Audience)}</div>` : ''}
                    ${ev.TimeStart && ev.TimeEnd ? `<div>時間: ${escapeHtml(ev.TimeStart)} 〜 ${escapeHtml(ev.TimeEnd)}</div>` : ''}
                    ${ev.GatherTime ? `<div>集合: ${escapeHtml(ev.GatherTime)}${ev.DismissTime ? ` / 解散: ${escapeHtml(ev.DismissTime)}` : ''}</div>` : ''}
                    ${expNames.length > 0 ? `<div>実験: ${expNames.map(n => escapeHtml(n)).join(', ')}</div>` : ''}
                </div>
                ${pos || ref ? `<div class="series-card-feedback">
                    ${pos ? `<div class="sfb-entry sfb-positive"><span class="sfb-icon">&#9675;</span><span class="sfb-label">良</span><span class="sfb-text">${escapeHtml(pos)}</span></div>` : ''}
                    ${ref ? `<div class="sfb-entry sfb-reflection"><span class="sfb-icon">&#9651;</span><span class="sfb-label">改</span><span class="sfb-text">${escapeHtml(ref)}</span></div>` : ''}
                </div>` : ''}
                <button type="button" class="sfb-detail-link" onclick="openOccurrence('${escapeAttr(ev.ID)}')">この回の詳細を見る &rarr;</button>
            </div>
        </div>`;
    }).join('');
}

// ---- タブ切り替え ----

function switchSeriesTab(btn) {
    document.querySelectorAll('.expd-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.expd-tab-pane').forEach(p => {
        p.classList.toggle('hidden', p.dataset.tabPane !== target);
    });
}
