/**
 * 実験詳細ページ
 * 実験の全情報 + 振り返りタイムライン（年度別折りたたみ）を表示。
 * 振り返りはイベント経由 or 直接追加でき、実験レコードに蓄積される。
 */

let currentExp = null;
let allExperiments = [];
let allEvents = [];
let feedbackFilter = 'all';
let expEventsData = [];

document.addEventListener('DOMContentLoaded', () => {
    bootPage('experiments', init);
});

// currentExp を更新して保存する共通処理（JSON 列の parse → 変更 → stringify → save → 反映）。
// mutator(draft) は currentExp の浅いコピー draft を書き換える（false を返すと「変更なし」として保存せず null を返す）。
// 保存に成功してから currentExp / allExperiments / キャッシュへ反映するので、失敗時（例外）は currentExp は変わらない。
// 呼び出しは直列化され、mutator は常に直前の保存結果（最新の UpdatedAt）に対して実行される。
// 競合（他の人が先に更新）で保存できなかったら、サーバーの最新で currentExp を差し替える状態にする。
// 差し替えないと、再読込するまで何度保存しても同じ競合で失敗し続ける。入力欄や画面の表示はここでは触らない
// （開いている編集欄の入力を消さないため）。差し替えられたら true、取れなかったら false。
async function refreshCurrentExpAfterConflict() {
    try {
        const list = await api.list('experiments');
        const fresh = list.find(x => x.ID === currentExp.ID);
        if (!fresh) return false;
        Object.assign(currentExp, fresh);
        const idx = list.findIndex(x => x.ID === currentExp.ID);
        list[idx] = currentExp;
        allExperiments = list;
        api.saveCache('experiments', allExperiments);
        return true;
    } catch (_) {
        return false;
    }
}

let _expPersistChain = Promise.resolve();
function persistCurrentExp(mutator) {
    const run = async () => {
        const draft = { ...currentExp };
        if (mutator(draft) === false) return null;
        let saved;
        try {
            saved = await api.save('experiments', { ...draft, _baseUpdatedAt: currentExp.UpdatedAt || '' });
        } catch (e) {
            // 失敗は呼び出し元に伝える。競合なら最新を取り込んだことを印にして（文言が変わる）、もう一度保存できるようにする
            if (isConflictError(e)) e.refreshed = await refreshCurrentExpAfterConflict();
            throw e;
        }
        Object.assign(currentExp, saved);
        const idx = allExperiments.findIndex(e => e.ID === currentExp.ID);
        if (idx >= 0) allExperiments[idx] = currentExp;
        api.saveCache('experiments', allExperiments);
        return saved;
    };
    const p = _expPersistChain.catch(() => {}).then(run);
    _expPersistChain = p;
    return p;
}

// 「読み込み中」のスピナーを止めて、エラー・未発見メッセージに置き換える
function showLoadMessage(html) {
    const el = document.getElementById('exp-loading');
    el.classList.remove('loading-text');
    el.innerHTML = html;
}

async function init() {
    bindOverlayClose(document.getElementById('feedback-modal'), closeFeedbackModal);
    bindOverlayClose(document.getElementById('video-modal'), closeVideoModal);
    document.getElementById('fb-privacy-note').textContent = REFLECTION_PRIVACY_NOTE;

    // 振り返り検索（デバウンスは search.js。候補リストが無いのでサジェストは出ない）
    attachSearchBox(document.getElementById('feedback-search'), {
        onSearch: () => renderFeedback()
    });

    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
        showLoadMessage(`<div class="empty-state">
            <div class="empty-text">実験IDが指定されていません</div>
            <a href="experiments.html" class="btn btn-secondary" style="text-decoration:none;">実験一覧へ戻る</a>
        </div>`);
        return;
    }

    const cached = api.loadCache('experiments');
    if (cached && cached.items) {
        allExperiments = cached.items;
        currentExp = allExperiments.find(e => e.ID === id);
    }
    const evCached = api.loadCache('events');
    if (evCached && evCached.items) allEvents = evCached.items;

    if (currentExp) {
        renderPage();
        // 2回目以降の init（競合検知後など）ではキャッシュが無いこともある
        updateSyncStatus('cached', cached ? cached.timestamp : null);
    }

    try {
        allExperiments = await api.list('experiments');
        api.saveCache('experiments', allExperiments);
        currentExp = allExperiments.find(e => e.ID === id);
        if (!currentExp) {
            showLoadMessage(`<div class="empty-state">
                <div class="empty-text">実験が見つかりません</div>
                <div class="empty-hint">削除されたか、リンクが古い可能性があります</div>
                <a href="experiments.html" class="btn btn-secondary" style="text-decoration:none;">実験一覧へ戻る</a>
            </div>`);
            return;
        }
        renderPage();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (e.handled) return;
        if (!currentExp) {
            showLoadMessage(`<div class="empty-state">
                <div class="empty-text">データを読み込めませんでした</div>
                <div class="empty-hint">${escapeHtml(humanizeApiError(e))}</div>
                <button type="button" class="btn btn-secondary" onclick="location.reload()">再読み込み</button>
            </div>`);
        }
        updateSyncStatus('error', null, e.message);
    }

    try {
        allEvents = await api.list('events');
        api.saveCache('events', allEvents);
        renderEventsSection();
        populateEventDropdown();
    } catch (e) {
        if (e.handled) return;
        // 実施イベントの欄は、端末に残っている一覧（取得できていれば）のまま表示する。同期エラーとして知らせる
        console.warn('イベント一覧を取得できませんでした:', e);
        updateSyncStatus('error', null, e.message);
    }
}

function renderPage() {
    document.getElementById('exp-loading').classList.add('hidden');
    document.getElementById('exp-content').classList.remove('hidden');

    const e = currentExp;
    document.title = (e.Name || '実験詳細') + ' | SciComi Site';
    document.getElementById('expd-name').textContent = e.Name || '(無題)';

    const cat = getExperimentCategory(e.Category);
    const badge = document.getElementById('expd-cat-badge');
    badge.textContent = cat.label;
    badge.style.background = cat.color;

    const slidesLink = document.getElementById('expd-slides-link');
    const safeSlides = safeHttpUrl(e.SlidesURL);
    if (safeSlides) {
        slidesLink.href = safeSlides;
        slidesLink.classList.remove('hidden');
    } else {
        slidesLink.classList.add('hidden');
    }

    renderInfoSections();

    renderEventsSection();
    renderFeedback();
    if (!summaryMounted) { summaryMounted = true; refreshReflectionSummary(); }   // キャッシュ → 最新の 2 回描くので、読み込みは 1 回だけ
    renderPhotos();
    renderVideos();
    renderSlides();
    populateEventDropdown();
}

function renderEventsSection() {
    if (!currentExp || !allEvents.length) return;
    const expName = currentExp.Name;
    // 新旧フォーマットの吸収は app.js の normalizeParts に一本化
    const related = allEvents.filter(ev =>
        normalizeParts(ev.PartsList || ev.partsList).some(it => it.name === expName)
    ).sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));

    const sec = document.getElementById('expd-events-section');
    if (related.length === 0) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');

    expEventsData = related;
    renderEventsFyFilterOptions();
    renderEventsList();
}

// 年度の選択肢を作り直す。積み重なった実施回が何年分あっても、年度ごとに絞り込めるようにする。
function renderEventsFyFilterOptions() {
    const sel = document.getElementById('expd-events-fy-select');
    if (!sel) return;

    const counts = {};
    expEventsData.forEach(ev => {
        const fy = getFiscalYear(ev.Date);
        const key = fy === null ? '__none__' : String(fy);
        counts[key] = (counts[key] || 0) + 1;
    });
    const fyKeys = Object.keys(counts).filter(k => k !== '__none__').sort((a, b) => Number(b) - Number(a));

    let html = `<option value="all">すべての年度（${expEventsData.length}件）</option>`;
    html += fyKeys.map(fy => `<option value="${fy}">${fy}年度（${counts[fy]}件）</option>`).join('');
    if (counts['__none__']) html += `<option value="__none__">日付なし（${counts['__none__']}件）</option>`;

    const prev = sel.value;
    sel.innerHTML = html;
    // 実施回が増減しても、選んでいた年度がまだ存在するなら選択状態を保つ
    sel.value = [...sel.options].some(o => o.value === prev) ? prev : 'all';
}

