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
let indexStatusFilter = 'all'; // 開催状況フィルタ: all / upcoming（次回開催あり） / past（終了のみ）
let seriesPickMode = false;  // true の間、一覧のカードは開かず「複製して新規作成」の選択に使う
let membersCache = [];
let experimentsCache = [];
const votesCache = {};       // eventId -> votes[]
let votesPrimed = false;     // listAll で全投票を取得済みなら true（getEventVotes の個別往復を省く）
let scrollToFeedback = false;
let scrollToVotes = false;   // ?vote=1 で来たら参加状況カードへスクロール（共有リンク用）
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
    g.VoteDeadline = e.Vote_Deadline || '';
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
    scrollToVotes = params.get('vote') === '1'; // 出欠回答の共有リンク（旧 vote.html の代替）
    if (scrollToFeedback) detailFbOpen = true; // 未記入通知などから来たら折りたたみを開いておく
    indexMode = !seriesKey && !currentEventId;

    document.getElementById(indexMode ? 'series-index' : 'series-view').classList.remove('hidden');
    if (indexMode) {
        document.title = 'イベント別 | SciComi Portal';
        // 検索窓（デバウンス・サジェスト・キーボード操作は search.js が面倒を見る）
        attachSearchBox(document.getElementById('series-index-search'), {
            onSearch: () => renderSeriesIndex(),
            suggestSources: seriesSuggestSources,
            historyKey: 'series'
        });
    }

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
        // listAll で events / members / experiments / votes を1往復で取得する
        const all = await api.listAll();
        allEventsData = all.events || [];
        api.saveCache('events', allEventsData);
        if (all.members) { membersCache = all.members; api.saveCache('members', membersCache); }
        if (all.experiments) { experimentsCache = all.experiments; api.saveCache('experiments', experimentsCache); }
        if (Array.isArray(all.votes)) {
            primeVotesCache(all.votes);
            api.saveCache('votes', all.votes);
        }
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
                document.getElementById('series-index-tbody').innerHTML = `<tr><td colspan="4">${errorHtml}</td></tr>`;
            }
        } else if (seriesEvents.length === 0) {
            const loading = document.getElementById('series-loading');
            loading.classList.remove('loading-text');
            loading.innerHTML = errorHtml;
        }
    }
}

function loadAuxData() {
    // メンバー・実験・投票はキャッシュから即時反映する。最新は init() の listAll が一括で持ってくる。
    membersCache = ((api.loadCache('members') || {}).items) || [];
    experimentsCache = ((api.loadCache('experiments') || {}).items) || [];
    const cachedVotes = api.loadCache('votes');
    if (cachedVotes && Array.isArray(cachedVotes.items)) primeVotesCache(cachedVotes.items);
    // 実験リンク・未回答数の表示が変わるので、詳細を描画済みなら再描画
    if (!indexMode && seriesEvents.length > 0) renderDetail();
}

// listAll / キャッシュで受け取った全投票を eventId ごとに votesCache へ展開する。
// これ以降は getEventVotes の個別取得を行わない（votesPrimed）。
function primeVotesCache(votes) {
    Object.keys(votesCache).forEach(k => delete votesCache[k]);
    (votes || []).forEach(v => {
        (votesCache[v.eventId] || (votesCache[v.eventId] = [])).push(v);
    });
    votesPrimed = true;
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

function onSeriesIndexStatusFilter(v) {
    indexStatusFilter = v;
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
            latestId: latest.ID,
            latestDate: latest.Date,
            next,
            category: latest.Category || 'normal',
            location: latest.Location || ''
        };
    });
}

// サジェスト候補（イベント名・場所）。ミーティング類はこのページでは扱わないので除く。
function seriesSuggestSources() {
    const titles = new Set(), locations = new Set();
    buildSeriesIndex().forEach(s => {
        if (s.category === 'general' || s.category === 'admin') return;
        if (s.title) titles.add(s.title);
        if (s.location) locations.add(s.location);
    });
    return [
        { label: 'イベント', values: [...titles] },
        { label: '場所', values: [...locations] }
    ];
}

