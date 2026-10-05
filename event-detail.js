/**
 * イベント詳細ページ（?key=<シリーズキー> または ?event=<イベントID>）
 * タブ = 概要 / 出欠 / 振り返り / 会場。?key も ?event も無いときはイベントページ（events.html）へ移る。
 *
 * このページがこのサイトの「イベント1件の正規ページ」。
 * 旧・詳細モーダル（events.html）と投票サマリー・書類ステータスをここに統合した。
 * データはサーバー形（DateEnd / TimeStart / AdminKyoka 等）で扱う。
 */

let allEventsData = [];      // サーバー形（DB の列名そのまま）
let seriesEvents = [];       // 表示中シリーズ（日付降順）
let seriesKey = '';
let seriesFbFilter = 'all';
let currentEventId = '';     // 詳細タブで選択中の開催回
let membersCache = [];
let experimentsCache = [];
const votesCache = {};       // eventId -> votes[]
let votesPrimed = false;     // listAll で全投票を取得済みなら true（getEventVotes の個別往復を省く）
let scrollToFeedback = false;
let autoEditEventId = '';     // ?edit=1 で来たら、その開催回の編集ウィザードを自動で開く（新規作成直後用）
let scrollToVotes = false;   // ?vote=1 で来たら参加状況カードへスクロール（共有リンク用）
let detailFbOpen = false;    // 「この回の振り返り」トグルの開閉状態（再描画をまたいで維持）

// 許可願・報告書の提出ステータス定義（config.js に集約）
const KYOKA_STATUS = CONFIG.KYOKA_STATUS;
const REPORT_STATUS = CONFIG.REPORT_STATUS;

// ---- 共通ウィザード・削除フロー（event-wizard.js）が読み書きするこのページのデータ ----
configureEventWizard({
    list: () => allEventsData,
    rerender() {
        // 削除などで選択中のイベントが無くなったら選択を外す（renderAll が先頭の回を選ぶ）
        if (currentEventId && !allEventsData.some(e => e.ID === currentEventId)) currentEventId = '';
        // タイトル変更でシリーズキーが変わることがあるため、選択中イベントから再導出する。
        // URL の key も合わせる（古い key のままだと、再読み込みや競合後の init() で別のシリーズを開いてしまう）
        const ev = allEventsData.find(e => e.ID === currentEventId);
        if (ev && seriesKeyOf(ev) !== seriesKey) {
            seriesKey = seriesKeyOf(ev);
            syncSeriesUrl();
        }
        filterSeries();
        if (seriesEvents.length > 0) renderAll();
    },
    onConflict: () => init(),
    // シリーズの最後の1回を消したら予定ページへ戻る（ページを離れるので「元に戻す」は出さない）
    onDeleted() {
        if (seriesEvents.length > 0) return true;
        location.href = 'events.html';
        return false;
    }
});

// saveEventPatch（app.js）に渡す共通オプション。このページの allEventsData（サーバー形）を対象にする。
function seriesPatchOpts(extra) {
    return Object.assign({
        getEvent: id => allEventsData.find(e => e.ID === id),
        persist: () => api.saveCache('events', allEventsData),
        onConflict: () => init()
    }, extra);
}

document.addEventListener('DOMContentLoaded', () => {
    bootPage('events', init);
});