function onEventsFyFilterChange() {
    renderEventsList();
}

function renderEventsList() {
    const sel = document.getElementById('expd-events-fy-select');
    const filter = sel ? sel.value : 'all';
    const list = expEventsData.filter(ev => {
        if (filter === 'all') return true;
        const fy = getFiscalYear(ev.Date);
        return filter === '__none__' ? fy === null : String(fy) === filter;
    });

    const listEl = document.getElementById('expd-events-list');
    if (list.length === 0) {
        listEl.innerHTML = '<p class="empty-state" style="padding:10px 0;">該当する年度の実施イベントはありません</p>';
        return;
    }
    listEl.innerHTML = list.map(ev => {
        const cat = getEventCategory(ev.Category || 'normal');
        return `<a href="events.html?event=${encodeURIComponent(ev.ID)}" class="expd-event-chip" title="${escapeAttr(ev.Title)}">
            <span class="expd-event-date">${escapeHtml(ev.Date || '')}</span>
            <span class="expd-event-title">${escapeHtml(ev.Title || '(無題)')}</span>
            <span class="cat-dot" style="color:${cat.bg};" role="img" aria-label="${cat.short}" title="${cat.short}">&#9679;</span>
        </a>`;
    }).join('');
}

function getAllFeedback() {
    if (!currentExp) return [];
    const pos = parseFeedbackEntries(currentExp.Positives).map(e => ({ ...e, type: 'positive' }));
    const ref = parseFeedbackEntries(currentExp.Reflections).map(e => ({ ...e, type: 'reflection' }));
    return [...pos, ...ref].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// 振り返りのまとめ(AI)。振り返りを追加・削除したあとにも呼んで、「古い」の表示を最新にする
let summaryMounted = false;
function refreshReflectionSummary() {
    if (!currentExp) return;
    mountReflectionSummary(document.getElementById('reflection-summary'), {
        targetType: 'experiments',
        id: currentExp.ID,
        collapsible: true,
        root: () => document.getElementById('feedback-timeline'),
        prepare: () => {
            // 絞り込み・検索で、該当する振り返りが隠れていないようにする
            const search = document.getElementById('feedback-search');
            if (search && search.value) search.value = '';
            filterFeedback('all');
        }
    });
}

// 振り返りの開閉の記憶(年度・会場の見出しの data-key → 開いているか)
const fbOpenState = {};
registerActions({
    'fb-group-toggle': el => {
        toggleFyGroup(el);
        fbOpenState[el.dataset.key] = el.classList.contains('open');
    }
});

function filterFeedback(type) {
    feedbackFilter = type;
    document.querySelectorAll('[data-fb]').forEach(c => {
        const isActive = c.dataset.fb === type;
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-pressed', String(isActive));
    });
    renderFeedback();
}

function renderFeedback() {
    const container = document.getElementById('feedback-timeline');
    let items = getAllFeedback();

    if (feedbackFilter !== 'all') {
        items = items.filter(f => f.type === feedbackFilter);
    }

    // かな・全角半角の揺れ吸収 + AND/-除外/"フレーズ" で照合する（search.js）
    const pq = parseSearchQuery(document.getElementById('feedback-search')?.value || '');
    if (pq) {
        items = items.filter(f =>
            matchesParsedQuery(searchNormalize((f.text || '') + ' ' + (f.eventTitle || '')), pq)
        );
        announceSearchResult(`検索結果 ${items.length}件`);
    }

    if (items.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:30px 20px;">振り返りはまだありません</div>';
        return;
    }

    const grouped = {};
    items.forEach(f => {
        const fy = getFiscalYear(f.date);
        const key = fy ? `${fy}年度` : '日付なし';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(f);
    });

    const fyKeys = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
    const currentFy = getFiscalYear(todayISO());
    const searching = !!pq;   // 検索中は、該当する行が隠れないよう全部開く

    // 開閉の見出し。開閉の状態は fbOpenState に覚えて、追加・削除で描き直しても変わらないようにする
    const group = (key, level, labelHtml, countText, defaultOpen, bodyHtml) => {
        const open = searching || (key in fbOpenState ? fbOpenState[key] : defaultOpen);
        return `
            <div class="fy-group ${level}">
                <button type="button" class="fy-header ${level === 'fb-venue' ? 'fb-venue-header' : ''} ${open ? 'open' : ''}" aria-expanded="${open}" data-action="fb-group-toggle" data-key="${escapeAttr(key)}">
                    <span class="fy-toggle">${open ? '&#9660;' : '&#9654;'}</span>
                    <span class="fy-label">${labelHtml}</span>
                    <span class="fy-count">${countText}</span>
                </button>
                <div class="fy-body ${open ? '' : 'hidden'}">${bodyHtml}</div>
            </div>`;
    };

    container.innerHTML = fyKeys.map(fy => {
        const entries = grouped[fy];
        const isCurrentFy = fy === `${currentFy}年度`;

        // 会場(イベント)ごとに分ける。新しい会場が上、「実験全般」は最後
        const venues = new Map();
        entries.forEach(f => {
            const vKey = f.eventId || f.eventTitle || '__general';
            if (!venues.has(vKey)) venues.set(vKey, { title: f.eventTitle || '', date: f.date || '', list: [] });
            const v = venues.get(vKey);
            if ((f.date || '') > v.date) v.date = f.date;
            v.list.push(f);
        });
        const venueList = [...venues.entries()].sort(([ka, a], [kb, b]) => {
            if ((ka === '__general') !== (kb === '__general')) return ka === '__general' ? 1 : -1;
            return (b.date || '').localeCompare(a.date || '');
        });

        const body = venueList.map(([vKey, v]) => {
            const sub = (type, label, cls) => {
                const list = v.list.filter(f => f.type === type);
                if (!list.length) return '';
                const mark = type === 'positive' ? '&#9675;' : '&#9651;';
                return `<div class="fb-kind-block"><div class="fb-kind-title ${cls}">${mark} ${label}<span class="fb-kind-count">${list.length}件</span></div>${list.map(f => renderFeedbackEntry(f, true)).join('')}</div>`;
            };
            const [, vm, vd] = (v.date || '').split('-');
            const dateLabel = vd ? ` <span class="fb-venue-date">${Number(vm)}月${Number(vd)}日(${dayOfWeekJP(v.date)})</span>` : '';
            const inner = sub('positive', '良かった点', 'fb-positive') + sub('reflection', '改善点', 'fb-reflection');
            return group(`v:${fy}:${vKey}`, 'fb-venue', escapeHtml(v.title || '実験全般') + dateLabel, `${v.list.length}件`, false, inner);
        }).join('');

        const eventCount = venueList.filter(([k]) => k !== '__general').length;
        return group(`y:${fy}`, 'fb-year', escapeHtml(fy), `イベント${eventCount}件`, isCurrentFy || fy === '日付なし', body);
    }).join('');
}

function renderFeedbackEntry(f, inVenue) {
    const cls = f.type === 'positive' ? 'fb-positive' : 'fb-reflection';
    // 会場の見出しの下に置くときは、種類・会場名・日付は見出しが示すので繰り返さない
    const eventTag = inVenue ? ''
        : (f.eventTitle ? `<span class="fb-event-tag">${escapeHtml(f.eventTitle)}</span>` : '<span class="fb-event-tag fb-general">実験全般</span>')
            + (f.date ? `<span class="fb-date">${escapeHtml(f.date)} (${dayOfWeekJP(f.date)})</span>` : '');

    return `
        <div class="fb-entry ${cls}" data-fb-id="${escapeAttr(f.id || '')}">
            ${eventTag ? `<div class="fb-entry-header">${eventTag}</div>` : ''}
            <div class="fb-entry-row">
                <span class="fb-entry-text">${escapeHtml(f.text || '')}${f.name ? ` <span class="fb-entry-name">${escapeHtml(f.name)}</span>` : ''}</span>
                <button class="fb-del-btn" data-action="expd-del-feedback" data-id="${escapeAttr(f.id || '')}" data-type="${escapeAttr(f.type || '')}" title="削除">&#10005;</button>
            </div>
        </div>
    `;
}

function populateEventDropdown() {
    const sel = document.getElementById('fb-event');
    if (!sel || !allEvents.length) return;
    const sorted = allEvents.slice()
        .filter(e => e.Date)
        .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
    sel.innerHTML = '<option value="">-- なし（実験全般） --</option>' +
        sorted.slice(0, 100).map(e =>
            `<option value="${escapeAttr(e.ID)}" data-title="${escapeAttr(e.Title || '')}" data-date="${escapeAttr(e.Date || '')}">${escapeHtml(e.Date)} ${escapeHtml(e.Title || '(無題)')}</option>`
        ).join('');
}

function openAddFeedback() {
    document.getElementById('fb-modal-title').textContent = '振り返りを追加';
    document.getElementById('fb-type').value = 'positive';
    document.getElementById('fb-event').value = '';
    document.getElementById('fb-text').value = '';
    const modal = document.getElementById('feedback-modal');
    modal.classList.remove('hidden');
    bindModalEscape(modal, closeFeedbackModal);
    // Tab がモーダル外へ抜けないよう閉じ込める。静的モーダル（再利用）なので
    // リスナーの多重登録を避けて一度だけ束縛する（要素構成は開くたびに不変）。
    if (!modal._trapBound) { trapFocus(modal.querySelector('.modal-content')); modal._trapBound = true; }
    setTimeout(() => document.getElementById('fb-text')?.focus(), 50);
}

function closeFeedbackModal() {
    document.getElementById('feedback-modal').classList.add('hidden');
}

async function saveFeedback() {
    const text = document.getElementById('fb-text').value.trim();
    if (!text) { toast('内容を入力してください', 'error'); document.getElementById('fb-text').focus(); return; }

    const saveBtn = document.getElementById('fb-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

    const type = document.getElementById('fb-type').value;
    const eventSel = document.getElementById('fb-event');
    const selectedOpt = eventSel.selectedOptions[0];
    const eventId = eventSel.value;
    const eventTitle = selectedOpt ? (selectedOpt.dataset.title || '') : '';
    const eventDate = selectedOpt ? (selectedOpt.dataset.date || '') : '';

    const field = type === 'positive' ? 'Positives' : 'Reflections';
    const newEntry = {
        id: genFeedbackId(),
        date: eventDate || todayISO(),
        eventId: eventId,
        eventTitle: eventTitle,
        text: text
    };

    try {
        await persistCurrentExp(draft => {
            const entries = parseFeedbackEntries(draft[field]);
            entries.push(newEntry);
            draft[field] = stringifyFeedbackEntries(entries);
        });
        closeFeedbackModal();
        renderFeedback();
        refreshReflectionSummary();
        toast('振り返りを保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + humanizeApiError(e), 'error', 5000);
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
    }
}

function deleteFeedbackEntry(fbId, type) {
    if (!fbId || !currentExp) return;
    // 他ページと同じ確認ダイアログ（ネイティブ confirm は使わない）
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';
    overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <h3>振り返りを削除</h3>
            <p>この振り返りエントリを削除しますか？${escapeHtml(TRASH_KEEP_NOTE)}</p>
            <div class="confirm-dialog-actions">
                <button class="btn btn-secondary" onclick="this.closest('.confirm-dialog-overlay').remove()">キャンセル</button>
                <button class="btn btn-danger" id="confirm-fb-del-btn">削除する</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    bindModalEscape(overlay, () => overlay.remove());
    overlay.querySelector('#confirm-fb-del-btn').onclick = () => {
        overlay.remove();
        executeDeleteFeedbackEntry(fbId, type);
    };
}

async function executeDeleteFeedbackEntry(fbId, type) {
    const field = type === 'positive' ? 'Positives' : 'Reflections';
    try {
        const saved = await persistCurrentExp(draft => {
            const entries = parseFeedbackEntries(draft[field]);
            const idx = entries.findIndex(e => e.id === fbId);
            if (idx < 0) return false;
            entries.splice(idx, 1);
            draft[field] = stringifyFeedbackEntries(entries);
        });
        if (!saved) { toast('エントリが見つかりません', 'error'); return; }
        renderFeedback();
        refreshReflectionSummary();
        toast('ゴミ箱に移動しました', 'success');
    } catch (e) {
        toast('削除失敗: ' + humanizeApiError(e), 'error');
    }
}

// ---- Tab switching ----

// 実験詳細のタブ切り替え（experiments.js の switchExpTab は一覧のカテゴリ切り替えで、引数の型が違う。名前を分けてある）
function switchExpdTab(btn) {
    document.querySelectorAll('.expd-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const target = btn.dataset.tab;
    document.querySelectorAll('.expd-tab-pane').forEach(p => {
        p.classList.toggle('hidden', p.dataset.tabPane !== target);
    });
}

// ---- Photo Gallery ----

const PHOTO_LIMIT = 15;

function renderPhotos() {
    const gallery = document.getElementById('expd-photo-gallery');
    if (!gallery || !currentExp) return;

    const photos = getPhotos(currentExp);

    const adminBtn = document.getElementById('photo-add-btn');
    if (adminBtn) {
        adminBtn.classList.toggle('hidden', photos.length >= PHOTO_LIMIT);
    }

    if (photos.length === 0) {
        gallery.innerHTML = '<p class="empty-state" style="padding:30px 20px;">写真はまだありません</p>';
        return;
    }

    // 画像の表示 URL は fileImageUrl(api.js)が決める(R2 の公開 URL、旧 Drive の URL の両方に対応)
    gallery.innerHTML = photos.map((p, i) => {
        // URL は http(s) のみ通す(javascript: 等は描画しない)。画像の読み込み失敗時の代替は data-fallback(app.js の error 委譲)
        const thumb = safeHttpUrl(fileImageUrl(p, 1600));
        const openUrl = safeHttpUrl(p.url) || thumb;
        const fallback = safeHttpUrl(p.url) || thumb;
        return `
        <div class="photo-item">
            ${thumb ? `<a href="${escapeAttr(openUrl)}" target="_blank" rel="noopener" title="${escapeAttr(p.name || '')}">
                <img src="${escapeAttr(thumb)}" alt="${escapeAttr(p.name || '')}" loading="lazy"
                     referrerpolicy="no-referrer" data-fallback="${escapeAttr(fallback)}">
            </a>` : `<span class="empty-state">表示できない画像</span>`}
            <button class="photo-delete" data-action="expd-del-photo" data-index="${i}" title="削除">✕</button>
        </div>`;
    }).join('');
}

function openPhotoUpload() {
    if (getPhotos(currentExp).length >= PHOTO_LIMIT) { toast(`写真は最大${PHOTO_LIMIT}枚までです`, 'error'); return; }
    document.getElementById('photo-file-input').click();
}

async function handlePhotoSelect(input) {
    const files = Array.from(input.files);
    input.value = '';
    if (!files.length) return;

    const remaining = PHOTO_LIMIT - getPhotos(currentExp).length;
    const toUpload = files.slice(0, remaining);

    const uploaded = [];
    for (const file of toUpload) {
        if (file.size > getFileMaxMB() * 1024 * 1024) { toast(file.name + ' は' + getFileMaxMB() + 'MBを超えています', 'error'); continue; }
        toast('アップロード中: ' + file.name, 'info', 2000);
        try {
            const result = await api.uploadFile(file);  // api.uploadFile は引数1つ（第2引数は無効だったため削除）
            uploaded.push({ name: file.name, url: result.url, driveId: result.driveId, size: file.size });
        } catch (e) {
            toast('アップロード失敗: ' + humanizeApiError(e), 'error');
        }
    }
    if (uploaded.length === 0) return;

    try {
        // 枚数の上限は、保存の直前の最新の記録に対して判定する(アップロード中・保存中に続けて選ばれても、上限を超えない)
        let accepted = [];
        await persistCurrentExp(draft => {
            const room = PHOTO_LIMIT - getPhotos(draft).length;
            accepted = uploaded.slice(0, Math.max(0, room));
            if (accepted.length === 0) return false;
            draft.Photos = JSON.stringify(getPhotos(draft).concat(accepted));
        });
        // 上限を超えた分は記録に載せていない(保存の成否が確定している)ので、アップロード済みの実体を消す
        const rejected = uploaded.filter(p => accepted.indexOf(p) < 0);
        if (rejected.length) deleteStoredFiles(rejected.map(p => p.driveId));
        if (accepted.length === 0) { toast(`写真は最大${PHOTO_LIMIT}枚までです`, 'error'); return; }
        renderPhotos();
        toast(rejected.length ? `写真は最大${PHOTO_LIMIT}枚までのため、${accepted.length}枚だけ保存しました` : '写真を保存しました', rejected.length ? 'info' : 'success');
    } catch (e) {
        toast('保存失敗: ' + humanizeApiError(e), 'error');
        // 競合で保存されなかったときだけ、記録に載らなかったアップロード済みファイルを消す。
        // タイムアウトなどでは保存済みの可能性があり、消すと記録の参照先が無くなるので残す。
        if (isConflictError(e)) deleteStoredFiles(uploaded.map(p => p.driveId));
    }
}

function deletePhoto(index) {
    const photo = getPhotos(currentExp)[index];
    if (!photo) return;

    const name = photo.name || '';
    showConfirmDialog({
        title: '写真を削除',
        message: (name ? `「${name}」を削除します。` : 'この写真を削除します。') + TRASH_KEEP_NOTE,
        okLabel: '削除する',
        danger: true,
        onOk: () => executeDeletePhoto(photo)
    });
}

// 写真の同一判定（他の保存で並びが変わっていても正しい 1 枚を消せるよう、位置ではなく実体で探す）
function _samePhoto(a, b) {
    if (a.driveId || b.driveId) return a.driveId === b.driveId;
    return a.url === b.url && a.name === b.name;
}

async function executeDeletePhoto(photo) {
    try {
        const saved = await persistCurrentExp(draft => {
            const photos = getPhotos(draft);
            const idx = photos.findIndex(p => _samePhoto(p, photo));
            if (idx < 0) return false;
            photos.splice(idx, 1);
            draft.Photos = JSON.stringify(photos);
        });
        if (!saved) { toast('写真が見つかりません（すでに削除されています）', 'error'); renderPhotos(); return; }
        renderPhotos();
        toast('写真をゴミ箱に移動しました', 'success');   // 実体（R2）はゴミ箱の期限まで残る
    } catch (e) {
        // showConfirmDialog は onOk が例外を投げると別トーストで再通知するため、ここでは投げずに独自通知のみ行う
        toast('削除失敗: ' + humanizeApiError(e), 'error');
    }
}

// ---- 発表資料（パワポ・PDF。Slides 列。形は Photos と同じ { name, url, driveId, size, uploadedAt }） ----

const SLIDE_LIMIT = 30;
const SLIDE_NAME_MAX = 120;
const SLIDE_SORT_KEY = 'scicomi_slide_sort';   // 並び順（'date:desc' など。列は name / date）。端末ごとの好み

function getSlides(exp) {
    return parseJsonArray((exp || currentExp).Slides);
}

// 資料の同一判定のキー（並びが変わっても正しい 1 件を指せるよう、位置ではなく実体で探す。写真の _samePhoto と同じ考え方）
function slideKey(s) {
    return String((s && (s.driveId || s.url)) || '');
}

// 並び順 { key: 'name' | 'date' | 'size', dir: 'asc' | 'desc' }。既定はアップロード日の新しい順。
// 以前の形（'asc' / 'desc' だけ）は、アップロード日の並びとして読む
function getSlideSort() {
    let v = '';
    try { v = localStorage.getItem(SLIDE_SORT_KEY) || ''; } catch (_) { /* 読めなければ既定 */ }
    if (v === 'asc' || v === 'desc') v = 'date:' + v;
    const m = /^(name|date|size):(asc|desc)$/.exec(v);
    return m ? { key: m[1], dir: m[2] } : { key: 'date', dir: 'desc' };
}

// 見出しを押したとき。同じ列なら向きを反転、別の列なら、その列の自然な向き（名前は昇順、日付は新しい順、サイズは大きい順）から始める
function sortSlidesBy(key) {
    if (key !== 'name' && key !== 'date' && key !== 'size') return;
    const cur = getSlideSort();
    const next = cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' };
    try { localStorage.setItem(SLIDE_SORT_KEY, next.key + ':' + next.dir); } catch (_) { /* 保存できなくても、この表示では切り替える */ }
    renderSlides(next);
    // 描き直しで押したボタンが消えるので、同じ列の見出しにフォーカスを戻す（キーボード操作を続けられるように）
    const btn = document.querySelector(`#expd-slide-list [data-action="expd-sort-slides"][data-key="${key}"]`);
    if (btn) btn.focus();
}

// アップロード日時（日本時間の YYYY-MM-DD HH:mm）。uploadedAt が無い・不正なら空
function slideDateText(s) {
    const ms = Date.parse(s && s.uploadedAt);
    if (!isFinite(ms)) return '';
    const p = jstParts(ms);
    const z = n => String(n).padStart(2, '0');
    return p.y + '-' + z(p.m) + '-' + z(p.d) + ' ' + z(p.hh) + ':' + z(p.mm);
}

// 拡張子（小文字、ドット付き）。無ければ空
function slideExt(name) {
    const m = /\.[A-Za-z0-9]{1,8}$/.exec(String(name || ''));
    return m ? m[0].toLowerCase() : '';
}

// 入力された名前を整える。空なら元の名前。拡張子を消してしまっても、元の拡張子を付け直す（開き方の判定に使うため）
// 画面で編集するのは拡張子を除いた名前だけ。拡張子は元のものを必ず付け直す
function slideExtRaw(name) {
    const m = /\.[A-Za-z0-9]{1,8}$/.exec(String(name || ''));
    return m ? m[0] : '';
}

function slideBaseName(name) {
    const s = String(name || '');
    return s.slice(0, s.length - slideExtRaw(s).length);
}

function normalizeSlideName(input, original) {
    const name = String(input || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!name) return String(original || '資料');
    const ext = slideExtRaw(original);
    return name.slice(0, SLIDE_NAME_MAX - ext.length) + ext;
}

// 名前の入力欄の右に、変えられない拡張子を並べる
function slideNameFieldHtml(attrs) {
    return `<div class="slide-name-field" style="display:flex;align-items:center;gap:6px;">
        <input type="text" class="e1-input" style="flex:1;min-width:0;" ${attrs}>
        <span class="slide-name-ext" style="flex:none;color:var(--text-muted);"></span>
    </div>`;
}

// 一覧はエクスプローラーのような表（ファイル名・アップロード日・サイズ・編集）。ファイル名とアップロード日の見出しで並べ替える
function renderSlides(order) {
    const list = document.getElementById('expd-slide-list');
    if (!list || !currentExp) return;
    const sort = order || getSlideSort();
    const slides = getSlides();
    if (slides.length === 0) {
        list.innerHTML = '<p class="empty-state" style="padding:30px 20px;">資料はまだありません</p>';
        return;
    }
    // 日時が無いものは、向きに関わらず最後。同じ値なら保存されている順
    const time = s => { const t = Date.parse(s && s.uploadedAt); return isFinite(t) ? t : null; };
    const sign = sort.dir === 'asc' ? 1 : -1;
    const sorted = slides.map((s, i) => ({ s, i })).sort((a, b) => {
        if (sort.key === 'name') {
            const c = String(a.s.name || '').localeCompare(String(b.s.name || ''), 'ja', { numeric: true, sensitivity: 'base' });
            return sign * c || a.i - b.i;
        }
        if (sort.key === 'size') {
            // サイズが分からないものは、向きに関わらず最後
            const sz = s => { const n = Number(s && s.size); return n > 0 ? n : null; };
            const za = sz(a.s), zb = sz(b.s);
            if (za === null || zb === null) return (za === null) - (zb === null) || a.i - b.i;
            return sign * (za - zb) || a.i - b.i;
        }
        const ta = time(a.s), tb = time(b.s);
        if (ta === null || tb === null) return (ta === null) - (tb === null) || a.i - b.i;
        return sign * (ta - tb) || a.i - b.i;
    }).map(x => x.s);

    const head = (key, label) => {
        const active = sort.key === key;
        const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        const mark = active ? (sort.dir === 'asc' ? '▲' : '▼') : '';
        return `<th scope="col" class="slide-col-${key}" aria-sort="${ariaSort}">
            <button type="button" class="slide-th-sort${active ? ' active' : ''}" data-action="expd-sort-slides" data-key="${key}">${label}${mark ? `<span class="slide-sort-mark" aria-hidden="true">${mark}</span>` : ''}</button>
        </th>`;
    };

    const rows = sorted.map(f => {
        const url = safeHttpUrl(f && f.url);
        const name = (f && f.name) || '資料';
        const dt = slideDateText(f);   // 'YYYY-MM-DD HH:mm'
        const [day, hm] = dt ? dt.split(' ') : ['', ''];
        const size = formatFileSize(f && f.size);
        // 名前のリンクは fileOpenUrl を通す（パワポは Office Online ビューア、PDF はブラウザで開く）
        return `
        <tr>
            <td class="slide-col-name">${url
                ? `<a class="slide-name" href="${escapeAttr(fileOpenUrl(url))}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
                : escapeHtml(name)}</td>
            <td class="slide-col-date">${day ? `<span class="slide-day">${escapeHtml(day)}</span> <span class="slide-time">${escapeHtml(hm)}</span>` : '<span class="slide-time">不明</span>'}</td>
            <td class="slide-col-size">${escapeHtml(size || '—')}</td>
            <td class="slide-col-edit"><button type="button" class="slide-edit" data-action="expd-slide-menu" data-key="${escapeAttr(slideKey(f))}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeAttr(name + ' のメニュー')}" title="メニュー">⋯</button></td>
        </tr>`;
    }).join('');

    list.innerHTML = `
        <table class="slide-table">
            <thead><tr>
                ${head('name', 'ファイル名')}
                ${head('date', 'アップロード日')}
                ${head('size', 'サイズ')}
                <th scope="col" class="slide-col-edit">操作</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// 「⋯」のメニュー(ダウンロード・名前の変更・削除)。同じ「⋯」をもう一度押すか、外を押す・Esc・スクロールで閉じる
let slideMenuClose = null;
function closeSlideMenu() { if (slideMenuClose) slideMenuClose(); }

function openSlideMenu(btn) {
    const reopen = btn.getAttribute('aria-expanded') === 'true';
    closeSlideMenu();
    if (reopen) return;
    const key = btn.dataset.key;
    const slide = getSlides(currentExp).find(s => slideKey(s) === key);
    if (!slide) { toast('資料が見つかりません（すでに削除されています）', 'error'); renderSlides(); return; }

    const menu = document.createElement('div');
    menu.className = 'account-menu slide-menu';
    menu.setAttribute('role', 'menu');
    const items = [
        { label: 'ダウンロード', run: () => downloadSlide(key), off: !safeHttpUrl(slide.url) },
        { label: '名前の変更', run: () => openSlideEdit(key) },
        { label: '削除', run: () => deleteSlide(key), danger: true }
    ];
    items.forEach(it => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.className = 'account-menu-item' + (it.danger ? ' account-menu-danger' : '');
        b.textContent = it.label;
        b.disabled = !!it.off;
        b.onclick = () => { closeSlideMenu(); it.run(); };
        menu.appendChild(b);
    });
    document.body.appendChild(menu);

    // ボタンの下に、右端をそろえて出す。画面からはみ出すときは上に出す
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = (r.bottom + mh + 8 > window.innerHeight && r.top - mh - 4 > 0 ? r.top - mh - 4 : r.bottom + 4) + 'px';
    btn.setAttribute('aria-expanded', 'true');

    const onDoc = ev => { if (!menu.contains(ev.target) && ev.target !== btn) closeSlideMenu(); };
    const onKey = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); closeSlideMenu(); btn.focus(); return; }
        if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
        const els = Array.from(menu.querySelectorAll('button:not(:disabled)'));
        const i = els.indexOf(document.activeElement);
        ev.preventDefault();
        els[(i + (ev.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length].focus();
    };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', closeSlideMenu, true);
    window.addEventListener('resize', closeSlideMenu);
    slideMenuClose = () => {
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('scroll', closeSlideMenu, true);
        window.removeEventListener('resize', closeSlideMenu);
        menu.remove();
        btn.setAttribute('aria-expanded', 'false');
        slideMenuClose = null;
    };
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus();
}

// ダウンロード。PDF・画像はリンクを押すとブラウザ内で開いてしまうので、取得して、表示している名前で保存する。
// 取得できないとき(通信エラーなど)は、元のリンクを新しいタブで開く
async function downloadSlide(key) {
    const slide = getSlides(currentExp).find(s => slideKey(s) === key);
    const url = slide && safeHttpUrl(slide.url);
    if (!url) { toast('資料が見つかりません（すでに削除されています）', 'error'); return; }
    const name = slide.name || '資料';
    toast('ダウンロードを準備しています', 'info');
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('http_' + res.status);
        const href = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = href; a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 60000);
    } catch (_) {
        window.open(url, '_blank', 'noopener');
    }
}

function openSlideUpload() {
    if (getSlides(currentExp).length >= SLIDE_LIMIT) { toast(`資料は最大${SLIDE_LIMIT}件までです`, 'error'); return; }
    document.getElementById('slide-file-input').click();
}

// 資料タブのダイアログ（アップロード前の名前の確認・名前の変更）の共通部分。閉じる関数を返す
function openSlideDialog(title, bodyHtml) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const titleId = 'slide-dialog-title-' + Date.now();
    overlay.innerHTML = `
        <div class="modal-content" style="max-width:520px;" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
            <div class="modal-header"><h2 id="${titleId}"></h2></div>
            <div class="modal-body">${bodyHtml}</div>
        </div>`;
    overlay.querySelector('h2').textContent = title;
    document.body.appendChild(overlay);
    let cleanup = () => {};
    const close = () => { cleanup(); overlay.remove(); };
    bindOverlayClose(overlay, close);
    cleanup = bindModalEscape(overlay, close) || (() => {});
    trapFocus(overlay.querySelector('.modal-content'));
    return { overlay, close };
}

// ファイルを選んだら、アップロードの前に名前を確かめて変えられるダイアログを出す
function handleSlideSelect(input) {
    const files = Array.from(input.files);
    input.value = '';
    if (!files.length) return;

    const remaining = SLIDE_LIMIT - getSlides(currentExp).length;
    if (remaining <= 0) { toast(`資料は最大${SLIDE_LIMIT}件までです`, 'error'); return; }
    if (files.length > remaining) toast(`資料は最大${SLIDE_LIMIT}件までのため、先頭の${remaining}件だけアップロードします`, 'info');
    const maxBytes = getFileMaxMB() * 1024 * 1024;
    const picked = files.slice(0, remaining);
    const ok = picked.filter(f => f.size <= maxBytes);
    picked.filter(f => f.size > maxBytes).forEach(f => toast(f.name + ' は' + getFileMaxMB() + 'MBを超えているため、アップロードできません', 'error'));
    if (!ok.length) return;

    const rows = ok.map((f, i) => `
        <div class="e1-group slide-name-row">
            <label class="e1-label">ファイル名${ok.length > 1 ? `（${i + 1}）` : ''}</label>
            ${slideNameFieldHtml(`data-index="${i}" maxlength="${SLIDE_NAME_MAX - slideExtRaw(ok[i].name).length}"`)}
            <p class="settings-hint slide-name-hint"></p>
        </div>`).join('');
    const dlg = openSlideDialog('資料をアップロード', `
        <p class="expd-note" style="margin-top:0;">表示する名前を変えられます（あとからでも変えられます）。拡張子は変えられません。</p>
        ${rows}
        <div class="action-buttons">
            <button type="button" class="btn btn-text" data-role="cancel">キャンセル</button>
            <button type="button" class="btn btn-primary-solid" style="width:auto;" data-role="ok">アップロード${ok.length > 1 ? `（${ok.length}件）` : ''}</button>
        </div>`);
    const inputs = Array.from(dlg.overlay.querySelectorAll('input[data-index]'));
    inputs.forEach((el, i) => {
        el.value = slideBaseName(ok[i].name);
        el.closest('.slide-name-field').querySelector('.slide-name-ext').textContent = slideExtRaw(ok[i].name);
        el.closest('.slide-name-row').querySelector('.slide-name-hint').textContent = '元のファイル: ' + ok[i].name + '（' + formatFileSize(ok[i].size) + '）';
    });
    dlg.overlay.querySelector('[data-role="cancel"]').onclick = dlg.close;
    dlg.overlay.querySelector('[data-role="ok"]').onclick = () => {
        const names = inputs.map((el, i) => normalizeSlideName(el.value, ok[i].name));
        dlg.close();
        uploadSlides(ok.map((file, i) => ({ file, name: names[i] })));
    };
    setTimeout(() => { if (inputs[0]) { inputs[0].focus(); inputs[0].select(); } }, 50);
}

// アップロード中の 1 件の行（進み具合を出す）。戻り値の set(割合) で更新し、remove() で消す
function addSlideUploadingRow(name, size) {
    const wrap = document.getElementById('slide-uploading');
    const row = document.createElement('div');
    row.className = 'file-item uploading';
    row.innerHTML = `<span class="file-name"></span><span class="file-size"></span>
        <progress class="slide-progress" max="100" value="0"></progress>`;
    row.querySelector('.file-name').textContent = name;
    row.querySelector('.file-size').textContent = formatFileSize(size);
    const bar = row.querySelector('progress');
    bar.setAttribute('aria-label', name + ' のアップロード');
    wrap.appendChild(row);
    return {
        set: ratio => { bar.value = Math.round(Math.max(0, Math.min(1, ratio)) * 100); },
        remove: () => row.remove()
    };
}

async function uploadSlides(entries) {
    const uploaded = [];
    for (const { file, name } of entries) {
        const row = addSlideUploadingRow(name, file.size);
        try {
            const result = await api.uploadFile(file, { onProgress: row.set });
            uploaded.push({ name, url: result.url, driveId: result.driveId, size: result.size || file.size, uploadedAt: result.uploadedAt || new Date().toISOString() });
        } catch (e) {
            if (!e.handled) toast('アップロード失敗: ' + name + '（' + humanizeApiError(e) + '）', 'error');
        } finally {
            row.remove();
        }
    }
    if (uploaded.length === 0) return;

    try {
        // 件数の上限は、保存の直前の最新の記録に対して判定する（写真と同じ）
        let accepted = [];
        await persistCurrentExp(draft => {
            const room = SLIDE_LIMIT - getSlides(draft).length;
            accepted = uploaded.slice(0, Math.max(0, room));
            if (accepted.length === 0) return false;
            draft.Slides = JSON.stringify(getSlides(draft).concat(accepted));
        });
        const rejected = uploaded.filter(p => accepted.indexOf(p) < 0);
        if (rejected.length) deleteStoredFiles(rejected.map(p => p.driveId));
        if (accepted.length === 0) { toast(`資料は最大${SLIDE_LIMIT}件までです`, 'error'); return; }
        renderSlides();
        toast(rejected.length ? `資料は最大${SLIDE_LIMIT}件までのため、${accepted.length}件だけ保存しました` : '資料を保存しました', rejected.length ? 'info' : 'success');
    } catch (e) {
        toast('保存失敗: ' + humanizeApiError(e), 'error');
        // 競合で保存されなかったときだけ、記録に載らなかったアップロード済みファイルを消す（写真と同じ理由）
        if (isConflictError(e)) deleteStoredFiles(uploaded.map(p => p.driveId));
    }
}

// 名前の変更(「⋯」のメニューから開く)。拡張子は変えられない
function openSlideEdit(key) {
    const slide = getSlides(currentExp).find(s => slideKey(s) === key);
    if (!slide) { toast('資料が見つかりません（すでに削除されています）', 'error'); renderSlides(); return; }
    const dlg = openSlideDialog('資料の名前を変更', `
        <div class="e1-group">
            <label class="e1-label">ファイル名</label>
            ${slideNameFieldHtml(`data-role="name" maxlength="${SLIDE_NAME_MAX - slideExtRaw(slide.name).length}"`)}
            <p class="settings-hint">拡張子は変えられません。${escapeHtml(slideDateText(slide) ? 'アップロード日 ' + slideDateText(slide) : '')}</p>
        </div>
        <div class="action-buttons slide-edit-actions">
            <button type="button" class="btn btn-text" data-role="cancel">キャンセル</button>
            <button type="button" class="btn btn-primary-solid" style="width:auto;" data-role="ok">保存</button>
        </div>`);
    const input = dlg.overlay.querySelector('[data-role="name"]');
    input.value = slideBaseName(slide.name);
    dlg.overlay.querySelector('.slide-name-ext').textContent = slideExtRaw(slide.name);
    dlg.overlay.querySelector('[data-role="cancel"]').onclick = dlg.close;
    const okBtn = dlg.overlay.querySelector('[data-role="ok"]');
    const submit = async () => {
        const name = normalizeSlideName(input.value, slide.name);
        if (name === slide.name) { dlg.close(); return; }
        okBtn.disabled = true;
        okBtn.textContent = '保存中...';
        try {
            const saved = await persistCurrentExp(draft => {
                const slides = getSlides(draft);
                const target = slides.find(s => slideKey(s) === key);
                if (!target) return false;
                target.name = name;
                draft.Slides = JSON.stringify(slides);
            });
            if (!saved) { toast('資料が見つかりません（すでに削除されています）', 'error'); dlg.close(); renderSlides(); return; }
            dlg.close();
            renderSlides();
            toast('名前を変更しました', 'success');
        } catch (e) {
            toast('保存失敗: ' + humanizeApiError(e), 'error');
            okBtn.disabled = false;
            okBtn.textContent = '保存';
        }
    };
    okBtn.onclick = submit;
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submit(); } });
    setTimeout(() => {
        input.focus();
        input.select();
    }, 50);
}