function renderSeriesIndex() {
    const tbody = document.getElementById('series-index-tbody');
    if (!tbody) return;
    // かな・全角半角の揺れ吸収 + AND/-除外/"フレーズ" で照合する（search.js）
    const pq = parseSearchQuery(document.getElementById('series-index-search')?.value || '');

    let list = buildSeriesIndex();
    list = list.filter(s => {
        // ミーティング類はこのページでは扱わない（全部でもイベント＋その他のみ）
        if (s.category === 'general' || s.category === 'admin') return false;
        const isOther = s.category === 'other';
        if (indexFilter === 'event' && isOther) return false;
        if (indexFilter === 'other' && !isOther) return false;
        if (indexStatusFilter === 'upcoming' && !s.next) return false;
        if (indexStatusFilter === 'past' && s.next) return false;
        if (pq && !matchesParsedQuery(searchNormalize(s.title + ' ' + s.location), pq)) return false;
        return true;
    });
    if (pq) announceSearchResult(`検索結果 ${list.length}件`);

    // 次回開催が近いものを先頭に、あとは直近開催が新しい順
    list.sort((a, b) => {
        if (a.next && b.next) return a.next.Date.localeCompare(b.next.Date);
        if (a.next) return -1;
        if (b.next) return 1;
        return (b.latestDate || '').localeCompare(a.latestDate || '');
    });

    if (list.length === 0) {
        const hasNarrowing = pq || indexFilter !== 'all' || indexStatusFilter !== 'all';
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state">
            <div class="empty-text">該当する催しはありません</div>
            ${hasNarrowing ? '<div class="empty-hint">検索キーワードや絞り込みを変更してみてください</div>' : ''}
        </td></tr>`;
        return;
    }

    // 検索中はマッチ部分をハイライト表示（search.js の highlightText は escape 込み）
    const hlTerms = pq ? searchQueryTerms(pq) : [];
    const hl = v => pq ? highlightText(v, hlTerms) : escapeHtml(v);
    tbody.innerHTML = list.map(s => {
        const cat = getEventCategory(s.category);
        return `
            <tr class="clickable-row${s.next ? ' row-has-next' : ''}" data-key="${escapeAttr(s.key)}" data-latest-id="${escapeAttr(s.latestId)}" title="${seriesPickMode ? 'タップでこのイベントを複製' : 'タップで詳細ページへ'}">
                <td><span class="cat-dot" style="color:${cat.bg};" title="${cat.short}">&#9679;</span></td>
                <td class="cell-name">${hl(s.title)}</td>
                <td style="white-space:nowrap;"><span class="count-chip">${s.count}回</span></td>
                <td style="white-space:nowrap;">${s.next
                    ? `<span class="series-index-next">次回 ${escapeHtml(s.next.Date)} (${dayOfWeekJP(s.next.Date)})</span>`
                    : `<span class="text-muted">直近 ${escapeHtml(s.latestDate || '---')}</span>`}</td>
            </tr>
        `;
    }).join('');

    // 検索・フィルタで毎回作り直すため、ハンドラは都度上書き（addEventListener の重複登録を避ける）
    tbody.onclick = (e) => {
        const row = e.target.closest('tr[data-key]');
        if (!row) return;
        if (seriesPickMode) { onSeriesDupSelect(row.dataset.latestId); return; }
        location.href = `event-series.html?key=${encodeURIComponent(row.dataset.key)}`;
    };
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

    // ミーティングでは不要なタブを隠す（振り返り・会場・履歴統計はイベント向けの機能）
    const ev0 = currentEvent();
    const isMtg = ev0 && (ev0.Category === 'general' || ev0.Category === 'admin');
    document.querySelectorAll('.scope-tab[data-tab="reflection"], .scope-tab[data-tab="venue"], .scope-tab[data-tab="history"]').forEach(t => {
        t.style.display = isMtg ? 'none' : '';
    });
    // ゾーン全体が空になるなら見出しと区切りも隠す
    document.querySelector('.scope-zone--series')?.style.setProperty('display', isMtg ? 'none' : '');
    document.querySelector('.scope-sep')?.style.setProperty('display', isMtg ? 'none' : '');
    // 隠したタブが選択されたままにならないよう、概要へ戻す
    if (isMtg && document.querySelector('.scope-tab.active')?.dataset.zone !== 'occ') {
        activateSeriesTab('summary');
    }

    renderHeaderActions();
    renderSafetyInfo();
    renderScopeContext();
    renderDetail();
    updateScopeBadges();
    if (!isMtg) {
        renderFeedbackTimeline();
        renderStats();
        renderOverview();
    }

    if (scrollToFeedback && !isMtg) {
        scrollToFeedback = false;
        setTimeout(() => activateSeriesTab('reflection'), 150);
    }
    if (scrollToVotes) {
        scrollToVotes = false;
        setTimeout(() => {
            activateSeriesTab('attendance');
            // 「出欠を回答」リンクから来た場合は折りたたみを開いた状態にする
            setTimeout(() => {
                const toggleBtn = document.querySelector('#series-detail-votes .detail-toggle-header');
                if (toggleBtn && toggleBtn.getAttribute('aria-expanded') !== 'true') toggleBtn.click();
            }, 100);
        }, 150);
    }
}

// ヘッダーカードの編集・複製ボタン（選択中の開催回に対する操作）
function renderHeaderActions() {
    const box = document.getElementById('series-header-actions');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }
    box.innerHTML = `
        <button type="button" class="btn btn-secondary btn-sm" onclick="openEventWizard('${escapeAttr(ev.ID)}')">編集</button>
        <a class="btn btn-secondary btn-sm" href="events.html?duplicate=${encodeURIComponent(ev.ID)}" title="この回の内容を引き継いで新しい開催を作る">複製</a>
    `;
}

function currentEvent() {
    return seriesEvents.find(e => e.ID === currentEventId) || seriesEvents[0];
}

// 年をまたぐシリーズがあるため年は残しつつ、コンパクトな表記にする
function compactOccDate(s) {
    const p = String(s || '').split('-');
    return p.length < 3 ? (s || '') : `${p[0]}/${parseInt(p[1])}/${parseInt(p[2])}`;
}

// タブ直下の対象範囲バー。いま「この回」を見ているのか「シリーズ全体」を見ているのかを常に示す。
function renderScopeContext() {
    const box = document.getElementById('series-scope-ctx');
    if (!box) return;
    const zone = document.querySelector('.scope-tab.active')?.dataset.zone || 'occ';
    box.classList.toggle('scope-ctx--series', zone === 'series');

    if (zone === 'series') {
        const years = seriesEvents.map(e => (e.Date || '').slice(0, 4)).filter(Boolean).sort();
        const span = years.length === 0 ? ''
            : years[0] === years[years.length - 1] ? `${years[0]}年`
            : `${years[0]}年 〜 ${years[years.length - 1]}年`;
        box.innerHTML = `
            <span class="scope-ctx-label"><span class="scope-ctx-dot" aria-hidden="true"></span>全 ${seriesEvents.length} 回を対象に表示中</span>
            ${span ? `<span class="scope-ctx-sub">${escapeHtml(span)}</span>` : ''}`;
        return;
    }

    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }
    const today = todayISO();
    const asc = seriesEvents.slice().sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
    const idx = asc.findIndex(x => x.ID === ev.ID);
    const isUpcoming = (ev.DateEnd || ev.Date) >= today;

    const options = asc.slice().reverse().map(e => {
        const n = asc.findIndex(x => x.ID === e.ID) + 1;
        const up = (e.DateEnd || e.Date) >= today;
        const label = `${n}回目　${compactOccDate(e.Date)}(${dayOfWeekJP(e.Date)})${up ? '・予定' : ''}`;
        return `<option value="${escapeAttr(e.ID)}" ${e.ID === currentEventId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');

    // ‹ は1つ古い回、› は1つ新しい回。端では無効化する。
    const navBtn = (step, glyph, title) => {
        const t = asc[idx + step];
        return `<button type="button" class="scope-ctx-nav" title="${title}" aria-label="${title}"
            ${t ? `onclick="selectOccurrence('${escapeAttr(t.ID)}')"` : 'disabled'}>${glyph}</button>`;
    };

    box.innerHTML = `
        ${seriesEvents.length > 1 ? navBtn(-1, '&lsaquo;', '前の回') : ''}
        <span class="scope-ctx-cur">
            ${escapeHtml(compactOccDate(ev.Date))}（${dayOfWeekJP(ev.Date)}）
            <small>${idx + 1}回目${isUpcoming ? '・開催予定' : ''}</small>
        </span>
        ${seriesEvents.length > 1 ? navBtn(1, '&rsaquo;', '次の回') : ''}
        ${seriesEvents.length > 1 ? `<select class="scope-ctx-select" aria-label="開催回を選ぶ" onchange="selectOccurrence(this.value)">${options}</select>` : ''}`;
}

function selectOccurrence(id) {
    if (!seriesEvents.some(e => e.ID === id)) return;
    currentEventId = id;
    history.replaceState(null, '', `event-series.html?key=${encodeURIComponent(seriesKey)}&event=${encodeURIComponent(id)}`);
    renderHeaderActions();
    renderSafetyInfo();
    renderScopeContext();
    renderDetail();
    updateScopeBadges();
    // 開いているタブだけ描き直す（「シリーズ全体」側は開催回に依存しないので触らない）
    const active = document.querySelector('.scope-tab.active')?.dataset.tab;
    if (active === 'attendance') renderAttendanceTab();
    if (active === 'reflection') { renderReflectionTab(); renderResultsTab(); }
}

// 統計・振り返りタブから特定の開催回の詳細へ飛ぶ
function openOccurrence(id) {
    selectOccurrence(id);
    activateSeriesTab('summary');
    const detail = document.getElementById('series-detail');
    if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// タブ上の未処理バッジ（概要=未提出の書類数 / 出欠=未回答者数）。
// 投票は listAll で先読み済みの時だけ数える（バッジのために通信を増やさない）。
function updateScopeBadges() {
    const ev = currentEvent();
    const set = (id, n) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = n || '';
        el.classList.toggle('hidden', !n);
    };
    if (!ev) { set('scope-badge-summary', 0); set('scope-badge-attendance', 0); return; }

    const isMeeting = ev.Category === 'general' || ev.Category === 'admin';
    let docs = 0;
    if (!isMeeting) {
        if (!ev.KyokaNotRequired && (ev.KyokaStatus || '') !== 'submitted') docs++;
        if (!ev.HoukokuNotRequired && (ev.ReportStatus || '') !== 'clc') docs++;
    }
    set('scope-badge-summary', docs);

    const votes = votesCache[ev.ID] || (votesPrimed ? [] : null);
    if (!votes || membersCache.length === 0) { set('scope-badge-attendance', 0); return; }
    const staffIds = voteStaffIds(membersCache);
    const answered = new Set(votes.filter(v => !staffIds.has(v.memberId)).map(v => v.memberId));
    const pending = voteEligibleMembers(membersCache, ev).filter(m => !answered.has(m.ID)).length;
    set('scope-badge-attendance', pending);
}

// ---- 会場情報・緊急連絡先 ----

// 選択中の開催回を優先し、無ければ同シリーズの他の回から補完する
function findSafetyInfo() {
    const cur = currentEvent();
    if (cur && (cur.Address || cur.PostalCode || cur.LocationTel || cur.EmergencyHospital || cur.EmergencyPolice)) return cur;
    for (const ev of seriesEvents) {
        if (ev.Address || ev.PostalCode || ev.LocationTel || ev.EmergencyHospital || ev.EmergencyPolice) return ev;
    }
    return null;
}

function renderSafetyInfo() {
    const card = document.getElementById('series-safety-card');
    const grid = document.getElementById('series-safety-grid');
    if (!card || !grid) return;
    card.classList.remove('hidden');

    const info = findSafetyInfo();
    const ev = currentEvent();
    const venueName = (ev && ev.Location) || '---';

    grid.innerHTML = `
        <div>
            <div class="series-safety-group-title series-safety-group-title--plain">活動場所</div>
            <table class="d1-table series-safety-table">
                <tr><th>施設名</th><td>${escapeHtml(venueName)}</td></tr>
                <tr><th>郵便番号</th><td>${info && info.PostalCode ? escapeHtml(info.PostalCode) : '---'}</td></tr>
                <tr><th>住所</th><td>${info && info.Address ? escapeHtml(info.Address) : '---'}</td></tr>
                <tr><th>連絡先</th><td>${info ? formatTelLink(info.LocationTel) : '---'}</td></tr>
            </table>
        </div>
        <div>
            <div class="series-safety-group-title">緊急連絡先</div>
            <div class="series-safety-group">
                <div class="series-safety-item">
                    <span class="series-safety-label">&#x1F46E; 警察署</span>
                    <span class="series-safety-value">${info ? formatTelLink(info.EmergencyPolice) : '---'}</span>
                </div>
                <div class="series-safety-item">
                    <span class="series-safety-label">&#x1F3E5; 病院・診療所</span>
                    <span class="series-safety-value">${info ? formatTelLink(info.EmergencyHospital) : '---'}</span>
                </div>
            </div>
        </div>
    `;
}

// ---- 会場情報のインライン編集（実験ネタページのセクション編集と同じパターン） ----

function editSafetyInfo() {
    const grid = document.getElementById('series-safety-grid');
    if (!grid) return;
    const info = findSafetyInfo() || {};

    grid.innerHTML = `
        <div class="series-safety-edit-group">
            <div class="series-safety-group-title series-safety-group-title--plain">活動場所</div>
            <div class="e1-group">
                <label class="e1-label">郵便番号</label>
                <input id="series-safety-postal-input" class="e1-input" type="text" value="${escapeAttr(info.PostalCode || '')}" placeholder="例: 017-0897" inputmode="numeric">
            </div>
            <div class="e1-group">
                <label class="e1-label">住所</label>
                <input id="series-safety-address-input" class="e1-input" type="text" value="${escapeAttr(info.Address || '')}" placeholder="住所（例: 秋田県大館市桜町1-1）">
            </div>
            <div class="e1-group">
                <label class="e1-label">連絡先（Tel）</label>
                <input id="series-safety-tel-input" class="e1-input" type="text" value="${escapeAttr(info.LocationTel || '')}" placeholder="例: 03-1234-5678">
            </div>
        </div>
        <div class="series-safety-edit-group">
            <div class="series-safety-group-title">緊急連絡先</div>
            <div class="e1-group">
                <label class="e1-label">警察署</label>
                <input id="series-safety-police-input" class="e1-input" type="text" value="${escapeAttr(info.EmergencyPolice || '')}" placeholder="○○警察署：018-852-4100">
            </div>
            <div class="e1-group">
                <label class="e1-label">病院・診療所</label>
                <input id="series-safety-hospital-input" class="e1-input" type="text" value="${escapeAttr(info.EmergencyHospital || '')}" placeholder="○○診療所：0186-45-0223">
            </div>
        </div>
        <div class="action-buttons">
            <button type="button" class="btn btn-text" onclick="renderSafetyInfo()">キャンセル</button>
            <button type="button" class="btn btn-primary-solid" style="width:auto;" onclick="saveSafetyInfo()">保存</button>
        </div>
    `;
}

async function saveSafetyInfo() {
    const ev = currentEvent();
    if (!ev) return;
    const postalCode = document.getElementById('series-safety-postal-input')?.value.trim() || '';
    const address = document.getElementById('series-safety-address-input')?.value.trim() || '';
    const tel = document.getElementById('series-safety-tel-input')?.value.trim() || '';
    const hospital = document.getElementById('series-safety-hospital-input')?.value.trim() || '';
    const police = document.getElementById('series-safety-police-input')?.value.trim() || '';

    try {
        const saved = await api.save('events', {
            ...ev, PostalCode: postalCode, Address: address, LocationTel: tel, EmergencyHospital: hospital, EmergencyPolice: police,
            _baseUpdatedAt: ev.UpdatedAt || ''
        });
        const idx = allEventsData.findIndex(e => e.ID === ev.ID);
        if (idx >= 0) allEventsData[idx] = saved;
        api.saveCache('events', allEventsData);
        filterSeries();
        toast('会場情報を保存しました', 'success');
        renderSafetyInfo();
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 4000);
            init();
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    }
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
        if (!ev.KyokaNotRequired && !ev.AdminKyoka) miss.push('許可願の担当');
        if (!ev.HoukokuNotRequired && !ev.AdminHoukoku) miss.push('報告書の担当');
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
    const today = todayISO();
    const isUpcoming = (ev.DateEnd || ev.Date) >= today;

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
            ${ev.KyokaNotRequired
                ? '<span class="doc-status-info text-muted">不要</span>'
                : `<span class="doc-status-info">期限 <span class="tag-deadline ${kyokaOverdue ? 'deadline-past' : ''}">${escapeHtml(ev.KyokaDeadline || '---')}</span>
                ／ 担当 <strong>${escapeHtml(ev.AdminKyoka || '未定')}</strong></span>
            <select class="report-status-select status-${docStatusClass(KYOKA_STATUS, ev.KyokaStatus || '')}" data-doc="KyokaStatus" title="許可願の提出ステータスを変更">
                ${Object.keys(KYOKA_STATUS).map(v => `<option value="${v}" ${v === (ev.KyokaStatus || '') ? 'selected' : ''}>${KYOKA_STATUS[v].label}</option>`).join('')}
            </select>`}
        </div>
        <div class="doc-status-row">
            <span class="doc-status-name">報告書</span>
            ${ev.HoukokuNotRequired
                ? '<span class="doc-status-info text-muted">不要</span>'
                : `<span class="doc-status-info">期限 <span class="tag-deadline ${houkokuOverdue ? 'deadline-past' : ''}">${escapeHtml(ev.HoukokuDeadline || '---')}</span>
                ／ 担当 <strong>${escapeHtml(ev.AdminHoukoku || '未定')}</strong></span>
            <select class="report-status-select status-${docStatusClass(REPORT_STATUS, ev.ReportStatus || '')}" data-doc="ReportStatus" title="報告書の提出ステータスを変更">
                ${Object.keys(REPORT_STATUS).map(v => `<option value="${v}" ${v === (ev.ReportStatus || '') ? 'selected' : ''}>${REPORT_STATUS[v].label}</option>`).join('')}
            </select>`}
        </div>`;

    // 集合・解散
    const gatherDismiss = (ev.GatherTime || ev.DismissTime)
        ? [ev.GatherTime && `集合 ${escapeHtml(ev.GatherTime)}`, ev.DismissTime && `解散 ${escapeHtml(ev.DismissTime)}`].filter(Boolean).join(' / ')
        : '---';

    const dateStr = `${escapeHtml(ev.Date)} (${dayOfWeekJP(ev.Date)})`
        + (ev.DateEnd && ev.DateEnd !== ev.Date ? ` 〜 ${escapeHtml(ev.DateEnd)} (${dayOfWeekJP(ev.DateEnd)})` : '');
    const timeStr = (ev.TimeStart && ev.TimeEnd) ? `${escapeHtml(ev.TimeStart)} 〜 ${escapeHtml(ev.TimeEnd)}` : '未定';

    box.innerHTML = `
        ${checklistHtml}
        <table class="d1-table series-detail-table">
            <tr>
                <th style="width:108px;">${isMeeting ? 'ミーティング名' : 'イベント名'}</th>
                <td><span class="text-primary" style="font-size:1.15rem; font-weight:600;">${escapeHtml(displayTitle)}</span></td>
            </tr>
            ${!isMeeting && ev.PlanName ? `<tr><th>企画名</th><td>${escapeHtml(ev.PlanName)}</td></tr>` : ''}
            <tr><th>日にち</th><td>${dateStr}${isUpcoming ? ' <span class="occ-badge occ-upcoming">開催予定</span>' : ''}</td></tr>
            ${ev.TimeStart && ev.TimeEnd ? `<tr><th>時間</th><td>${timeStr}</td></tr>` : ''}
            ${!isMeeting && (ev.GatherTime || ev.DismissTime) ? `<tr><th>集合・解散</th><td>${gatherDismiss}</td></tr>` : ''}
            ${ev.Location ? `<tr><th>場所</th><td><span class="exp-link-inline" style="cursor:pointer;" onclick="goToVenueInfoTab()" title="会場情報タブへ">${escapeHtml(ev.Location)}</span></td></tr>` : ''}
            ${ev.Audience ? `<tr><th>${isMeeting ? '参加メンバー' : '対象・人数'}</th><td>${escapeHtml(ev.Audience)}</td></tr>` : ''}
            ${!isMeeting && parts.length > 0 ? `<tr><th>実験内容・発表者</th><td>${expHtml}</td></tr>` : ''}
            ${!isMeeting && ev.Logistics ? `<tr><th>スケジュール・運搬</th><td style="white-space:pre-wrap;">${escapeHtml(ev.Logistics)}</td></tr>` : ''}
            ${!isMeeting && ev.Accompany ? `<tr><th>帯同</th><td>${renderAccompanyHtml(ev.Accompany)}</td></tr>` : ''}
            ${(ev.Remarks || '').trim() ? `<tr><th>${isMeeting ? '議題 / 備考' : '備考'}</th><td style="white-space:pre-wrap;">${escapeHtml(ev.Remarks)}</td></tr>` : ''}
            ${files.length > 0 ? `<tr><th>関連ファイル</th><td class="file-list">${filesHtml}</td></tr>` : ''}
            ${!isMeeting ? `<tr class="series-detail-docs-row"><th>書類</th><td>${docsHtml}</td></tr>` : ''}
        </table>
        ${!isMeeting ? `
        <div class="post-event-card">
            <h3 class="post-event-title">イベント後に記入</h3>
            <table class="d1-table post-event-table">
                <tr>
                    <th>来場者数</th>
                    <td><input type="number" min="0" class="e1-input post-event-input" data-pe-field="VisitorCount"
                        value="${escapeAttr(ev.VisitorCount || '')}" placeholder="未記入" title="この回の来場者数"></td>
                </tr>
                <tr>
                    <th>参加メンバー数</th>
                    <td><input type="number" min="0" class="e1-input post-event-input" data-pe-field="ParticipantCount"
                        value="${escapeAttr(ev.ParticipantCount || '')}" placeholder="未記入" title="この回に参加したメンバーの人数"></td>
                </tr>
            </table>
            <div id="post-event-pr" class="post-event-pr"></div>
        </div>` : ''}
    `;

    // 書類ステータスの変更を保存
    box.querySelectorAll('.report-status-select[data-doc]').forEach(sel => {
        sel.addEventListener('change', () => saveDocStatus(ev.ID, sel.dataset.doc, sel.value));
    });
    // イベント後の実績（来場者数・参加メンバー数）はその場で編集→即保存
    box.querySelectorAll('.post-event-input[data-pe-field]').forEach(input => {
        input.addEventListener('change', () => savePostEventField(ev.ID, input.dataset.peField, input.value.trim()));
    });
    renderPrAssignments(ev);
}

function renderPrAssignments(ev) {
    const container = document.getElementById('post-event-pr');
    if (!container) return;
    const channels = CONFIG.PR_CHANNELS || [];
    if (!channels.length) { container.innerHTML = ''; return; }
    const assignments = ev.PrAssignments || {};
    container.innerHTML = `
        <div class="post-event-pr-title">広報担当</div>
        ${channels.map(ch => `<div class="pr-row">
            <span class="pr-label">${escapeHtml(ch)}</span>
            <input type="text" class="e1-input pr-input" data-pr-channel="${escapeAttr(ch)}" list="member-datalist"
                value="${escapeAttr(assignments[ch] || '')}" placeholder="なし">
        </div>`).join('')}
    `;
    container.querySelectorAll('.pr-input[data-pr-channel]').forEach(input => {
        input.addEventListener('change', () => savePrField(ev.ID, input.dataset.prChannel, input.value.trim()));
    });
}

async function savePrField(id, channel, value) {
    const ev = allEventsData.find(e => e.ID === id);
    if (!ev) return;
    const prev = ev.PrAssignments ? { ...ev.PrAssignments } : {};
    if (!ev.PrAssignments) ev.PrAssignments = {};
    if ((ev.PrAssignments[channel] || '') === value) return;
    ev.PrAssignments[channel] = value;
    api.saveCache('events', allEventsData);
    try {
        const saved = await api.save('events', { ...ev, _baseUpdatedAt: ev.UpdatedAt || '' });
        Object.assign(ev, saved);
        api.saveCache('events', allEventsData);
        toast('広報担当を保存しました', 'success', 2000);
    } catch (e) {
        ev.PrAssignments = prev;
        renderDetail();
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 4000);
            init();
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    }
}

// 「イベント後に記入」欄の保存（楽観的更新。失敗時は元の値へ戻す）
async function savePostEventField(id, field, value) {
    const ev = allEventsData.find(e => e.ID === id);
    if (!ev) return;
    const prev = ev[field] || '';
    if (prev === value) return;

    ev[field] = value;
    api.saveCache('events', allEventsData);

    const label = field === 'VisitorCount' ? '来場者数' : '参加メンバー数';
    try {
        const saved = await api.save('events', { ...ev, _baseUpdatedAt: ev.UpdatedAt || '' });
        Object.assign(ev, saved);
        api.saveCache('events', allEventsData);
        toast(`${label}を保存しました`, 'success', 2000);
    } catch (e) {
        ev[field] = prev;
        renderDetail();
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 4000);
            init();
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    }
}

// ---- 参加状況（出欠のインライン回答＋サマリー。vote-widget.js の共通実装を使う） ----

// このイベントの投票を取得する（listAll で取得済みならキャッシュ、未取得なら個別取得）
async function loadEventVotes(ev) {
    let votes = votesCache[ev.ID];
    if (!votes) {
        if (votesPrimed) {
            votes = votesCache[ev.ID] = []; // 全件取得済みで無い = このイベントの回答は0件
        } else {
            votes = await api.getEventVotes(ev.ID);
            votesCache[ev.ID] = votes;
        }
    }
    return votes;
}

// 参加回答一覧ポップアップ（日時・メモつき。実装は vote-widget.js の showVoteListModal）
async function openVoteListModal() {
    const ev = currentEvent();
    if (!ev) return;
    let votes;
    try {
        votes = await loadEventVotes(ev);
    } catch (e) {
        toast('参加状況を取得できませんでした: ' + humanizeApiError(e), 'error');
        return;
    }
    showVoteListModal(ev, votes, membersCache);
}

// ---- 参加状況サブタブ（回答一覧をタブ表示のテーブルで） ----

let attendanceData = null;   // { attend, absent, undecided, noAnswer }（現在の開催回の集計。タブ切替の再取得を避けるため保持）
let attendanceFilter = 'all';

// 参加状況の表示メタ。一覧の状態バッジとフィルタチップの両方で使う。
const ATTENDANCE_STATUS = {
    attend:    { label: '参加',   cls: 'att-st-attend' },
    absent:    { label: '不参加', cls: 'att-st-absent' },
    undecided: { label: '未定',   cls: 'att-st-undecided' },
    noAnswer:  { label: '未回答', cls: 'att-st-noanswer' }
};

async function renderAttendanceTab() {
    const box = document.getElementById('series-attendance-detail');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }

    attendanceData = null;
    attendanceFilter = 'all';
    // 参加投票はスッキリさせるため折りたたみ（デフォルト非表示）。開いた時に初めて描画する。
    box.innerHTML = `
        <div class="detail-section-card" id="series-detail-votes">
            <button type="button" class="detail-toggle-header" aria-expanded="false" onclick="toggleSeriesVoteWidget(this)">
                <h3 class="detail-section-title" style="margin:0;">出欠を回答する</h3>
                <span class="detail-toggle-icon" aria-hidden="true">&#9654;</span>
            </button>
            <div id="series-vote-widget" class="hidden" style="margin-top:12px;"></div>
        </div>
        <div class="detail-section-card">
            <h3 class="detail-section-title">参加回答一覧</h3>
            <div id="attendance-list-body"><div class="loading-text" style="padding:16px 0;">読み込み中</div></div>
        </div>
    `;

    await renderAttendanceList(ev);
}

// 実験フィードバックカードの開閉トグル
function toggleExpFbCard(btn) {
    const body = btn.nextElementSibling;
    if (!body) return;
    const open = body.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('.detail-toggle-icon').innerHTML = open ? '&#9660;' : '&#9654;';
}

// 参加投票トグルの開閉。開いた時にウィジェットを（再）描画する
function toggleSeriesVoteWidget(btn) {
    const body = document.getElementById('series-vote-widget');
    if (!body) return;
    const open = body.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('.detail-toggle-icon').innerHTML = open ? '&#9660;' : '&#9654;';
    if (open) renderSeriesVoteWidget();
}

async function renderSeriesVoteWidget() {
    const box = document.getElementById('series-vote-widget');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) return;
    box.innerHTML = '<div class="loading-text" style="padding:8px 0;">読み込み中</div>';
    let votes;
    try {
        votes = await loadEventVotes(ev);
    } catch (_) {
        box.innerHTML = '<span class="text-hint" style="font-size:0.85rem;">参加状況を取得できませんでした</span>';
        return;
    }
    // 取得中に開催回が切り替わっていたら何もしない
    if (currentEventId !== ev.ID) return;
    renderVoteWidget(box, {
        event: ev,
        members: membersCache,
        votes,
        onChange: (v) => { votesCache[ev.ID] = v; renderAttendanceList(ev); }
    });
}

async function renderAttendanceList(ev) {
    const body = document.getElementById('attendance-list-body');
    if (!body) return;

    let votes;
    try {
        votes = await loadEventVotes(ev);
    } catch (_) {
        body.innerHTML = '<span class="text-hint" style="font-size:0.85rem;">参加状況を取得できませんでした</span>';
        return;
    }
    if (currentEventId !== ev.ID) return;

    const eligible = membersCache.length > 0 ? voteEligibleMembers(membersCache, ev) : [];
    const staffIds = voteStaffIds(membersCache);
    const memberVotes = (votes || []).filter(v => !staffIds.has(v.memberId));
    const answeredIds = new Set(memberVotes.map(v => v.memberId));

    attendanceData = {
        attend: memberVotes.filter(v => v.status === 'attend'),
        absent: memberVotes.filter(v => v.status === 'absent'),
        undecided: memberVotes.filter(v => v.status === 'undecided'),
        noAnswer: eligible.filter(m => !answeredIds.has(m.ID)).map(m => ({ memberId: m.ID }))
    };
    renderAttendanceListBody();
    // 投票を取り終えたので、タブの未回答バッジもここで確定させる
    updateScopeBadges();
}

function switchAttendanceFilter(status) {
    attendanceFilter = status;
    renderAttendanceListBody();
}

function renderAttendanceListBody() {
    const body = document.getElementById('attendance-list-body');
    if (!body || !attendanceData) return;

    const keys = ['attend', 'absent', 'undecided', 'noAnswer'];
    const total = keys.reduce((n, k) => n + attendanceData[k].length, 0);

    // 既定は「全員」。誰がどの状態かを1つの表でまとめて見渡せるようにする。
    const chip = (key, label, count) =>
        `<button type="button" class="filter-chip ${attendanceFilter === key ? 'active' : ''}" aria-pressed="${attendanceFilter === key}" onclick="switchAttendanceFilter('${key}')">${label} (${count})</button>`;
    const tabsHtml = `<div class="expd-feedback-filters">
        ${chip('all', '全員', total)}
        ${keys.map(k => chip(k, ATTENDANCE_STATUS[k].label, attendanceData[k].length)).join('')}
    </div>`;

    const memberOf = (id) => membersCache.find(x => x.ID === id);
    const nameOf = (id) => { const m = memberOf(id); return m ? m.Name : id; };

    // 全員表示では4区分をまとめ、行ごとに状態を持たせる
    const items = (attendanceFilter === 'all'
        ? keys.flatMap(k => attendanceData[k].map(v => ({ ...v, _status: k })))
        : attendanceData[attendanceFilter].map(v => ({ ...v, _status: attendanceFilter })))
        .sort((a, b) => nameOf(a.memberId).localeCompare(nameOf(b.memberId), 'ja'));

    const rowsHtml = items.length === 0
        ? '<tr><td colspan="5" class="empty-state">該当者はいません</td></tr>'
        : items.map(v => {
            const m = memberOf(v.memberId);
            const role = m ? memberRoleOf(m) : '';
            const roleInfo = role ? getRoleDisplay(role) : null;
            const roleBadge = roleInfo ? `<span class="cat-badge" style="background:${roleInfo.color};">${escapeHtml(role)}</span>` : '';
            const st = ATTENDANCE_STATUS[v._status];
            return `
            <tr data-id="${escapeAttr(v.memberId)}" class="clickable-row" title="タップで詳細を表示">
                <td>${escapeHtml(m && m.StudentID ? m.StudentID : '')}</td>
                <td class="cell-name">${escapeHtml(nameOf(v.memberId))}</td>
                <td class="cell-role">${roleBadge}</td>
                <td><span class="att-status ${st.cls}">${st.label}</span></td>
                <td>${v.note ? escapeHtml(v.note) : ''}</td>
            </tr>`;
        }).join('');

    body.innerHTML = `
        ${tabsHtml}
        <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>学籍番号</th><th>名前</th><th>役職</th><th>状態</th><th>メモ</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `;
    body.querySelectorAll('tr[data-id]').forEach(row => {
        row.addEventListener('click', () => openMemberDetailModal(row.dataset.id, membersCache, { hideFurigana: true }));
    });
}

// ---- 振り返り記入サブタブ ----

function renderReflectionTab() {
    const box = document.getElementById('series-reflection-entry');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }

    const isMeeting = ev.Category === 'general' || ev.Category === 'admin';
    const parts = normalizeParts(ev.PartsList).filter(p => p.name || (p.presenters && p.presenters.length));

    box.innerHTML = `
        <div class="detail-section-card" id="series-detail-feedback">
            <h3 class="detail-section-title">この回の振り返りを記入</h3>
            ${!isMeeting && parts.filter(p => p.name).length > 0 ? `
            <div id="series-exp-feedback">
                ${parts.filter(p => p.name).map(p => `
                    <div class="exp-fb-card" data-exp-name="${escapeAttr(p.name)}">
                        <button type="button" class="detail-toggle-header" aria-expanded="false" onclick="toggleExpFbCard(this)">
                            <span class="exp-fb-card-title">${escapeHtml(p.name)} について</span>
                            <span class="detail-toggle-icon" aria-hidden="true">&#9654;</span>
                        </button>
                        <div class="exp-fb-card-body hidden">
                            <div class="exp-fb-row">
                                <label>良かった点</label>
                                <textarea class="e1-input exp-fb-positive" rows="2" placeholder="この実験で良かったこと"></textarea>
                            </div>
                            <div class="exp-fb-row">
                                <label>改善点</label>
                                <textarea class="e1-input exp-fb-reflection" rows="2" placeholder="この実験の改善点"></textarea>
                            </div>
                        </div>
                    </div>`).join('')}
            </div>` : ''}
            <div class="exp-fb-card">
                <button type="button" class="detail-toggle-header" aria-expanded="false" onclick="toggleExpFbCard(this)">
                    <span class="exp-fb-card-title">会場・運営の振り返り</span>
                    <span class="detail-toggle-icon" aria-hidden="true">&#9654;</span>
                </button>
                <div class="exp-fb-card-body hidden">
                    <div class="exp-fb-row">
                        <label>良かった点</label>
                        <textarea class="e1-input" id="series-fb-positives" rows="3" placeholder="会場・運営で良かったこと">${escapeHtml(ev.Positives || '')}</textarea>
                    </div>
                    <div class="exp-fb-row">
                        <label>改善点</label>
                        <textarea class="e1-input" id="series-fb-reflections" rows="3" placeholder="会場・運営の改善点">${escapeHtml(ev.Reflections || '')}</textarea>
                    </div>
                </div>
            </div>
            <div style="margin-top:12px; text-align:right;">
                <button id="series-fb-save-btn" class="btn btn-primary-solid" style="width:auto; padding:8px 24px;" onclick="saveDetailFeedback()">保存</button>
            </div>
        </div>
    `;
}

// ---- 成果・振り返り表示サブタブ（孫タブ: 会場・運営 / 実験名ごと） ----

let resultsGrandTab = 'venue';   // 'venue' または 'exp:<実験名>'

function renderResultsTab() {
    const box = document.getElementById('series-results-view');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }

    // 選択中の開催回で扱った実験名のみ表示する
    const expNames = [];
    normalizeParts(ev.PartsList).forEach(p => {
        if (p.name && !expNames.includes(p.name)) expNames.push(p.name);
    });

    // 選択中の孫タブが実験の削除等で無効になっていたら「会場・運営」へ戻す
    if (resultsGrandTab.startsWith('exp:') && !expNames.includes(resultsGrandTab.slice(4))) {
        resultsGrandTab = 'venue';
    }

    const tabBtn = (key, label) =>
        `<button type="button" class="grandchild-tab ${resultsGrandTab === key ? 'active' : ''}" data-gtab="${escapeAttr(key)}" onclick="switchResultsGrandTab(this)">${escapeHtml(label)}</button>`;

    box.innerHTML = `
        <div class="grandchild-tab-bar" role="tablist" aria-label="振り返りの対象">
            ${tabBtn('venue', '会場・運営')}
            ${expNames.map(n => tabBtn('exp:' + n, n)).join('')}
        </div>
        <div id="series-results-pane"></div>
    `;
    renderResultsPane();
}

function switchResultsGrandTab(btn) {
    resultsGrandTab = btn.dataset.gtab;
    document.querySelectorAll('#series-results-view .grandchild-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
    });
    renderResultsPane();
}

function renderResultsPane() {
    const pane = document.getElementById('series-results-pane');
    if (!pane) return;
    pane.innerHTML = resultsGrandTab === 'venue'
        ? renderVenueResultsHtml()
        : renderExpResultsHtml(resultsGrandTab.slice(4));
}

// 会場・運営: 開催回ごとの成果（来場者数など）と会場運営の振り返りを新しい順に表示
function renderVenueResultsHtml() {
    const occs = seriesEvents.slice()
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))
        .map(ev => {
            const pos = (ev.Positives || '').trim();
            const ref = (ev.Reflections || '').trim();
            const memo = (ev.ResultsMemo || '').trim();
            const visitors = (ev.VisitorCount || '').toString().trim();
            const participants = (ev.ParticipantCount || '').toString().trim();
            if (!pos && !ref && !memo && !visitors && !participants) return '';
            return `
            <div class="detail-section-card results-occ-card">
                <div class="results-occ-date">
                    <button type="button" class="sfb-event-link" onclick="openOccurrence('${escapeAttr(ev.ID)}')">${escapeHtml(ev.Date || '')} (${dayOfWeekJP(ev.Date)})</button>
                </div>
                ${visitors || participants ? `<div class="results-counts">
                    ${visitors ? `<span class="results-count-chip">来場者数 <strong>${escapeHtml(visitors)}</strong> 人</span>` : ''}
                    ${participants ? `<span class="results-count-chip">参加メンバー <strong>${escapeHtml(participants)}</strong> 人</span>` : ''}
                </div>` : ''}
                ${memo ? `<div class="results-memo" style="white-space:pre-wrap;">${escapeHtml(memo)}</div>` : ''}
                ${pos ? `<div class="sfb-entry sfb-positive"><span class="sfb-icon">&#9675;</span><span class="sfb-label">良かった点</span><span class="sfb-text">${escapeHtml(pos)}</span></div>` : ''}
                ${ref ? `<div class="sfb-entry sfb-reflection"><span class="sfb-icon">&#9651;</span><span class="sfb-label">改善点</span><span class="sfb-text">${escapeHtml(ref)}</span></div>` : ''}
            </div>`;
        }).filter(Boolean);

    return occs.length > 0
        ? occs.join('')
        : '<div class="empty-state" style="padding:30px 20px;">会場・運営の成果・振り返りはまだありません<div class="empty-hint">「振り返りを記入」タブから記入できます</div></div>';
}

// 実験ごと: 実験レコード（Positives/Reflections 履歴JSON）からこのシリーズ分のみ表示
function renderExpResultsHtml(expName) {
    const exp = experimentsCache.find(e => e.Name === expName);
    if (!exp) {
        return `<div class="empty-state" style="padding:30px 20px;">「${escapeHtml(expName)}」の実験データが見つかりません</div>`;
    }
    const seriesIds = new Set(seriesEvents.map(e => e.ID));
    const collect = (raw, type) => parseFeedbackEntries(raw)
        .filter(en => seriesIds.has(en.eventId))
        .map(en => ({ ...en, type }));
    const entries = [
        ...collect(exp.Positives, 'positive'),
        ...collect(exp.Reflections, 'reflection')
    ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const link = `<p style="margin:0 0 12px;"><a class="tbl-link" href="experiment-detail.html?id=${encodeURIComponent(exp.ID)}" style="font-size:0.85rem;">他イベント分も含めた振り返りは実験ページで見る &rarr;</a></p>`;

    if (entries.length === 0) {
        return link + `<div class="empty-state" style="padding:30px 20px;">このイベントでの「${escapeHtml(expName)}」の振り返りはまだありません<div class="empty-hint">「振り返りを記入」タブから記入できます</div></div>`;
    }
    return link + `<div class="detail-section-card">${entries.map(en => {
        const isPos = en.type === 'positive';
        return `<div class="sfb-entry ${isPos ? 'sfb-positive' : 'sfb-reflection'}">
            <span class="sfb-icon">${isPos ? '&#9675;' : '&#9651;'}</span>
            <span class="sfb-label">${isPos ? '良かった点' : '改善点'}</span>
            <span class="sfb-text">${escapeHtml(en.text || '')}</span>
            ${en.eventId ? `<button type="button" class="sfb-event-link" onclick="openOccurrence('${escapeAttr(en.eventId)}')">${escapeHtml(en.date || '')}</button>` : `<span class="sfb-date">${escapeHtml(en.date || '')}</span>`}
        </div>`;
    }).join('')}</div>`;
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

        toast('保存しました', 'success');
        renderDetail();
        renderReflectionTab();
        renderFeedbackTimeline();
        renderStats();
        renderOverview();
        // 記入欄と表示は同じ「振り返り」タブに並んでいるので、その場で表示側を描き直す
        renderResultsTab();
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 5000);
            init();
            return;
        }
        toast('保存失敗: ' + e.message, 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
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

// ---- 帯同メンバーのクリッカブル表示 ----

function renderAccompanyHtml(accompanyStr) {
    const names = (accompanyStr || '').split(',').map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return '---';
    return names.map(name => {
        const member = membersCache.find(m => m.Name === name);
        if (member) {
            const role = memberRoleOf(member);
            const isStaff = role === 'アドバイザー' || role === 'コーディネーター';
            if (isStaff) {
                return `<button type="button" class="accompany-staff-link" onclick="openStaffDetailModal('${escapeAttr(member.ID)}')">${escapeHtml(name)}</button>`;
            }
        }
        return escapeHtml(name);
    }).join(', ');
}

function openStaffDetailModal(id) {
    const m = membersCache.find(x => x.ID === id);
    if (!m) return;
    const role = memberRoleOf(m);
    const roleInfo = role ? getRoleDisplay(role) : null;

    const rows = [
        ['教職員番号', m.StudentID || ''],
        ['ふりがな', m.Furigana || ''],
        ['名前', m.Name || ''],
        ['メールアドレス', m.Email || ''],
        ['所属', m.Affiliation || ''],
        ['内線', m.Extension || ''],
        ['緊急連絡先', m.EmergencyContact || '']
    ].filter(r => r[1]);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content" style="max-width:460px;" role="dialog" aria-modal="true">
            <h2 style="margin-top:0;">
                ${escapeHtml(m.Name || '')}
                ${roleInfo ? `<span class="cat-badge" style="background:${roleInfo.color};margin-left:8px;font-size:0.75rem;vertical-align:middle;">${escapeHtml(role)}</span>` : ''}
            </h2>
            ${rows.length > 0
                ? `<table class="d1-table">${rows.map(([label, value]) =>
                    `<tr><th style="width:130px;">${escapeHtml(label)}</th>
                     <td class="copy-cell" data-copy="${escapeAttr(value)}" data-copy-label="${escapeAttr(label)}" title="タップでコピー" style="white-space:pre-wrap;">${escapeHtml(value)}<span class="copy-icon" aria-hidden="true">&#x2398;</span></td></tr>`).join('')}</table>
                  <p class="text-hint" style="font-size:0.78rem; margin:8px 0 0;">各項目はタップでコピーできます</p>`
                : '<p class="text-hint">登録されている詳細情報はありません</p>'}
            <div class="action-buttons" style="margin-top:16px;">
                <button type="button" class="btn btn-primary-solid" style="width:auto;" data-close>閉じる</button>
            </div>
        </div>`;

    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        const cell = e.target.closest('.copy-cell');
        if (cell) copyTextToClipboard(cell.dataset.copy, cell.dataset.copyLabel);
    });
    bindOverlayClose(overlay, close);
    bindModalEscape(overlay, close);
    document.body.appendChild(overlay);
    trapFocus(overlay.querySelector('.modal-content'));
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
        <p class="stats-detail" style="font-size:0.75rem; color:#888;">※ 2023年度以降の集計</p>
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
            <button type="button" class="series-card-header" aria-expanded="${isLatest ? 'true' : 'false'}" onclick="toggleSeriesCard(this)">
                <span class="series-fy-label"><strong>${escapeHtml(shortDate(ev.Date))}</strong><br>${escapeHtml(fyLabel)}${isLatest ? ' <span class="series-latest-tag">最新</span>' : ''}</span>
                <span class="series-card-header-right">
                    <span class="cat-dot" style="color:${cat.bg};" title="${cat.short}">&#9679;</span>
                    <span class="detail-toggle-icon" aria-hidden="true">${isLatest ? '&#9660;' : '&#9654;'}</span>
                </span>
            </button>
            <div class="series-card-body${isLatest ? '' : ' hidden'}">
                <div class="series-card-meta">
                    ${ev.DateEnd && ev.DateEnd !== ev.Date ? `<div>〜 ${escapeHtml(ev.DateEnd)}</div>` : ''}
                    ${ev.Location ? `<div>場所: ${escapeHtml(ev.Location)}</div>` : ''}
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

