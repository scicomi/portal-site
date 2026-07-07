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
let indexFilter = 'event';   // 一覧モードのフィルタ: event / other / all（ミーティングは表示しない）
let membersCache = [];
let experimentsCache = [];
const votesCache = {};       // eventId -> votes[]
let scrollToFeedback = false;
let detailFbOpen = false;    // 「この回の振り返り」トグルの開閉状態（再描画をまたいで維持）

// 許可願・報告書の提出ステータス定義（config.js に集約）
const KYOKA_STATUS = CONFIG.KYOKA_STATUS;
const REPORT_STATUS = CONFIG.REPORT_STATUS;

// ---- イベント編集ウィザードのホスト実装 ----
// event-wizard.js の共通ウィザードをこのページ内で使う。
// このページのデータ（allEventsData）は GAS 正準形なので UI形と相互変換する。
window.EVENT_WIZARD_HOST = {
    getEvent(id) {
        const g = allEventsData.find(e => e.ID === id);
        return g ? gasToUi(g) : null;
    },
    snapshot() { return JSON.parse(JSON.stringify(allEventsData)); },
    applyOptimistic(itemUi) {
        const g = uiToGas(itemUi);
        const idx = allEventsData.findIndex(e => e.ID === g.ID);
        if (idx >= 0) allEventsData[idx] = g; else allEventsData.unshift(g);
        api.saveCache('events', allEventsData);
        this._rerender();
    },
    commitSaved(savedGas) {
        const idx = allEventsData.findIndex(e => e.ID === savedGas.ID);
        if (idx >= 0) allEventsData[idx] = savedGas;
        api.saveCache('events', allEventsData);
        this._rerender();
    },
    rollback(snap) {
        allEventsData.splice(0, allEventsData.length, ...snap);
        api.saveCache('events', allEventsData);
        this._rerender();
    },
    onConflict() { init(); },
    confirmDelete(id) { confirmDeleteSeriesEvent(id); },
    _rerender() {
        // タイトル変更でシリーズキーが変わることがあるため、選択中イベントから再導出する
        const ev = allEventsData.find(e => e.ID === currentEventId);
        if (ev) seriesKey = seriesKeyNormalize(ev);
        filterSeries();
        if (seriesEvents.length > 0) renderAll();
    }
};

// ウィザードの削除ボタンから呼ばれる削除フロー（一覧ページと同じ Undo つき）
function confirmDeleteSeriesEvent(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => confirmDeleteSeriesEvent(id));
        return;
    }
    const ev = allEventsData.find(e => e.ID === id);
    if (!ev) return;
    showConfirmDialog({
        title: `「${ev.Title || '(無題)'}」を削除`,
        message: 'この操作は元に戻せます（削除直後のみ）。',
        okLabel: '削除する',
        danger: true,
        onOk: () => executeDeleteSeriesEvent(id)
    });
}