function deleteSlide(key) {
    const slide = getSlides(currentExp).find(s => slideKey(s) === key);
    if (!slide) return;
    const name = slide.name || '';
    showConfirmDialog({
        title: '資料を削除',
        message: (name ? `「${name}」を削除します。` : 'この資料を削除します。') + TRASH_KEEP_NOTE,
        okLabel: '削除する',
        danger: true,
        onOk: () => executeDeleteSlide(key)
    });
}

async function executeDeleteSlide(key) {
    try {
        const saved = await persistCurrentExp(draft => {
            const slides = getSlides(draft);
            const idx = slides.findIndex(s => slideKey(s) === key);
            if (idx < 0) return false;
            slides.splice(idx, 1);
            draft.Slides = JSON.stringify(slides);
        });
        if (!saved) { toast('資料が見つかりません（すでに削除されています）', 'error'); renderSlides(); return; }
        renderSlides();
        toast('資料をゴミ箱に移動しました', 'success');   // 実体（R2）はゴミ箱の期限まで残る
    } catch (e) {
        toast('削除失敗: ' + humanizeApiError(e), 'error');
    }
}

// ---- Video Gallery（YouTubeリンクを登録し、実験ショーの様子を見返す） ----

// 何十件登録されても一度に全部のサムネイル・iframeを読み込まないよう、表示件数をページングする
const VIDEO_PAGE_SIZE = 12;
let videoVisibleCount = VIDEO_PAGE_SIZE;