function toggleSeriesCard(btn) {
    const card = btn.closest('.series-card');
    const body = card?.querySelector('.series-card-body');
    if (!body) return;
    const open = body.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    const icon = btn.querySelector('.detail-toggle-icon');
    if (icon) icon.innerHTML = open ? '&#9660;' : '&#9654;';
}

// ---- タブ切り替え ----

// 1段フラットタブの切り替え。旧・大タブ/子タブ/孫タブの3階層をここに統合している。
// 「この回」ゾーン（概要・出欠・振り返り）は選択中の開催回、
// 「シリーズ全体」ゾーン（会場・履歴統計）は全開催回が対象。対象範囲バーで明示する。
function switchSeriesTab(btn) {
    document.querySelectorAll('.scope-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    const zone = btn.dataset.zone;
    document.querySelectorAll('.scope-zone').forEach(z => z.classList.toggle('active', z.dataset.zone === zone));

    const target = btn.dataset.tab;
    document.querySelectorAll('.scope-pane').forEach(p => {
        p.classList.toggle('hidden', p.dataset.pane !== target);
    });

    renderScopeContext();
    // 重い描画はタブを開いた時に行う（出欠は通信を伴うため）
    if (target === 'attendance') renderAttendanceTab();
    if (target === 'reflection') { renderReflectionTab(); renderResultsTab(); }
}

function activateSeriesTab(name) {
    const btn = document.querySelector(`.scope-tab[data-tab="${name}"]`);
    if (btn) switchSeriesTab(btn);
}

// 「場所」の値タップで会場タブへ（住所・連絡先・緊急連絡先はそちらにまとまっている）
function goToVenueInfoTab() {
    activateSeriesTab('venue');
}

// ====== 新規イベント作成（イベント一覧モードから。カードを選んでその場で複製） ======

function startSeriesPickMode() {
    seriesPickMode = true;
    document.getElementById('series-index-filters')?.classList.add('hidden');
    document.getElementById('series-pick-banner')?.classList.remove('hidden');
    renderSeriesIndex();
}

function cancelSeriesPickMode() {
    seriesPickMode = false;
    document.getElementById('series-index-filters')?.classList.remove('hidden');
    document.getElementById('series-pick-banner')?.classList.add('hidden');
    renderSeriesIndex();
}

function onSeriesDupSelect(eventId) {
    if (!eventId) return;
    location.href = 'events.html?duplicate=' + encodeURIComponent(eventId);
}

function goToNewEvent() {
    location.href = 'events.html?action=new';
}