async function init() {
    const params = new URLSearchParams(location.search);
    seriesKey = params.get('key') || '';
    currentEventId = params.get('event') || '';
    scrollToFeedback = params.get('tab') === 'feedback';
    scrollToVotes = params.get('vote') === '1'; // 出欠回答の共有リンク（旧 vote.html の代替）
    if (params.get('edit') === '1') {
        autoEditEventId = currentEventId;
        // 再読み込みで編集ウィザードが再度開かないよう、URL から外す
        params.delete('edit');
        const q = params.toString();
        history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
    }
    if (scrollToFeedback) detailFbOpen = true; // 未記入通知などから来たら折りたたみを開いておく
    loadAuxData(); // メンバー・実験は補助情報。裏で読み込み、揃い次第再描画する。

    // ページ内の編集ウィザード用の補助データ（祝日・担当/実験の入力候補）を裏で読み込む
    api.loadHolidaysCached().then(h => { holidaysData = h || {}; }).catch(() => {});
    populateDatalists();

    const cached = api.loadCache('events');
    if (cached && cached.items && cached.items.length > 0) {
        allEventsData = cached.items;
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
        if (all.experiments) {
            experimentsCache = all.experiments;
            api.saveCache('experiments', experimentsCache);
            populateDatalists(); // 実験名の入力候補・実在チェックを最新のマスタに更新する
        }
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
        if (seriesEvents.length === 0) {
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
    if (seriesEvents.length > 0) renderDetail();
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
    // ?event=<ID> だけで来た場合はイベントからシリーズキーを導出する
    if (currentEventId && !seriesKey) {
        const ev = allEventsData.find(e => e.ID === currentEventId);
        if (!ev) {
            if (isFresh) document.getElementById('series-loading').textContent = 'イベントが見つかりません';
            return;
        }
        seriesKey = seriesKeyOf(ev);
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
        .filter(ev => seriesKeyOf(ev) === seriesKey && ev.Date)
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
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
    document.title = `${displayTitle} | SciComi Site`;

    // ミーティングでは不要なタブを隠す（振り返り・会場はイベント向けの機能）
    const ev0 = currentEvent();
    const isMtg = ev0 && isMeetingCategory(ev0.Category);
    document.querySelectorAll('.scope-tab[data-tab="reflection"], .scope-tab[data-tab="venue"]').forEach(t => {
        t.style.display = isMtg ? 'none' : '';
    });
    // 隠したタブが選択されたままにならないよう、概要へ戻す
    if (isMtg && ['reflection', 'venue'].includes(document.querySelector('.scope-tab.active')?.dataset.tab)) {
        activateSeriesTab('summary');
    }

    renderHeaderActions();
    renderSafetyInfo();
    renderScopeContext();
    renderDetail();
    updateScopeBadges();
    if (!isMtg) {
        renderFeedbackTimeline();
    }

    if (autoEditEventId) {
        const editId = autoEditEventId;
        autoEditEventId = '';
        if (seriesEvents.some(e => e.ID === editId)) setTimeout(() => openEventWizard(editId), 200);
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
        <button type="button" class="btn btn-secondary btn-sm" data-action="es-edit-event" data-id="${escapeAttr(ev.ID)}">編集</button>
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

// 開催回の選択プルダウン（イベント名のすぐ下）。開催回が 1 つだけなら出さない。
function renderOccPicker() {
    const box = document.getElementById('series-occ-picker');
    if (!box) return;
    if (seriesEvents.length <= 1) { box.innerHTML = ''; return; }
    const today = todayISO();
    const asc = seriesEvents.slice().sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
    const options = asc.slice().reverse().map(e => {
        const n = asc.findIndex(x => x.ID === e.ID) + 1;
        const up = (e.DateEnd || e.Date) >= today;
        const label = `${n}回目　${compactOccDate(e.Date)}(${dayOfWeekJP(e.Date)})${up ? '・開催予定' : ''}`;
        return `<option value="${escapeAttr(e.ID)}" ${e.ID === currentEvent().ID ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    box.innerHTML = `<select class="occ-select" aria-label="開催回を選ぶ" data-change-action="es-select-occ">${options}</select>`;
}

// タブ直下の対象範囲バー。「シリーズ全体」を見ているときだけ、全何回を対象にしているかを示す
// （「この回」のときは、ヘッダーカードの開催回プルダウンが現在の回を示すので、バーは出さない）。
function renderScopeContext() {
    renderOccPicker();
    const box = document.getElementById('series-scope-ctx');
    if (!box) return;
    const zone = document.querySelector('.scope-tab.active')?.dataset.zone || 'occ';
    box.classList.toggle('scope-ctx--series', zone === 'series');

    if (zone !== 'series') { box.innerHTML = ''; return; }
    const years = seriesEvents.map(e => (e.Date || '').slice(0, 4)).filter(Boolean).sort();
    const span = years.length === 0 ? ''
        : years[0] === years[years.length - 1] ? `${years[0]}年`
        : `${years[0]}年 〜 ${years[years.length - 1]}年`;
    box.innerHTML = `
        <span class="scope-ctx-label"><span class="scope-ctx-dot" aria-hidden="true"></span>全 ${seriesEvents.length} 回を対象に表示中</span>
        ${span ? `<span class="scope-ctx-sub">${escapeHtml(span)}</span>` : ''}`;
}

// 表示中のシリーズと開催回を URL に書く（履歴は増やさない）
function syncSeriesUrl() {
    history.replaceState(null, '', `events.html?key=${encodeURIComponent(seriesKey)}&event=${encodeURIComponent(currentEventId)}`);
}

function selectOccurrence(id) {
    if (!seriesEvents.some(e => e.ID === id)) return;
    currentEventId = id;
    syncSeriesUrl();
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
    if (detail) detail.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
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

    const isMeeting = isMeetingCategory(ev.Category);
    let docs = 0;
    if (!isMeeting) {
        if (!ev.KyokaNotRequired && (ev.KyokaStatus || '') !== 'submitted') docs++;
        if (!ev.HoukokuNotRequired && (ev.ReportStatus || '') !== 'clc') docs++;
    }
    set('scope-badge-summary', docs);

    const votes = votesCache[ev.ID] || (votesPrimed ? [] : null);
    if (!votes || membersCache.length === 0) { set('scope-badge-attendance', 0); return; }
    const g = groupVotesByStatus(votes, membersCache);
    const answered = new Set([...g.attend, ...g.absent, ...g.undecided].map(v => v.memberId));
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

    // 失敗時は入力フォームを開いたままにする（再描画しない）
    await saveEventPatch(ev.ID, {
        PostalCode: postalCode, Address: address, LocationTel: tel, EmergencyHospital: hospital, EmergencyPolice: police
    }, seriesPatchOpts({
        successMessage: '会場情報を保存しました',
        successDuration: 3000,
        onSaved: () => { filterSeries(); renderSafetyInfo(); }
    }));
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

function expLinkHtml(name) {
    const match = experimentsCache.find(e => e.Name === name);
    const href = match
        ? `experiment-detail.html?id=${encodeURIComponent(match.ID)}`
        : `experiments.html?focus=${encodeURIComponent(name)}`;
    return `<a href="${href}" class="exp-link-inline" title="実験内容を見る">${escapeHtml(name)}</a>`;
}

// ---- 書類・資料ファイル（依頼書・活動許可願・活動報告書・関連資料・議事録） ----

const DETAIL_FILE_LABELS = { RequestDoc: '依頼書', KyokaDoc: '活動許可願', HoukokuDoc: '活動報告書', MeetingDocs: '関連資料', Minutes: '議事録' };
const DETAIL_DOC_FIELDS = ['RequestDoc', 'KyokaDoc', 'HoukokuDoc'];

function splitNamesList(v) {
    return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ファイル項目の共通部品。選択用の <input type=file> は項目ごとに 1 つ置き、クリックでもドロップでも同じ経路（uploadDetailFiles）に流す。
function fileInputHtml(field, multiple) {
    return `<input type="file" class="hidden" data-ef-input data-field="${field}"${multiple ? ' multiple' : ''}>`;
}

function detailFileLinkHtml(f, i) {
    const url = safeHttpUrl(f.url);
    const name = escapeHtml(f.name || ('ファイル ' + (i + 1)));
    const size = f.size ? ' (' + formatFileSize(f.size) + ')' : '';
    return url
        ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="file-link">${name}${size}</a>`
        : `<span class="file-link text-hint">${name} (リンク切れ)</span>`;
}

// 書類ファイル（依頼書など・1 ファイル）: 「依頼書」という名前の小さな枠。
// 空なら点線の枠（押す／ドロップで追加できそうな見た目）、あれば実線の枠にファイル名と 差し替え・削除。
function docSlotHtml(ev, field) {
    const label = DETAIL_FILE_LABELS[field];
    const f = (Array.isArray(ev[field]) ? ev[field] : [])[0];
    if (!f) {
        return `<div class="doc-slot is-empty" data-drop-field="${field}">
            <button type="button" class="doc-slot-main" data-action="es-file-pick" title="クリック、またはファイルをドロップして${label}をアップロード">
                <span class="doc-slot-icon" aria-hidden="true">&#65291;</span><span class="doc-slot-label">${label}</span>
            </button>${fileInputHtml(field, false)}</div>`;
    }
    return `<div class="doc-slot is-filled" data-drop-field="${field}">
        <span class="doc-slot-icon" aria-hidden="true">&#10003;</span>
        <span class="doc-slot-label">${label}</span>
        ${detailFileLinkHtml(f, 0)}
        <button type="button" class="doc-slot-btn" data-action="es-file-pick" title="ファイルをドロップ、またはクリックで差し替え" aria-label="${label}を差し替え">&#8635;</button>
        <button type="button" class="doc-slot-btn" data-action="es-file-remove" data-field="${field}" data-index="0" title="削除" aria-label="${label}を削除">&times;</button>
        ${fileInputHtml(field, false)}</div>`;
}

// 複数ファイル／議事録（ミーティング用）: ファイル一覧と、点線の「＋ 追加」枠。
function detailFilesHtml(ev, field, multiple) {
    const files = Array.isArray(ev[field]) ? ev[field] : [];
    const items = files.map((f, i) =>
        `<span class="detail-file-item">${detailFileLinkHtml(f, i)} <button type="button" class="tbl-btn tbl-btn-danger" data-action="es-file-remove" data-field="${field}" data-index="${i}">削除</button></span>`
    ).join('');
    const label = files.length ? (multiple ? '追加' : '差し替え') : 'アップロード';
    return `
        <div class="detail-file-field" data-drop-field="${field}">
            ${items}
            <button type="button" class="doc-slot is-empty doc-slot-inline" data-action="es-file-pick" title="クリック、またはファイルをドロップして${label}">
                <span class="doc-slot-icon" aria-hidden="true">&#65291;</span><span class="doc-slot-label">${label}</span>
            </button>
            ${fileInputHtml(field, multiple)}
        </div>`;
}

// 選んだファイルをアップロードして、イベントに保存する。1 ファイルの項目は差し替え（前のファイルは消す）。
async function uploadDetailFiles(field, files, multiple) {
    const ev = currentEvent();
    if (!ev || files.length === 0) return;
    const evId = ev.ID;
    const label = DETAIL_FILE_LABELS[field];
    const maxMB = getFileMaxMB();
    const uploaded = [];
    toast('アップロード中...', 'info', 2000);
    for (const file of (multiple ? files : files.slice(0, 1))) {
        if (file.size > maxMB * 1024 * 1024) {
            toast(`「${file.name}」はサイズ上限(${maxMB}MB)を超えています`, 'error');
            continue;
        }
        try {
            uploaded.push(await api.uploadFile(file));
        } catch (err) {
            toast(`「${file.name}」のアップロード失敗: ${humanizeApiError(err)}`, 'error');
        }
    }
    if (uploaded.length === 0) return;
    const live = allEventsData.find(e => e.ID === evId);
    if (!live) { deleteStoredFiles(uploaded.map(f => f.driveId)); return; }
    const current = Array.isArray(live[field]) ? live[field] : [];
    const next = multiple ? current.concat(uploaded) : uploaded.slice(0, 1);
    let conflicted = false;
    await saveEventPatch(evId, { [field]: next }, seriesPatchOpts({
        successMessage: `${label}を保存しました`,
        onOptimistic: () => renderDetail(),
        onRollback: (_ev, err) => { conflicted = isConflictError(err); renderDetail(); }
    }));
    // 競合で保存されなかったときだけ、今回アップロードしたファイル（どの記録にも載っていない）を消す。
    // タイムアウトなどでは保存済みの可能性があり、消すと記録の参照先が無くなるので残す。
    // 差し替えで外れた古いファイルは、サーバーがゴミ箱へ移す（実体は期限まで残る）
    if (conflicted) deleteStoredFiles(uploaded.map(f => f.driveId));
}

function removeDetailFile(field, index) {
    const ev = currentEvent();
    const file = ev && Array.isArray(ev[field]) ? ev[field][index] : null;
    if (!file) return;
    const label = DETAIL_FILE_LABELS[field];
    showConfirmDialog({
        title: 'ファイルを削除しますか？',
        message: `「${file.name || 'ファイル'}」を${label}から削除します。${TRASH_KEEP_NOTE}`,
        okLabel: '削除する',
        danger: true,
        onOk: async () => {
            const next = ev[field].filter((_, i) => i !== index);
            await saveEventPatch(ev.ID, { [field]: next }, seriesPatchOpts({
                successMessage: `${label}から削除しました`,
                onOptimistic: () => renderDetail(),
                onRollback: () => renderDetail()
            }));
        }
    });
}

function renderDetail() {
    const box = document.getElementById('series-detail');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }

    const isMeeting = isMeetingCategory(ev.Category);
    const today = todayISO();
    const isUpcoming = (ev.DateEnd || ev.Date) >= today;

    let displayTitle = ev.Title || '(無題)';
    if (isMeeting && ev.MeetingNumber) displayTitle = `第${ev.MeetingNumber}回 ${displayTitle}`;

    // 未入力の欄は薄い「—」で示し、押すと編集ウィザードの該当の入力欄へ直行する
    const emptyCell = (focusId, text = '—') =>
        `<button type="button" class="empty-cell" data-action="es-edit-event" data-id="${escapeAttr(ev.ID)}" data-focus="${focusId}" title="編集して入力" aria-label="未入力。編集して入力">${text}</button>`;

    // 実験・発表者
    const parts = normalizeParts(ev.PartsList).filter(p => p.name || (p.presenters && p.presenters.length));
    const expHtml = parts.length > 0
        ? `<ul class="detail-exp-list">${parts.map(p => {
            const nameHtml = p.name ? expLinkHtml(p.name) : '(未定)';
            const presenters = (p.presenters && p.presenters.length) ? p.presenters.map(escapeHtml).join(', ') : '未定';
            return `<li><span class="tag tag-exp">${nameHtml} <span class="tag-presenter">(${presenters})</span></span></li>`;
        }).join('')}</ul>`
        : emptyCell('wz-ev-exp-container');

    // 関連ファイル（備考の一番下に添付する）
    const files = Array.isArray(ev.Files) ? ev.Files : [];
    const filesHtml = files.map((f, i) => {
        const url = f.url || '';
        const name = escapeHtml(f.name || ('ファイル ' + (i + 1)));
        const size = f.size ? ' (' + formatFileSize(f.size) + ')' : '';
        if (/^https?:\/\//i.test(url)) {
            return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="file-link">${name}${size}</a>`;
        }
        return `<span class="file-link text-hint">${name} (リンク切れ)</span>`;
    }).join('');

    // 備考（ミーティングでは議題）+ 関連ファイル
    const notesText = (ev.Remarks || '').trim();
    const notesHtml = (notesText ? `<div style="white-space:pre-wrap;">${escapeHtml(notesText)}</div>` : '')
        + (filesHtml ? `<div class="file-list detail-notes-files">${filesHtml}</div>` : '');

    // 書類（許可願・報告書: 期限＋担当＋ステータス変更）
    const kyokaOverdue = ev.KyokaDeadline && ev.KyokaDeadline < today && (ev.KyokaStatus || '') !== 'submitted';
    const houkokuOverdue = ev.HoukokuDeadline && ev.HoukokuDeadline < today && (ev.ReportStatus || '') !== 'clc';
    const docsHtml = `
        <div class="doc-status-row">
            <span class="doc-status-name">許可願</span>
            ${ev.KyokaNotRequired
                ? '<span class="doc-status-info text-muted">不要</span>'
                : `<span class="doc-status-info">期限 <span class="tag-deadline ${kyokaOverdue ? 'deadline-past' : ''}">${escapeHtml(ev.KyokaDeadline || '---')}</span>
                ／ 担当 ${personChipsHtml(ev.AdminKyoka) || emptyCell('wz-ev-admin-kyoka', '未定')}</span>
            <select class="report-status-select status-${docStatusClass(KYOKA_STATUS, ev.KyokaStatus || '')}" data-doc="KyokaStatus" aria-label="許可願の提出ステータス" title="許可願の提出ステータスを変更">
                ${Object.keys(KYOKA_STATUS).map(v => `<option value="${v}" ${v === (ev.KyokaStatus || '') ? 'selected' : ''}>${KYOKA_STATUS[v].label}</option>`).join('')}
            </select>`}
        </div>
        <div class="doc-status-row">
            <span class="doc-status-name">報告書</span>
            ${ev.HoukokuNotRequired
                ? '<span class="doc-status-info text-muted">不要</span>'
                : `<span class="doc-status-info">期限 <span class="tag-deadline ${houkokuOverdue ? 'deadline-past' : ''}">${escapeHtml(ev.HoukokuDeadline || '---')}</span>
                ／ 担当 ${personChipsHtml(ev.AdminHoukoku) || emptyCell('wz-ev-admin-houkoku', '未定')}</span>
            <select class="report-status-select status-${docStatusClass(REPORT_STATUS, ev.ReportStatus || '')}" data-doc="ReportStatus" aria-label="報告書の提出ステータス" title="報告書の提出ステータスを変更">
                ${Object.keys(REPORT_STATUS).map(v => `<option value="${v}" ${v === (ev.ReportStatus || '') ? 'selected' : ''}>${REPORT_STATUS[v].label}</option>`).join('')}
            </select>`}
        </div>`;

    // 提出ファイル（依頼書・活動許可願・活動報告書）
    const docFilesHtml = `
        <div class="doc-status-row" style="flex-direction:column; align-items:flex-start; gap:6px;">
            <span class="doc-status-name">提出ファイル <span class="text-hint" style="font-weight:400; font-size:0.8rem;">クリック or ドロップでアップロード</span></span>
            <div class="doc-slots">${DETAIL_DOC_FIELDS.map(f => docSlotHtml(ev, f)).join('')}</div>
        </div>`;

    // 集合・解散
    const gatherDismiss = (ev.GatherTime || ev.DismissTime)
        ? [ev.GatherTime && `集合 ${escapeHtml(ev.GatherTime)}`, ev.DismissTime && `解散 ${escapeHtml(ev.DismissTime)}`].filter(Boolean).join(' / ')
        : emptyCell('wz-ev-gather');

    // セクション見出しの行。右端のペンボタンで、編集ウィザードの該当の入力欄を開く
    const groupRow = (g, label, focusId) => `<tr class="series-detail-group" data-g="${g}"><th colspan="2"><span class="series-group-head"><span>${label}</span><button type="button" class="expd-section-edit-btn" data-action="es-edit-event" data-id="${escapeAttr(ev.ID)}" data-focus="${focusId}" title="${label}を編集" aria-label="${label}を編集">&#9998;</button></span></th></tr>`;

    const dateStr = `${escapeHtml(ev.Date)} (${dayOfWeekJP(ev.Date)})`
        + (ev.DateEnd && ev.DateEnd !== ev.Date ? ` 〜 ${escapeHtml(formatDateRangeEnd(ev.Date, ev.DateEnd))}` : '');
    const timeStr = (ev.TimeStart && ev.TimeEnd) ? `${escapeHtml(ev.TimeStart)} 〜 ${escapeHtml(ev.TimeEnd)}` : '未定';

    box.innerHTML = `
        <table class="d1-table series-detail-table">
            ${groupRow('event', isMeeting ? 'ミーティング' : 'イベント', 'wz-ev-title')}
            <tr><th>${isMeeting ? 'ミーティング名' : 'イベント名'}</th><td><span class="text-primary" style="font-size:1.15rem; font-weight:600;">${escapeHtml(displayTitle)}</span></td></tr>
            ${!isMeeting ? `<tr><th>企画名</th><td>${ev.PlanName ? escapeHtml(ev.PlanName) : emptyCell('wz-ev-planname')}</td></tr>` : ''}
            ${!isMeeting ? `<tr><th>企画担当者</th><td>${personChipsHtml(ev.PlanLeader) || emptyCell('wz-ev-planleader')}</td></tr>` : ''}
            <tr><th>場所</th><td>${ev.Location ? `<span class="exp-link-inline" style="cursor:pointer;" onclick="goToVenueInfoTab()" title="会場情報タブへ">${escapeHtml(ev.Location)}</span>` : emptyCell('wz-ev-location')}</td></tr>
            ${!isMeeting ? `<tr><th>対象・人数</th><td>${ev.Audience ? escapeHtml(ev.Audience) : emptyCell('wz-ev-audience')}</td></tr>` : ''}
            ${groupRow('schedule', '日程', 'wz-ev-time-start')}
            <tr><th>日にち</th><td>${dateStr}${isUpcoming ? ' <span class="occ-badge occ-upcoming">開催予定</span>' : ''}</td></tr>
            <tr><th>時間</th><td>${ev.TimeStart && ev.TimeEnd ? timeStr : emptyCell('wz-ev-time-start')}</td></tr>
            ${!isMeeting ? `<tr><th>集合・解散</th><td>${gatherDismiss}</td></tr>` : ''}
            ${!isMeeting ? `
            ${groupRow('transport', '荷物運搬', 'wz-ev-transport')}
            <tr><th>運搬方法</th><td>${ev.TransportMethod ? escapeHtml(ev.TransportMethod) : emptyCell('wz-ev-transport')}</td></tr>
            <tr><th>運転者</th><td>${personChipsHtml(ev.TransportDriver) || emptyCell('wz-ev-driver')}</td></tr>
            <tr><th>同乗者</th><td>${personChipsHtml(ev.TransportPassengers) || emptyCell('wz-ev-passenger')}</td></tr>` : ''}
            ${!isMeeting ? `
            ${groupRow('content', '実験内容・発表者', 'wz-ev-exp-container')}
            <tr><td colspan="2">${expHtml}</td></tr>` : ''}
            ${groupRow('notes', isMeeting ? '議題・資料' : '備考', 'wz-ev-remarks')}
            <tr><td colspan="2">${notesHtml || emptyCell('wz-ev-remarks')}</td></tr>
            ${isMeeting ? `<tr><th>関連資料</th><td>${detailFilesHtml(ev, 'MeetingDocs', true)}</td></tr>
            <tr><th>議事録</th><td>${detailFilesHtml(ev, 'Minutes', false)}</td></tr>` : ''}
            ${!isMeeting ? `${groupRow('docs', '書類', 'wz-ev-admin-kyoka')}
            <tr><td colspan="2">${docsHtml}${docFilesHtml}</td></tr>
            <tr class="series-detail-group" data-g="after"><th colspan="2">イベント後に対応</th></tr>
            <tr class="detail-lv1"><th>来場者</th><td><input type="number" min="0" class="e1-input post-event-input" data-pe-field="VisitorCount"
                value="${escapeAttr(ev.VisitorCount || '')}" placeholder="未記入" aria-label="来場者数" title="この回の来場者数"></td></tr>
            <tr class="detail-lv1"><th>参加メンバー</th><td><input type="number" min="0" class="e1-input post-event-input" data-pe-field="ParticipantCount"
                value="${escapeAttr(ev.ParticipantCount || '')}" placeholder="未記入" aria-label="参加メンバーの人数" title="この回に参加したメンバーの人数"></td></tr>
            ${prRowsHtml(ev)}` : ''}
        </table>
    `;

    // 書類ステータスの変更を保存
    box.querySelectorAll('.report-status-select[data-doc]').forEach(sel => {
        sel.addEventListener('change', () => saveDocStatus(ev.ID, sel.dataset.doc, sel.value));
    });
    // イベント後の実績（来場者数・参加メンバー数）はその場で編集→即保存
    box.querySelectorAll('.post-event-input[data-pe-field]').forEach(input => {
        input.addEventListener('change', () => savePostEventField(ev.ID, input.dataset.peField, input.value.trim()));
    });
    // 書類・資料ファイルの選択（選んだらアップロードして保存）
    box.querySelectorAll('[data-ef-input]').forEach(input => {
        input.addEventListener('change', () => {
            uploadDetailFiles(input.dataset.field, Array.from(input.files), input.multiple);
            input.value = '';
        });
    });
    // ドラッグ&ドロップでもアップロードできる（クリック選択と同じ経路）
    box.querySelectorAll('[data-drop-field]').forEach(zone => {
        const input = zone.querySelector('[data-ef-input]');
        const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
        zone.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); zone.classList.add('is-dragover'); });
        zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-dragover'); });
        zone.addEventListener('drop', e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            zone.classList.remove('is-dragover');
            uploadDetailFiles(zone.dataset.dropField, Array.from(e.dataTransfer.files), input.multiple);
        });
    });
    // 広報担当の選択を保存
    box.querySelectorAll('.pr-input[data-pr-channel]').forEach(select => {
        select.addEventListener('change', () => savePrField(ev.ID, select.dataset.prChannel, select.value.trim()));
    });
}

// 広報担当（チャンネルごとに 1 行）。「イベント後に記入」グループの表の行として返す。
function prRowsHtml(ev) {
    const channels = CONFIG.PR_CHANNELS || [];
    if (!channels.length) return '';
    const assignments = ev.PrAssignments || {};

    // 教職員は広報担当の対象外。メンバーのみを学年（◯C）ごとにグループ化して選ばせる。
    const eligible = voteEligibleMembers(membersCache, ev);
    const memberGroups = groupMembersByGrade(eligible);

    const optionsHtml = (current) => {
        // 過去のデータで退会済み・年度外のメンバーが設定されている場合も選択肢として残す
        const currentMissing = current && !eligible.some(m => m.Name === current);
        return `
            <option value="">なし</option>
            ${currentMissing ? `<option value="${escapeAttr(current)}" selected>${escapeAttr(current)}</option>` : ''}
            ${memberGroups.map(g => `<optgroup label="${escapeAttr(g.label)}">${g.members.map(m =>
                `<option value="${escapeAttr(m.Name)}" ${m.Name === current ? 'selected' : ''}>${escapeAttr(m.Name)}</option>`
            ).join('')}</optgroup>`).join('')}
        `;
    };

    const head = '<tr class="detail-lv1"><th colspan="2">広報担当</th></tr>';
    return head + channels.map(ch => `<tr class="detail-lv2">
            <th>${escapeHtml(ch)}</th>
            <td><select class="e1-input pr-input" data-pr-channel="${escapeAttr(ch)}" aria-label="広報担当: ${escapeAttr(ch)}">${optionsHtml(assignments[ch] || '')}</select></td>
        </tr>`).join('');
}

async function savePrField(id, channel, value) {
    const ev = allEventsData.find(e => e.ID === id);
    if (!ev) return;
    const current = ev.PrAssignments ? { ...ev.PrAssignments } : {};
    if ((current[channel] || '') === value) return;
    current[channel] = value;
    await saveEventPatch(id, { PrAssignments: current }, seriesPatchOpts({
        successMessage: '広報担当を保存しました',
        onRollback: () => renderDetail()
    }));
}

// 「イベント後に記入」欄の保存（楽観的更新。失敗時は元の値へ戻す）
async function savePostEventField(id, field, value) {
    const ev = allEventsData.find(e => e.ID === id);
    if (!ev) return;
    if ((ev[field] || '') === value) return;

    const label = field === 'VisitorCount' ? '来場者数' : '参加メンバー数';
    await saveEventPatch(id, { [field]: value }, seriesPatchOpts({
        successMessage: `${label}を保存しました`,
        onRollback: () => renderDetail()
    }));
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

// ---- 参加状況サブタブ（回答一覧をタブ表示のテーブルで） ----

let attendanceData = null;   // { attend, absent, undecided, noAnswer }（現在の開催回の集計。タブ切替の再取得を避けるため保持）
let attendanceFilter = 'attend';

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
    attendanceFilter = 'attend';
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
        onChange: (v) => { votesCache[ev.ID] = v; cacheEventVotes(ev.ID, v); renderAttendanceList(ev); }
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
    const grouped = groupVotesByStatus(votes, membersCache);
    const answeredIds = new Set([...grouped.attend, ...grouped.absent, ...grouped.undecided].map(v => v.memberId));

    attendanceData = {
        ...grouped,
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

// 描画した data-action / data-change-action の受け口（onclick 属性に ID を埋め込まない。app.js の registerActions 参照）
registerActions({
    'es-edit-event': el => openEventWizard(el.dataset.id, null, el.dataset.focus || ''),
    'es-file-pick': el => el.closest('[data-drop-field]').querySelector('[data-ef-input]').click(),
    'es-file-remove': el => removeDetailFile(el.dataset.field, Number(el.dataset.index)),
    'es-select-occ': el => selectOccurrence(el.dataset.id || el.value),   // 開催回プルダウンは value（data-id でも受け付ける）
    'es-open-occ': el => openOccurrence(el.dataset.id),
    'es-attendance-filter': el => switchAttendanceFilter(el.dataset.key),
    'es-staff-detail': el => openStaffDetailModal(el.dataset.id),
    'es-member-detail': el => openMemberDetailModal(el.dataset.id, membersCache, { hideFurigana: true })
});

function renderAttendanceListBody() {
    const body = document.getElementById('attendance-list-body');
    if (!body || !attendanceData) return;

    const keys = ['attend', 'absent', 'undecided', 'noAnswer'];

    // 既定は「参加」。
    const chip = (key, label, count) =>
        `<button type="button" class="filter-chip ${attendanceFilter === key ? 'active' : ''}" aria-pressed="${attendanceFilter === key}" data-action="es-attendance-filter" data-key="${escapeAttr(key)}">${label} (${count})</button>`;
    const tabsHtml = `<div class="expd-feedback-filters">
        ${keys.map(k => chip(k, ATTENDANCE_STATUS[k].label, attendanceData[k].length)).join('')}
    </div>`;

    const memberOf = (id) => membersCache.find(x => x.ID === id);
    const nameOf = (id) => { const m = memberOf(id); return m ? m.Name : id; };

    const items = attendanceData[attendanceFilter].map(v => ({ ...v }))
        .sort((a, b) => nameOf(a.memberId).localeCompare(nameOf(b.memberId), 'ja'));

    const rowsHtml = items.length === 0
        ? '<tr><td colspan="4" class="empty-state">該当者はいません</td></tr>'
        : items.map(v => {
            const m = memberOf(v.memberId);
            const role = m ? memberRoleOf(m) : '';
            const roleInfo = role ? getRoleDisplay(role) : null;
            const roleBadge = roleInfo ? `<span class="cat-badge" style="background:${roleInfo.color};">${escapeHtml(role)}</span>` : '';
            return `
            <tr data-id="${escapeAttr(v.memberId)}" class="clickable-row" title="タップで詳細を表示">
                <td>${escapeHtml(m && m.StudentID ? m.StudentID : '')}</td>
                <td class="cell-name">${escapeHtml(nameOf(v.memberId))}</td>
                <td class="cell-role">${roleBadge}</td>
                <td>${v.note ? escapeHtml(v.note) : ''}</td>
            </tr>`;
        }).join('');

    // 帯同（教職員）: 「参加」の一覧の上に、教職員用の表（教職員番号・名前・役職・所属）を別に出す
    const accompanyNames = attendanceFilter === 'attend' ? splitNamesList((currentEvent() || {}).Accompany) : [];
    const staffRowsHtml = accompanyNames.map(name => {
        const m = membersCache.find(x => x.Name === name);
        const role = m ? memberRoleOf(m) : '';
        const roleInfo = role ? getRoleDisplay(role) : null;
        const roleBadge = roleInfo ? `<span class="cat-badge" style="background:${roleInfo.color};">${escapeHtml(role)}</span>` : '';
        return `
            <tr ${m ? `data-staff-id="${escapeAttr(m.ID)}" class="clickable-row" title="タップで詳細を表示"` : ''}>
                <td>${escapeHtml(m && m.StudentID ? m.StudentID : '')}</td>
                <td class="cell-name">${escapeHtml(name)}</td>
                <td class="cell-role">${roleBadge}</td>
                <td>${escapeHtml(m && m.Affiliation ? m.Affiliation : '')}</td>
            </tr>`;
    }).join('');
    const staffTableHtml = accompanyNames.length > 0 ? `
        <div class="attendance-staff">
            <div class="attendance-staff-title">帯同 <span class="attendance-staff-note">（参加人数に含まない）</span></div>
            <div class="table-wrapper">
                <table class="data-table attendance-table">
                    <thead><tr><th>教職員番号</th><th>名前</th><th>役職</th><th>所属</th></tr></thead>
                    <tbody>${staffRowsHtml}</tbody>
                </table>
            </div>
        </div>` : '';

    body.innerHTML = `
        ${tabsHtml}
        ${staffTableHtml}
        <div class="table-wrapper">
            <table class="data-table attendance-table">
                <thead><tr><th>学籍番号</th><th>名前</th><th>役職</th><th>メモ</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `;
    body.querySelectorAll('tr[data-id]').forEach(row => {
        row.addEventListener('click', () => openMemberDetailModal(row.dataset.id, membersCache, { hideFurigana: true }));
    });
    body.querySelectorAll('tr[data-staff-id]').forEach(row => {
        row.addEventListener('click', () => openStaffDetailModal(row.dataset.staffId));
    });
}

// ---- 振り返り記入サブタブ ----

function renderReflectionTab() {
    const box = document.getElementById('series-reflection-entry');
    if (!box) return;
    const ev = currentEvent();
    if (!ev) { box.innerHTML = ''; return; }

    const isMeeting = isMeetingCategory(ev.Category);
    const parts = normalizeParts(ev.PartsList).filter(p => p.name || (p.presenters && p.presenters.length));

    box.innerHTML = `
        <div class="detail-section-card" id="series-detail-feedback">
            <h3 class="detail-section-title">この回の振り返りを記入</h3>
            ${!isMeeting && parts.filter(p => p.name).length > 0 ? `
            <div id="series-exp-feedback">
                ${parts.filter(p => p.name).map(p => `
                    <div class="exp-fb-card" data-exp-name="${escapeAttr(p.name)}" data-exp-id="${escapeAttr((experimentsCache.find(x => x.Name === p.name) || {}).ID || '')}">
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
        `<button type="button" role="tab" aria-selected="${resultsGrandTab === key}" class="grandchild-tab ${resultsGrandTab === key ? 'active' : ''}" data-gtab="${escapeAttr(key)}" onclick="switchResultsGrandTab(this)">${escapeHtml(label)}</button>`;

    box.innerHTML = `
        <div class="grandchild-tab-bar" role="tablist" aria-label="振り返りの対象">
            ${tabBtn('venue', '会場・運営')}
            ${expNames.map(n => tabBtn('exp:' + n, n)).join('')}
        </div>
        <div id="series-results-pane" role="tabpanel"></div>
    `;
    renderResultsPane();
}

function switchResultsGrandTab(btn) {
    resultsGrandTab = btn.dataset.gtab;
    document.querySelectorAll('#series-results-view .grandchild-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
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
                    <button type="button" class="sfb-event-link" data-action="es-open-occ" data-id="${escapeAttr(ev.ID)}">${escapeHtml(ev.Date || '')} (${dayOfWeekJP(ev.Date)})</button>
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
            ${en.eventId ? `<button type="button" class="sfb-event-link" data-action="es-open-occ" data-id="${escapeAttr(en.eventId)}">${escapeHtml(en.date || '')}</button>` : `<span class="sfb-date">${escapeHtml(en.date || '')}</span>`}
        </div>`;
    }).join('')}</div>`;
}

// ---- 書類ステータス・振り返りの保存（楽観的UI + 競合検知） ----

async function saveDocStatus(id, field, value) {
    const ev = allEventsData.find(e => e.ID === id);
    if (!ev) return;
    if ((ev[field] || '') === value) return;

    const def = field === 'KyokaStatus' ? KYOKA_STATUS : REPORT_STATUS;
    const docName = field === 'KyokaStatus' ? '許可願' : '報告書';
    const rerender = () => { filterSeries(); renderDetail(); };
    await saveEventPatch(id, { [field]: value }, seriesPatchOpts({
        successMessage: `${docName}を「${(def[value] || def['']).label}」にしました`,
        onOptimistic: rerender,
        onRollback: rerender
    }));
}

async function saveDetailFeedback() {
    const ev = currentEvent();
    if (!ev) return;

    const positives = document.getElementById('series-fb-positives')?.value || '';
    const reflections = document.getElementById('series-fb-reflections')?.value || '';

    const saveBtn = document.getElementById('series-fb-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

    // 失敗（競合を含む）はヘルパーがトースト表示・ロールバックする。入力欄はそのまま残す
    const ok = await saveEventPatch(ev.ID, { Positives: positives, Reflections: reflections }, seriesPatchOpts({ conflictDuration: 5000 }));
    if (!ok) {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
        return;
    }
    filterSeries();

    // 実験ごとの振り返りの保存に失敗したら、成功トーストは出さず、入力を残したままエラーを表示する
    const failures = await saveExperimentFeedbackEntries(ev);
    if (failures.length > 0) {
        toast('イベントの振り返りは保存しましたが、実験ごとの振り返りを保存できませんでした（' + failures.join('、') + '）。保存できなかった分の入力は残してあります。', 'error', 8000);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
        renderFeedbackTimeline();
        renderResultsTab();
        return;
    }

    toast('保存しました', 'success');
    renderDetail();
    renderReflectionTab();
    renderFeedbackTimeline();
    // 記入欄と表示は同じ「振り返り」タブに並んでいるので、その場で表示側を描き直す
    renderResultsTab();
}

// 実験ごとの振り返りを、対応する実験レコード（Positives/Reflections の履歴JSON）へ追記する。
// 失敗した実験の説明（文字列）の配列を返す。空配列なら全件成功。
async function saveExperimentFeedbackEntries(eventData) {
    const failures = [];
    const fbCards = document.querySelectorAll('#series-exp-feedback .exp-fb-card');
    if (!fbCards.length) return failures;

    let experiments = (api.loadCache('experiments') || {}).items;
    if (!experiments) {
        try {
            experiments = await api.list('experiments');
            api.saveCache('experiments', experiments);
        } catch (e) {
            return ['実験一覧を取得できません: ' + (e && e.message)];
        }
    }

    for (const fbCard of fbCards) {
        const expName = fbCard.dataset.expName;
        const posText = (fbCard.querySelector('.exp-fb-positive')?.value || '').trim();
        const refText = (fbCard.querySelector('.exp-fb-reflection')?.value || '').trim();
        if (!posText && !refText) continue;

        // 記入欄を表示した時点で引いた実験の ID で探す（そのあと実験名が変わっても、同じ実験に書ける）。
        // ID が無い（表示時に見つからなかった）ときだけ、名前で探す
        const expId = fbCard.dataset.expId || '';
        const exp = (expId && experiments.find(e => e.ID === expId)) || experiments.find(e => e.Name === expName);
        if (!exp) {
            // 黙って飛ばすと、保存できたように見えて入力が消える。失敗として知らせ、入力欄は残す
            failures.push(`${expName}: 実験ネタが見つかりません（名前が変わった可能性があります）`);
            continue;
        }

        const prevPositives = exp.Positives;
        const prevReflections = exp.Reflections;
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
            // 保存できた実験の入力欄は空にする（ほかの実験が失敗して「保存」を押し直したとき、二重に追記しないため）
            fbCard.querySelectorAll('.exp-fb-positive, .exp-fb-reflection').forEach(t => { t.value = ''; });
        } catch (e) {
            // 失敗した分は追記前の状態に戻す（再保存で二重に追記されないように）
            exp.Positives = prevPositives;
            exp.Reflections = prevReflections;
            const reason = String(e && e.message).includes('conflict') ? '他の人が編集中' : (e && e.message);
            failures.push(`${expName}: ${reason}`);
            console.warn('Experiment feedback save failed for', expName, e);
        }
    }

    api.saveCache('experiments', experiments);
    experimentsCache = experiments;
    return failures;
}

// ---- 人名のチップ表示（詳細の表で、担当者・運転者・同乗者などを人ごとに分けて見せる） ----

// 名前をカンマ区切りで受け取り、1 人 1 チップにする。メンバー名と一致すれば押して詳細を開ける（教職員は教職員用の詳細）。
function personChipsHtml(namesStr) {
    const names = splitNamesList(namesStr);
    if (names.length === 0) return '';
    return '<span class="person-chips">' + names.map(name => {
        const member = membersCache.find(m => m.Name === name);
        if (!member) return `<span class="person-chip">${escapeHtml(name)}</span>`;
        const role = memberRoleOf(member);
        const isStaff = role === 'アドバイザー' || role === 'コーディネーター';
        const action = isStaff ? 'es-staff-detail' : 'es-member-detail';
        return `<button type="button" class="person-chip is-link" data-action="${action}" data-id="${escapeAttr(member.ID)}">${escapeHtml(name)}</button>`;
    }).join('') + '</span>';
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
            <button type="button" class="fy-header ${isRecent ? 'open' : ''}" aria-expanded="${isRecent}" data-action="fy-toggle">
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
                        <button type="button" class="sfb-event-link" data-action="es-open-occ" data-id="${escapeAttr(f.id)}">${escapeHtml(f.date)}</button>
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

// ---- タブ切り替え ----

// 1段フラットタブの切り替え。概要・出欠・振り返りは選択中の開催回、
// 会場は全開催回が対象（data-zone="series"）。会場のときだけ対象範囲バーを出す。
function switchSeriesTab(btn) {
    document.querySelectorAll('.scope-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

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