// 描画した data-action の受け口(onclick 属性に id・index を埋め込まない。app.js の registerActions 参照)
registerActions({
    'expd-del-feedback': el => deleteFeedbackEntry(el.dataset.id, el.dataset.type),
    'expd-del-photo': (el, e) => { e.preventDefault(); deletePhoto(Number(el.dataset.index)); },
    'expd-del-video': el => deleteVideo(Number(el.dataset.index)),
    'expd-slide-menu': el => openSlideMenu(el),
    'expd-sort-slides': el => sortSlidesBy(el.dataset.key),
    'expd-play-video': el => playVideo(el, el.dataset.id)
});

// youtube.com/watch?v=, youtu.be/, /embed/, /shorts/ のいずれの形式からも動画IDを取り出す。取れなければ空文字。
function extractYoutubeId(url) {
    if (!url) return '';
    const s = String(url).trim();
    let m = s.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    m = s.match(/youtu\.be\/([\w-]{11})/);
    if (m) return m[1];
    m = s.match(/\/(?:embed|shorts)\/([\w-]{11})/);
    if (m) return m[1];
    return '';
}

function getVideos(exp) {
    return parseJsonArray((exp || currentExp).Videos);
}

function renderVideos() {
    const gallery = document.getElementById('expd-video-gallery');
    if (!gallery || !currentExp) return;

    const videos = getVideos();

    const adminBtn = document.getElementById('video-add-btn');
    if (adminBtn) adminBtn.classList.remove('hidden');

    const loadMore = document.getElementById('video-load-more');

    if (videos.length === 0) {
        gallery.innerHTML = '<p class="empty-state" style="padding:30px 20px;">動画はまだありません</p>';
        if (loadMore) loadMore.classList.add('hidden');
        return;
    }

    // ページング量を超えて残っていれば維持し、削除等で件数が減った分は丸める
    videoVisibleCount = Math.min(videoVisibleCount || VIDEO_PAGE_SIZE, videos.length);
    const visible = videos.slice(0, videoVisibleCount);

    gallery.innerHTML = visible.map((v, i) => {
        // id は保存データ由来なので、YouTube の ID 形式(11 文字)に合うものだけ描画する(サムネ・iframe の URL は検証済み id のみで組み立てる)
        if (!v || !YT_ID_RE.test(String(v.id))) return '';
        const thumb = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
        const fallback = `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
        return `
        <div class="video-item">
            <button type="button" class="video-thumb-btn" data-action="expd-play-video" data-id="${escapeAttr(v.id)}" aria-label="${escapeAttr(v.title || '動画を再生')}">
                <img src="${thumb}" alt="" loading="lazy" data-fallback="${fallback}">
                <span class="video-play-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
                </span>
            </button>
            ${v.title ? `<p class="video-title" title="${escapeAttr(v.title)}">${escapeHtml(v.title)}</p>` : ''}
            <button class="video-delete" data-action="expd-del-video" data-index="${i}" title="削除">✕</button>
        </div>`;
    }).join('');

    if (loadMore) loadMore.classList.toggle('hidden', videoVisibleCount >= videos.length);
}

function showMoreVideos() {
    videoVisibleCount += VIDEO_PAGE_SIZE;
    renderVideos();
}

// サムネイルをクリックした時だけ、ポップアップで埋め込み再生する（多数登録時に全件同時ロードしないため）
const YT_ID_RE = /^[\w-]{11}$/;
function playVideo(btn, id) {
    if (!YT_ID_RE.test(String(id))) return;
    const item = btn.closest('.video-item');
    const title = item?.querySelector('.video-title')?.textContent || '動画';
    const overlay = document.createElement('div');
    overlay.className = 'video-popup-overlay';
    overlay.innerHTML = `
        <div class="video-popup" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
            <button type="button" class="video-popup-close" aria-label="閉じる">&times;</button>
            <div class="video-embed">
                <iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" title="${escapeAttr(title)}" frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
            </div>
            ${item?.querySelector('.video-title') ? `<p class="video-popup-title">${escapeHtml(title)}</p>` : ''}
        </div>`;
    document.body.appendChild(overlay);
    let cleanup = () => {};
    const close = () => {
        cleanup();
        overlay.remove(); // iframe ごと消えるので、再生も止まる
        try { btn.focus(); } catch (_) { /* 元のボタンが消えていても無視 */ }
    };
    overlay.querySelector('.video-popup-close').addEventListener('click', close);
    bindOverlayClose(overlay, close);
    cleanup = bindModalEscape(overlay, close);
    trapFocus(overlay.querySelector('.video-popup'));
}

function openAddVideoModal() {
    document.getElementById('video-url').value = '';
    document.getElementById('video-title').value = '';
    const modal = document.getElementById('video-modal');
    modal.classList.remove('hidden');
    bindModalEscape(modal, closeVideoModal);
    if (!modal._trapBound) { trapFocus(modal.querySelector('.modal-content')); modal._trapBound = true; }
    setTimeout(() => document.getElementById('video-url')?.focus(), 50);
}

function closeVideoModal() {
    document.getElementById('video-modal').classList.add('hidden');
}

async function saveVideo() {
    const url = document.getElementById('video-url').value.trim();
    const title = document.getElementById('video-title').value.trim();
    const id = extractYoutubeId(url);
    if (!id) {
        toast('YouTubeのURLを正しく入力してください', 'error');
        document.getElementById('video-url').focus();
        return;
    }

    if (getVideos().some(v => v.id === id)) {
        toast('この動画はすでに登録されています', 'error');
        return;
    }

    const saveBtn = document.getElementById('video-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

    try {
        // 新しい動画ほど上に来るよう先頭へ追加する（失敗しても currentExp は変わらないので、そのまま再試行できる）
        const saved = await persistCurrentExp(draft => {
            const videos = getVideos(draft);
            if (videos.some(v => v.id === id)) return false;
            videos.unshift({ id, url: safeHttpUrl(url) || `https://www.youtube.com/watch?v=${id}`, title });
            draft.Videos = JSON.stringify(videos);
        });
        if (!saved) { toast('この動画はすでに登録されています', 'error'); return; }
        videoVisibleCount = VIDEO_PAGE_SIZE;
        renderVideos();
        toast('動画を追加しました', 'success');
        closeVideoModal();
    } catch (e) {
        toast('保存失敗: ' + humanizeApiError(e), 'error');
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
    }
}