async function executeDeleteSeriesEvent(id) {
    const idx = allEventsData.findIndex(e => e.ID === id);
    if (idx < 0) return;
    const backup = allEventsData[idx];

    allEventsData.splice(idx, 1);
    api.saveCache('events', allEventsData);

    try {
        await api.delete('events', id);
    } catch (e) {
        allEventsData.splice(idx, 0, backup);
        api.saveCache('events', allEventsData);
        toast('削除失敗: ' + e.message, 'error');
        return;
    }

    filterSeries();
    if (seriesEvents.length === 0) {
        // シリーズの最後の1回を消したら一覧モードへ戻る
        location.href = 'event-series.html';
        return;
    }
    if (currentEventId === id) currentEventId = '';
    renderAll();

    toastUndo(
        `「${backup.Title || '(無題)'}」を削除しました`,
        async () => {
            try {
                const saved = await api.save('events', backup);
                allEventsData.push(saved);
                api.saveCache('events', allEventsData);
                filterSeries();
                renderAll();
                toast('元に戻しました', 'success', 2000);
            } catch (e) {
                toast('復元に失敗しました: ' + e.message, 'error');
            }
        },
        () => {},
        5000
    );
}

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
    if (scrollToFeedback) detailFbOpen = true; // 未記入通知などから来たら折りたたみを開いておく
    indexMode = !seriesKey && !currentEventId;

    document.getElementById(indexMode ? 'series-index' : 'series-view').classList.remove('hidden');
    if (indexMode) document.title = 'イベント一覧 | SciComi Portal';

    loadAuxData(); // メンバー・実験は補助情報。裏で読み込み、揃い次第再描画する。

    // ページ内の編集ウィザード用の補助データ（祝日・担当/実験の入力候補）を裏で読み込む
    api.loadHolidaysCached().then(h => { holidaysData = h || {}; }).catch(() => {});
    populateDatalists();

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
        updateSyncStatus('error', null, e.message);
        // キャッシュも無い初回失敗時は「読み込み中」を残さず、エラー＋再試行を表示する
        const errorHtml = `<div class="empty-state">
            <div class="empty-text">データを読み込めませんでした</div>
            <div class="empty-hint">${escapeHtml(humanizeApiError(e))}</div>
            <button type="button" class="btn btn-secondary" onclick="init()">再読み込み</button>
        </div>`;
        if (indexMode) {
            if (allEventsData.length === 0) {
                document.getElementById('series-index-grid').innerHTML = errorHtml;
            }
        } else if (seriesEvents.length === 0) {
            const loading = document.getElementById('series-loading');
            loading.classList.remove('loading-text');
            loading.innerHTML = errorHtml;
        }
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
    document.querySelectorAll('.filter-chip[data-sidx]').forEach(c => {
        const isActive = c.dataset.sidx === f;
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });
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
        // ミーティング類はこのページでは扱わない（全部でもイベント＋その他のみ）
        if (s.category === 'general' || s.category === 'admin') return false;
        const isOther = s.category === 'other';
        if (indexFilter === 'event' && isOther) return false;
        if (indexFilter === 'other' && !isOther) return false;
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
        const hasNarrowing = q || indexFilter !== 'all';
        grid.innerHTML = `<div class="empty-state" style="padding:30px 20px;">
            <div class="empty-text">該当する催しはありません</div>
            ${hasNarrowing ? '<div class="empty-hint">検索キーワードや絞り込みを変更してみてください</div>' : ''}
        </div>`;
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
    // 年をまたぐシリーズがあるため年は残しつつ、コンパクトな表記にする
    const compactDate = (s) => {
        const p = String(s || '').split('-');
        return p.length < 3 ? (s || '') : `${p[0]}/${parseInt(p[1])}/${parseInt(p[2])}`;
    };
    const options = seriesEvents.map(ev => {
        const n = asc.findIndex(x => x.ID === ev.ID) + 1;
        const isUpcoming = (ev.DateEnd || ev.Date) >= today;
        const label = `${compactDate(ev.Date)}(${dayOfWeekJP(ev.Date)}) ${n}回目${isUpcoming ? '・予定' : ''}`;
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
            <button type="button" class="detail-checklist-link" onclick="openEventWizard('${escapeAttr(ev.ID)}')">編集して追記 &rarr;</button>
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
            <select class="report-status-select status-${docStatusClass(KYOKA_STATUS, ev.KyokaStatus || '')}" data-doc="KyokaStatus" title="許可願の提出ステータスを変更">
                ${Object.keys(KYOKA_STATUS).map(v => `<option value="${v}" ${v === (ev.KyokaStatus || '') ? 'selected' : ''}>${KYOKA_STATUS[v].label}</option>`).join('')}
            </select>
        </div>
        <div class="doc-status-row">
            <span class="doc-status-name">報告書</span>
            <span class="doc-status-info">期限 <span class="tag-deadline ${houkokuOverdue ? 'deadline-past' : ''}">${escapeHtml(ev.HoukokuDeadline || '---')}</span>
                ／ 担当 <strong>${escapeHtml(ev.AdminHoukoku || '未定')}</strong></span>
            <select class="report-status-select status-${docStatusClass(REPORT_STATUS, ev.ReportStatus || '')}" data-doc="ReportStatus" title="報告書の提出ステータスを変更">
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
                <button type="button" class="btn btn-secondary btn-sm" onclick="openEventWizard('${escapeAttr(ev.ID)}')">編集</button>
                <a class="btn btn-secondary btn-sm" href="events.html?duplicate=${encodeURIComponent(ev.ID)}" title="この回の内容を引き継いで新しい開催を作る">複製</a>
            </div>
        </div>
        ${checklistHtml}
        <table class="d1-table series-detail-table">
            <tr>
                <th style="width:140px;">${isMeeting ? 'ミーティング名' : 'イベント名'}</th>
                <td><span class="text-primary" style="font-size:1.15rem; font-weight:600;">${escapeHtml(displayTitle)}</span></td>
            </tr>
            <tr><th>日にち</th><td>${dateStr}</td></tr>
            ${ev.TimeStart && ev.TimeEnd ? `<tr><th>時間</th><td>${timeStr}</td></tr>` : ''}
            ${!isMeeting && (ev.GatherTime || ev.DismissTime) ? `<tr><th>集合・解散</th><td>${gatherDismiss}</td></tr>` : ''}
            ${ev.Location ? `<tr><th>場所</th><td>${escapeHtml(ev.Location)}</td></tr>` : ''}
            ${!isMeeting && ev.Audience ? `<tr><th>対象・人数</th><td>${escapeHtml(ev.Audience)}</td></tr>` : ''}
            ${!isMeeting && parts.length > 0 ? `<tr><th>実験内容・発表者</th><td>${expHtml}</td></tr>` : ''}
            ${!isMeeting && ev.Logistics ? `<tr><th>スケジュール・運搬</th><td style="white-space:pre-wrap;">${escapeHtml(ev.Logistics)}</td></tr>` : ''}
            ${!isMeeting && ev.Accompany ? `<tr><th>帯同</th><td>${escapeHtml(ev.Accompany)}</td></tr>` : ''}
            ${(ev.Remarks || '').trim() ? `<tr><th>${isMeeting ? '議題 / 備考' : '備考'}</th><td style="white-space:pre-wrap;">${escapeHtml(ev.Remarks)}</td></tr>` : ''}
            ${files.length > 0 ? `<tr><th>関連ファイル</th><td class="file-list">${filesHtml}</td></tr>` : ''}
            ${!isMeeting ? `<tr><th>書類</th><td>${docsHtml}</td></tr>` : ''}
        </table>

        <div class="detail-section-card" id="series-detail-votes">
            <h3 class="detail-section-title">参加状況</h3>
            <div id="series-vote-summary" class="loading-text" style="padding:8px 0;">読み込み中</div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button type="button" class="btn btn-primary btn-sm" onclick="openVoteListModal()">回答一覧</button>
                <a class="btn btn-secondary btn-sm" href="vote.html?id=${encodeURIComponent(ev.ID)}" title="投票ページで出欠を回答・変更する">回答する</a>
            </div>
        </div>

        <div class="detail-section-card" id="series-detail-feedback">
            <button type="button" class="detail-toggle-header" aria-expanded="${detailFbOpen}" aria-controls="series-fb-body" onclick="toggleDetailFeedback()">
                <span class="detail-section-title" style="margin:0;">この回の振り返り</span>
                <span class="fy-toggle" id="series-fb-arrow">${detailFbOpen ? '&#9660;' : '&#9654;'}</span>
            </button>
            <div id="series-fb-body" class="${detailFbOpen ? '' : 'hidden'}" style="margin-top:10px;">
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
                <div class="exp-fb-card">
                    <div class="exp-fb-card-title">会場・運営の振り返り</div>
                    <div class="exp-fb-row">
                        <label>良かった点</label>
                        <textarea class="e1-input" id="series-fb-positives" rows="3" placeholder="会場・運営で良かったこと">${escapeHtml(ev.Positives || '')}</textarea>
                    </div>
                    <div class="exp-fb-row">
                        <label>改善点</label>
                        <textarea class="e1-input" id="series-fb-reflections" rows="3" placeholder="会場・運営の改善点">${escapeHtml(ev.Reflections || '')}</textarea>
                    </div>
                </div>
                <div style="margin-top:12px; text-align:right;">
                    <button id="series-fb-save-btn" class="btn btn-primary-solid" style="width:auto; padding:8px 24px;" onclick="saveDetailFeedback()">振り返りを保存</button>
                </div>
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

// 出欠の回答・集計はコーディネーター・アドバイザーを対象外にする
function staffMemberIds() {
    return new Set(membersCache.filter(m => {
        const r = memberRoleOf(m);
        return r === 'アドバイザー' || r === 'コーディネーター';
    }).map(m => m.ID));
}

// イベント年度に在籍する出欠対象メンバー（コーディネーター・アドバイザー除く）
function voteEligibleMembers(ev, staffIds) {
    const eventFY = getFiscalYear(ev.Date) || currentFiscalYear();
    return membersCache.filter(m => {
        if (m.Active === 'false') return false;
        if (staffIds.has(m.ID)) return false;
        const fy = m.FiscalYear ? parseInt(m.FiscalYear) : currentFiscalYear();
        return fy === eventFY;
    });
}

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

        const staffIds = staffMemberIds();
        const counts = { attend: 0, absent: 0, undecided: 0 };
        const voted = new Set();
        votes.forEach(v => {
            if (staffIds.has(v.memberId)) return;
            if (counts[v.status] !== undefined) counts[v.status]++;
            voted.add(v.memberId);
        });

        // 未回答 = 出欠対象メンバー − 回答済み
        const eligible = voteEligibleMembers(ev, staffIds);
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

// 参加回答一覧ポップアップ（vote.html へ行かなくても誰が何と答えたか見られる）
async function openVoteListModal() {
    const ev = currentEvent();
    if (!ev) return;

    let votes = votesCache[ev.ID];
    if (!votes) {
        try {
            votes = await api.getEventVotes(ev.ID);
            votesCache[ev.ID] = votes;
        } catch (e) {
            toast('参加状況を取得できませんでした: ' + e.message, 'error');
            return;
        }
    }

    const staffIds = staffMemberIds();
    const nameOf = {};
    membersCache.forEach(m => { nameOf[m.ID] = m.Name || m.ID; });

    const grouped = { attend: [], absent: [], undecided: [] };
    const voted = new Set();
    votes.forEach(v => {
        if (staffIds.has(v.memberId)) return;
        if (grouped[v.status]) grouped[v.status].push(nameOf[v.memberId] || v.memberId);
        voted.add(v.memberId);
    });
    const noanswer = voteEligibleMembers(ev, staffIds)
        .filter(m => !voted.has(m.ID))
        .map(m => m.Name || m.ID);

    const sections = [
        { label: '参加',   type: 'attend',    names: grouped.attend },
        { label: '不参加', type: 'absent',    names: grouped.absent },
        { label: '未定',   type: 'undecided', names: grouped.undecided },
        { label: '未回答', type: 'noanswer',  names: noanswer }
    ];
    const sectionsHtml = sections.map(s => {
        if (s.names.length === 0) return '';
        const names = s.names.slice().sort((a, b) => a.localeCompare(b, 'ja'));
        return `<div class="vote-detail-group">
            <h4 class="vote-detail-label vote-detail-label-${s.type}">${s.label} (${s.names.length})</h4>
            <ul class="vote-detail-names">${names.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
        </div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content" style="max-width:520px;" role="dialog" aria-modal="true" aria-labelledby="vote-list-modal-title">
            <h2 id="vote-list-modal-title" style="margin-top:0;">参加回答一覧</h2>
            <p class="text-muted" style="font-size:0.85rem; margin:0 0 12px;">
                ${escapeHtml(ev.Title || '(無題)')} — ${escapeHtml(ev.Date)} (${dayOfWeekJP(ev.Date)})
            </p>
            ${sectionsHtml || '<p class="text-hint">まだ回答はありません</p>'}
            <div class="action-buttons" style="margin-top:16px;">
                <a class="btn btn-secondary" href="vote.html?id=${encodeURIComponent(ev.ID)}">回答する</a>
                <button type="button" class="btn btn-primary-solid" style="width:auto;" data-close>閉じる</button>
            </div>
        </div>`;

    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').addEventListener('click', close);
    bindOverlayClose(overlay, close);
    bindModalEscape(overlay, close);
    document.body.appendChild(overlay);
    trapFocus(overlay.querySelector('.modal-content'));
}

// 「この回の振り返り」の開閉（再描画せずDOMだけ切り替え、入力途中の文章を守る）
function toggleDetailFeedback() {
    detailFbOpen = !detailFbOpen;
    const body = document.getElementById('series-fb-body');
    const header = document.querySelector('#series-detail-feedback .detail-toggle-header');
    const arrow = document.getElementById('series-fb-arrow');
    if (body) body.classList.toggle('hidden', !detailFbOpen);
    if (header) header.setAttribute('aria-expanded', String(detailFbOpen));
    if (arrow) arrow.innerHTML = detailFbOpen ? '&#9660;' : '&#9654;';
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

    // 保存には複数リクエストが走ることがあるため、処理中表示＋二度押し防止
    const saveBtn = document.getElementById('series-fb-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

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
        // 成功時は renderDetail() でボタンごと再生成されるため、失敗時のみ元へ戻す
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '振り返りを保存'; }
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
            <button type="button" class="fy-header ${isRecent ? 'open' : ''}" aria-expanded="${isRecent}" onclick="this.classList.toggle('open'); this.setAttribute('aria-expanded', this.classList.contains('open')); this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.fy-toggle').innerHTML = this.classList.contains('open') ? '&#9660;' : '&#9654;';">
                <span class="fy-toggle">${isRecent ? '&#9660;' : '&#9654;'}</span>
                <span class="fy-label">${escapeHtml(fy)}</span>
                <span class="fy-count">${entries.length}件</span>
            </button>
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
    document.querySelectorAll('[data-fb]').forEach(c => {
        const isActive = c.dataset.fb === type;
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });
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
                    ${ev.Location ? `<div>場所: ${escapeHtml(ev.Location)}</div>` : ''}
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
