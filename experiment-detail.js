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
let _expPersistChain = Promise.resolve();
function persistCurrentExp(mutator) {
    const run = async () => {
        const draft = { ...currentExp };
        if (mutator(draft) === false) return null;
        const saved = await api.save('experiments', { ...draft, _baseUpdatedAt: currentExp.UpdatedAt || '' });
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
    } catch (_) {}
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
    renderPhotos();
    renderVideos();
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
        return `<a href="event-series.html?event=${encodeURIComponent(ev.ID)}" class="expd-event-chip" title="${escapeAttr(ev.Title)}">
            <span class="expd-event-date">${escapeHtml(ev.Date || '')}</span>
            <span class="expd-event-title">${escapeHtml(ev.Title || '(無題)')}</span>
            <span class="cat-dot" style="color:${cat.bg};" title="${cat.short}">&#9679;</span>
        </a>`;
    }).join('');
}

function getAllFeedback() {
    if (!currentExp) return [];
    const pos = parseFeedbackEntries(currentExp.Positives).map(e => ({ ...e, type: 'positive' }));
    const ref = parseFeedbackEntries(currentExp.Reflections).map(e => ({ ...e, type: 'reflection' }));
    return [...pos, ...ref].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

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

    container.innerHTML = fyKeys.map(fy => {
        const entries = grouped[fy];
        const isCurrentFy = fy === `${currentFy}年度`;
        const open = isCurrentFy || fy === '日付なし';
        return `
            <div class="fy-group">
                <button type="button" class="fy-header ${open ? 'open' : ''}" aria-expanded="${open}" onclick="this.classList.toggle('open'); this.setAttribute('aria-expanded', this.classList.contains('open')); this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.fy-toggle').innerHTML = this.classList.contains('open') ? '&#9660;' : '&#9654;';">
                    <span class="fy-toggle">${open ? '&#9660;' : '&#9654;'}</span>
                    <span class="fy-label">${escapeHtml(fy)}</span>
                    <span class="fy-count">${entries.length}件</span>
                </button>
                <div class="fy-body ${open ? '' : 'hidden'}">
                    ${entries.map(f => renderFeedbackEntry(f)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function renderFeedbackEntry(f) {
    const isPos = f.type === 'positive';
    const icon = isPos ? '&#9675;' : '&#9651;';
    const cls = isPos ? 'fb-positive' : 'fb-reflection';
    const label = isPos ? '良かった点' : '改善点';
    const dateStr = f.date ? `${f.date} (${dayOfWeekJP(f.date)})` : '';
    const eventLink = f.eventTitle
        ? `<span class="fb-event-tag">${escapeHtml(f.eventTitle)}</span>`
        : '<span class="fb-event-tag fb-general">実験全般</span>';

    return `
        <div class="fb-entry ${cls}">
            <div class="fb-entry-header">
                <span class="fb-icon">${icon}</span>
                <span class="fb-label">${label}</span>
                ${eventLink}
                <span class="fb-date">${escapeHtml(dateStr)}</span>
                <button class="fb-del-btn" data-action="expd-del-feedback" data-id="${escapeAttr(f.id || '')}" data-type="${escapeAttr(f.type || '')}" title="削除">&#10005;</button>
            </div>
            <div class="fb-entry-text">${escapeHtml(f.text || '')}</div>
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
    setTimeout(() => document.getElementById('fb-text').focus(), 50);
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
        toast('振り返りを保存しました', 'success');
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人が編集しました。ページを再読み込みしてください。', 'error', 5000);
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
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
        toast('ゴミ箱に移動しました', 'success');
    } catch (e) {
        toast('削除失敗: ' + e.message, 'error');
    }
}

// ---- Tab switching ----

function switchExpTab(btn) {
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
            toast('アップロード失敗: ' + e.message, 'error');
        }
    }
    if (uploaded.length === 0) return;

    try {
        await persistCurrentExp(draft => {
            draft.Photos = JSON.stringify(getPhotos(draft).concat(uploaded));
        });
        renderPhotos();
        toast('写真を保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
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
        toast('削除失敗: ' + e.message, 'error');
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

// サムネイルをクリックした時だけ埋め込み再生に切り替える（多数登録時に全件同時ロードしないため）
const YT_ID_RE = /^[\w-]{11}$/;
function playVideo(btn, id) {
    if (!YT_ID_RE.test(String(id))) return;
    const wrap = btn.closest('.video-item');
    if (!wrap) return;
    const embed = document.createElement('div');
    embed.className = 'video-embed';
    embed.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" title="YouTube video player" frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    btn.replaceWith(embed);
}

function openAddVideoModal() {
    document.getElementById('video-url').value = '';
    document.getElementById('video-title').value = '';
    const modal = document.getElementById('video-modal');
    modal.classList.remove('hidden');
    bindModalEscape(modal, closeVideoModal);
    if (!modal._trapBound) { trapFocus(modal.querySelector('.modal-content')); modal._trapBound = true; }
    setTimeout(() => document.getElementById('video-url').focus(), 50);
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
        toast('保存失敗: ' + e.message, 'error');
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
        toast('削除失敗: ' + e.message, 'error');
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

function enterEditMode(sectionEl, type, keyOrIndex) {
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

    const textarea = sectionEl.querySelector('.expd-edit-content');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function saveSection(sectionEl, type, keyOrIndex) {
    const isFixed = type === 'fixed';
    const contentEl = sectionEl.querySelector('.expd-edit-content');
    const content = contentEl.value;

    let title = '';
    if (!isFixed) {
        const titleEl = sectionEl.querySelector('.expd-edit-title');
        title = titleEl ? titleEl.value.trim() : '';
        if (!title) { toast('見出しを入力してください', 'error'); if (titleEl) titleEl.focus(); return; }
    }

    try {
        await persistCurrentExp(draft => {
            if (isFixed) {
                draft[keyOrIndex] = content;
            } else {
                // 追加中の新規セクションは、保存で初めて Sections に加わる（index が末尾なら追加になる）
                const customs = getCustomSections(draft);
                customs[keyOrIndex] = { title, content };
                draft.Sections = JSON.stringify(customs);
            }
        });
        renderInfoSections();
        toast('保存しました', 'success');
    } catch (e) {
        if (String(e.message).includes('conflict')) {
            toast('他の人が編集しました。ページを再読み込みしてください。', 'error', 5000);
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    }
}

async function deleteSection(index) {
    if (index < 0 || index >= getCustomSections().length) {
        // 追加途中の（まだ保存していない）セクション。サーバーには無いので画面から外すだけ
        renderInfoSections();
        return;
    }

    try {
        await persistCurrentExp(draft => {
            const customs = getCustomSections(draft);
            if (index >= customs.length) return false;
            customs.splice(index, 1);
            draft.Sections = JSON.stringify(customs);
        });
        renderInfoSections();
        toast('セクションをゴミ箱に移動しました', 'success');
    } catch (e) {
        toast('削除失敗: ' + e.message, 'error');
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