function deleteVideo(index) {
    const videos = getVideos();
    if (index < 0 || index >= videos.length) return;

    const title = videos[index].title || '';
    showConfirmDialog({
        title: '動画を削除',
        message: (title ? `「${title}」を削除します。` : 'この動画を削除します。') + TRASH_KEEP_NOTE,
        okLabel: '削除する',
        danger: true,
        onOk: () => executeDeleteVideo(videos[index].id)
    });
}

async function executeDeleteVideo(videoId) {
    try {
        const saved = await persistCurrentExp(draft => {
            const videos = getVideos(draft);
            const idx = videos.findIndex(v => v.id === videoId);
            if (idx < 0) return false;
            videos.splice(idx, 1);
            draft.Videos = JSON.stringify(videos);
        });
        if (!saved) { toast('動画が見つかりません（すでに削除されています）', 'error'); renderVideos(); return; }
        renderVideos();
        toast('動画をゴミ箱に移動しました', 'success');
    } catch (e) {
        toast('削除失敗: ' + humanizeApiError(e), 'error');
    }
}

// ---- カスタムセクション（実験情報タブのインライン編集） ----

// alwaysShow: 未入力でも見出しだけは常に表示し、✎から追記できるようにする
const FIXED_SECTIONS = [
    { key: 'Materials',    title: '使用物品',   alwaysShow: true },
    { key: 'Preparation',  title: '事前準備',   alwaysShow: true },
    { key: 'Flow',         title: '発表の流れ' },
    { key: 'Notes',        title: '注意事項',   alwaysShow: true }
];

