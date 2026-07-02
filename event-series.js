let seriesEvents = [];
let allEventsData = [];
let seriesKey = '';
let seriesFbFilter = 'all';

function seriesKeyNormalize(e) {
    const k = (e.SeriesKey && String(e.SeriesKey).trim()) || (e.Title || '');
    return k.replace(/\s+/g, '').replace(/^第\d+回/, '');
}

document.addEventListener('DOMContentLoaded', () => {
    bootPage('events', init);
});

async function init() {
    seriesKey = new URLSearchParams(location.search).get('key') || '';
    if (!seriesKey) {
        document.getElementById('series-loading').textContent = 'シリーズキーが指定されていません';
        return;
    }

    const cached = api.loadCache('events');
    if (cached && cached.items) {
        allEventsData = cached.items;
        filterSeries();
        if (seriesEvents.length > 0) {
            renderAll();
            updateSyncStatus('cached', cached.timestamp);
        }
    }

    try {
        allEventsData = await api.list('events');
        api.saveCache('events', allEventsData);
        filterSeries();
        if (seriesEvents.length === 0) {
            document.getElementById('series-loading').textContent = '該当するイベントシリーズが見つかりません';
            return;
        }
        renderAll();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (seriesEvents.length === 0) {
            document.getElementById('series-loading').textContent = 'データの読み込みに失敗しました';
        }
        updateSyncStatus('error', null, e.message);
    }
}

function filterSeries() {
    seriesEvents = allEventsData
        .filter(ev => seriesKeyNormalize(ev) === seriesKey && ev.Date)
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
}

function renderAll() {
    document.getElementById('series-loading').classList.add('hidden');
    document.getElementById('series-content').classList.remove('hidden');

    const title = seriesEvents[0].Title || seriesKey;
    const displayTitle = title.replace(/^第\d+回\s*/, '');
    document.getElementById('series-title').textContent = displayTitle;
    document.title = `${displayTitle} | SciComi Portal`;

    const years = seriesEvents.map(ev => ev.Date.slice(0, 4)).filter(Boolean);
    const earliest = Math.min(...years.map(Number));
    document.getElementById('series-subtitle').textContent =
        `通算${seriesEvents.length}回開催（${earliest}年〜）`;

    renderSafetyInfo();
    renderOverview();
    renderFeedbackTimeline();
    renderStats();
}

// ---- 緊急連絡先・現地情報 ----

function renderSafetyInfo() {
    const card = document.getElementById('series-safety-card');
    if (!card) return;

    // 最新イベントの情報を優先的に使う（フォールバックで過去イベントも探す）
    let info = null;
    for (const ev of seriesEvents) {
        if (ev.Address || ev.EmergencyHospital || ev.EmergencyPolice) {
            info = ev;
            break;
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

// ---- 概要タブ ----

function renderOverview() {
    const container = document.getElementById('series-overview-list');

    container.innerHTML = seriesEvents.map((ev, idx) => {
        const fy = getFiscalYear(ev.Date);
        const fyLabel = fy ? `${fy}年度` : '';
        const isLatest = idx === 0;
        const cat = getEventCategory(ev.Category || 'normal');

        // 新旧フォーマットの吸収は app.js の normalizeParts に一本化
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
                <a href="events.html?event=${encodeURIComponent(ev.ID)}" class="sfb-detail-link">イベント詳細を開く &rarr;</a>
            </div>
        </div>`;
    }).join('');
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
                entries.push({ type: 'positive', text: pos, date: ev.Date, title: ev.Title, id: ev.ID });
            }
            if (ref && (seriesFbFilter === 'all' || seriesFbFilter === 'reflection')) {
                entries.push({ type: 'reflection', text: ref, date: ev.Date, title: ev.Title, id: ev.ID });
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
                    const icon = isPos ? '&#9675;' : '&#9651;';
                    const cls = isPos ? 'sfb-positive' : 'sfb-reflection';
                    const label = isPos ? '良かった点' : '改善点';
                    return `<div class="sfb-entry ${cls}">
                        <span class="sfb-icon">${icon}</span>
                        <span class="sfb-label">${label}</span>
                        <span class="sfb-text">${escapeHtml(f.text)}</span>
                        <a href="events.html?event=${encodeURIComponent(f.id)}&tab=feedback" class="sfb-event-link">${escapeHtml(f.date)}</a>
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

// ---- 統計タブ ----

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

// ---- タブ切り替え ----

function switchSeriesTab(btn) {
    document.querySelectorAll('.expd-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.expd-tab-pane').forEach(p => {
        p.classList.toggle('hidden', p.dataset.tabPane !== target);
    });
}