function getCustomSections(exp) {
    return parseJsonArray((exp || currentExp).Sections);
}

function getAllSections() {
    const sections = [];
    FIXED_SECTIONS.forEach(f => {
        const content = currentExp[f.key] || '';
        if (content.trim() || f.alwaysShow) sections.push({ type: 'fixed', key: f.key, title: f.title, content });
    });
    getCustomSections().forEach((s, i) => {
        sections.push({ type: 'custom', index: i, title: s.title || '', content: s.content || '' });
    });
    return sections;
}

function renderInfoSections() {
    const body = document.getElementById('expd-info-body');
    const sections = getAllSections();

    body.innerHTML = sections.map(s => {
        const items = s.content.split('\n').map(l => l.trim()).filter(Boolean);
        const id = s.type === 'fixed' ? `section-fixed-${s.key}` : `section-custom-${s.index}`;
        const editAttr = s.type === 'fixed'
            ? `data-edit-fixed="${s.key}"`
            : `data-edit-custom="${s.index}"`;
        const bodyHtml = items.length > 0
            ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
            : `<p class="text-muted" style="font-size:0.85rem; margin:4px 0 0;">未入力です。✎から追加できます</p>`;
        return `<div class="expd-info-section" id="${id}">
            <div class="expd-info-section-header">
                <h3>${escapeHtml(s.title)}</h3>
                <button class="expd-section-edit-btn" ${editAttr} title="編集">&#9998;</button>
            </div>
            ${bodyHtml}
        </div>`;
    }).join('') +
    `<button class="btn btn-secondary expd-add-section-btn" onclick="addCustomSection()">+ セクション追加</button>`;

    body.querySelectorAll('[data-edit-fixed]').forEach(btn => {
        btn.addEventListener('click', () => enterEditMode(btn.closest('.expd-info-section'), 'fixed', btn.dataset.editFixed));
    });
    body.querySelectorAll('[data-edit-custom]').forEach(btn => {
        btn.addEventListener('click', () => enterEditMode(btn.closest('.expd-info-section'), 'custom', parseInt(btn.dataset.editCustom)));
    });
}

// 他のセクションを編集中のとき、保存・削除でセクション一覧を描き直しても、その入力が消えないようにする。
// 描き直す前に、編集中の欄(exceptId 以外)の入力を控え、描き直した後に編集欄を開き直して入力を戻す。
function captureOpenEdits(exceptId) {
    return Array.from(document.querySelectorAll('#expd-info-body .expd-info-section.editing'))
        .filter(el => el.id !== exceptId)
        .map(el => {
            const m = el.id.match(/^section-(fixed|custom)-(.+)$/);
            if (!m) return null;
            const titleEl = el.querySelector('.expd-edit-title');
            return {
                type: m[1],
                key: m[1] === 'custom' ? parseInt(m[2], 10) : m[2],
                title: titleEl ? titleEl.value : null,
                content: (el.querySelector('.expd-edit-content') || {}).value || ''
            };
        })
        .filter(Boolean);
}

// deletedIndex: 追加のセクションを削除したとき、それより後ろのセクションの番号が 1 つ前にずれる
function restoreOpenEdits(list, deletedIndex) {
    const body = document.getElementById('expd-info-body');
    list.forEach(c => {
        let key = c.key;
        if (c.type === 'custom' && deletedIndex !== undefined && key > deletedIndex) key -= 1;
        const id = c.type === 'fixed' ? `section-fixed-${key}` : `section-custom-${key}`;
        let el = document.getElementById(id);
        if (!el && c.type === 'custom') {      // まだ保存していない新規セクション
            el = document.createElement('div');
            el.className = 'expd-info-section';
            el.id = id;
            body.insertBefore(el, body.querySelector('.expd-add-section-btn'));
        }
        if (!el) return;
        enterEditMode(el, c.type, key, true);
        const titleEl = el.querySelector('.expd-edit-title');
        if (titleEl && c.title !== null) titleEl.value = c.title;
        el.querySelector('.expd-edit-content').value = c.content;
    });
}

function enterEditMode(sectionEl, type, keyOrIndex, noFocus) {
    const isFixed = type === 'fixed';
    let title, content;
    if (isFixed) {
        const f = FIXED_SECTIONS.find(s => s.key === keyOrIndex);
        title = f ? f.title : '';
        content = currentExp[keyOrIndex] || '';
    } else {
        const customs = getCustomSections();
        const s = customs[keyOrIndex];
        title = s ? s.title : '';
        content = s ? s.content : '';
    }

    sectionEl.classList.add('editing');
    sectionEl.innerHTML = `
        <div class="expd-edit-section">
            ${isFixed
                ? `<h3>${escapeHtml(title)}</h3>`
                : `<input class="expd-edit-title" type="text" value="${escapeAttr(title)}" placeholder="見出し">`
            }
            <textarea class="expd-edit-content" rows="6" placeholder="内容（1行に1項目）">${escapeHtml(content)}</textarea>
            <div class="expd-edit-actions">
                ${!isFixed ? '<button class="btn btn-danger btn-sm" data-delete>削除</button>' : ''}
                <div class="expd-edit-actions-spacer"></div>
                <button class="btn btn-text btn-sm" data-cancel>キャンセル</button>
                <button class="btn btn-primary-solid btn-sm" data-save>保存</button>
            </div>
        </div>`;

    sectionEl.querySelector('[data-cancel]').addEventListener('click', () => renderInfoSections());
    sectionEl.querySelector('[data-save]').addEventListener('click', () => saveSection(sectionEl, type, keyOrIndex));
    const delBtn = sectionEl.querySelector('[data-delete]');
    if (delBtn) delBtn.addEventListener('click', () => deleteSection(keyOrIndex));

    if (noFocus) return;
    const textarea = sectionEl.querySelector('.expd-edit-content');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// 保存・削除の通信中に、同じ操作が重ならないようにする
let _sectionBusy = false;

async function saveSection(sectionEl, type, keyOrIndex) {
    if (_sectionBusy) return;
    const isFixed = type === 'fixed';
    const contentEl = sectionEl.querySelector('.expd-edit-content');
    const content = contentEl.value;

    let title = '';
    if (!isFixed) {
        const titleEl = sectionEl.querySelector('.expd-edit-title');
        title = titleEl ? titleEl.value.trim() : '';
        if (!title) { toast('見出しを入力してください', 'error'); if (titleEl) titleEl.focus(); return; }
    }

    _sectionBusy = true;
    const actionBtns = sectionEl.querySelectorAll('.expd-edit-actions button');
    actionBtns.forEach(b => { b.disabled = true; });
    try {
        await persistCurrentExp(draft => {
            if (isFixed) {
                draft[keyOrIndex] = content;
            } else {
                // 追加中の新規セクションは、保存で初めて Sections に加わる（index が末尾なら追加になる）
                const customs = getCustomSections(draft);
                // 件数より後ろの番号なら末尾に追加する(別の操作で件数が減っていても、空の要素を作らない)
                if (keyOrIndex >= customs.length) customs.push({ title, content }); else customs[keyOrIndex] = { title, content };
                draft.Sections = JSON.stringify(customs);
            }
        });
        const others = captureOpenEdits(sectionEl.id);
        renderInfoSections();
        restoreOpenEdits(others);
        toast('保存しました', 'success');
    } catch (e) {
        actionBtns.forEach(b => { b.disabled = false; });
        toast('保存失敗: ' + humanizeApiError(e), 'error', 5000);
    } finally {
        _sectionBusy = false;
    }
}

async function deleteSection(index) {
    if (_sectionBusy) return;
    const deletedId = `section-custom-${index}`;
    if (index < 0 || index >= getCustomSections().length) {
        // 追加途中の（まだ保存していない）セクション。サーバーには無いので画面から外すだけ
        const others = captureOpenEdits(deletedId);
        renderInfoSections();
        restoreOpenEdits(others);
        return;
    }

    _sectionBusy = true;
    const actionBtns = document.querySelectorAll('#expd-info-body .expd-edit-actions button');
    actionBtns.forEach(b => { b.disabled = true; });
    try {
        await persistCurrentExp(draft => {
            const customs = getCustomSections(draft);
            if (index >= customs.length) return false;
            customs.splice(index, 1);
            draft.Sections = JSON.stringify(customs);
        });
        const others = captureOpenEdits(deletedId);
        renderInfoSections();
        restoreOpenEdits(others, index);
        toast('セクションをゴミ箱に移動しました', 'success');
    } catch (e) {
        actionBtns.forEach(b => { b.disabled = false; });
        toast('削除失敗: ' + humanizeApiError(e), 'error');
    } finally {
        _sectionBusy = false;
    }
}

// 「+ セクション追加」。currentExp は変更せず、編集欄だけを画面に出す（保存して初めて追加される。
// キャンセルしても空のセクションが残らず、他の保存に紛れてサーバーへ書き込まれることもない）。
function addCustomSection() {
    const body = document.getElementById('expd-info-body');
    const newIndex = getCustomSections().length;
    const existing = document.getElementById(`section-custom-${newIndex}`);
    if (existing) {
        const t = existing.querySelector('.expd-edit-title');
        if (t) t.focus();
        return;
    }
    const el = document.createElement('div');
    el.className = 'expd-info-section';
    el.id = `section-custom-${newIndex}`;
    body.insertBefore(el, body.querySelector('.expd-add-section-btn'));
    enterEditMode(el, 'custom', newIndex);
    const titleInput = el.querySelector('.expd-edit-title');
    if (titleInput) titleInput.focus();
}
