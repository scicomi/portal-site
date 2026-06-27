/**
 * 実験詳細ページ
 * 実験の全情報 + 振り返りタイムライン（年度別折りたたみ）を表示。
 * 振り返りはイベント経由 or 直接追加でき、実験レコードに蓄積される。
 */

let currentExp = null;
let allExperiments = [];
let allEvents = [];
let feedbackFilter = 'all';
let editingFbId = null;

document.addEventListener('DOMContentLoaded', () => {
    bootPage('experiments', init);
});

async function init() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
        document.getElementById('exp-loading').textContent = '実験IDが指定されていません';
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
        updateSyncStatus('cached', cached.timestamp);
    }

    try {
        allExperiments = await api.list('experiments');
        api.saveCache('experiments', allExperiments);
        currentExp = allExperiments.find(e => e.ID === id);
        if (!currentExp) {
            document.getElementById('exp-loading').textContent = '実験が見つかりません';
            return;
        }
        renderPage();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (!currentExp) {
            document.getElementById('exp-loading').textContent = '読み込みエラー: ' + e.message;
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
    document.title = (e.Name || '実験詳細') + ' | SciComi Portal';
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

    const section = (title, content) => {
        if (!content || !content.trim()) return '';
        const items = content.split('\n').map(s => s.trim()).filter(Boolean);
        return `<div class="expd-info-section">
            <h3>${title}</h3>
            <ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        </div>`;
    };

    document.getElementById('expd-info-body').innerHTML =
        section('使用物品', e.Materials) +
        section('事前準備', e.Preparation) +
        section('発表の流れ', e.Flow) +
        section('注意事項', e.Notes) ||
        '<p style="color:#888; padding:12px;">詳細情報はまだ登録されていません。</p>';

    renderEventsSection();
    renderFeedback();
    renderPhotos();
    populateEventDropdown();
}

function renderEventsSection() {
    if (!currentExp || !allEvents.length) return;
    const expName = currentExp.Name;
    const related = allEvents.filter(ev => {
        let parts = [];
        try {
            const raw = ev.PartsList || ev.partsList;
            parts = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        } catch (_) {}
        return parts.some(p => {
            if (p.items) return p.items.some(it => it.name === expName);
            return p.name === expName;
        });
    }).sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));

    const sec = document.getElementById('expd-events-section');
    if (related.length === 0) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');

    document.getElementById('expd-events-list').innerHTML = related.map(ev => {
        const cat = getEventCategory(ev.Category || 'normal');
        return `<a href="events.html" class="expd-event-chip" title="${escapeAttr(ev.Title)}">
            <span class="expd-event-date">${escapeHtml(ev.Date || '')}</span>
            <span class="expd-event-title">${escapeHtml(ev.Title || '(無題)')}</span>
            <span class="cat-badge" style="background:${cat.bg};color:${cat.text};font-size:0.65rem;">${cat.short}</span>
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
    document.querySelectorAll('[data-fb]').forEach(c =>
        c.classList.toggle('active', c.dataset.fb === type)
    );
    renderFeedback();
}

function renderFeedback() {
    const container = document.getElementById('feedback-timeline');
    let items = getAllFeedback();

    if (feedbackFilter !== 'all') {
        items = items.filter(f => f.type === feedbackFilter);
    }

    const kw = (document.getElementById('feedback-search')?.value || '').toLowerCase();
    if (kw) {
        items = items.filter(f =>
            (f.text || '').toLowerCase().includes(kw) ||
            (f.eventTitle || '').toLowerCase().includes(kw)
        );
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
                <div class="fy-header ${open ? 'open' : ''}" onclick="this.classList.toggle('open'); this.nextElementSibling.classList.toggle('hidden');">
                    <span class="fy-toggle">${open ? '&#9660;' : '&#9654;'}</span>
                    <span class="fy-label">${escapeHtml(fy)}</span>
                    <span class="fy-count">${entries.length}件</span>
                </div>
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
                <button class="fb-del-btn" onclick="deleteFeedbackEntry('${escapeAttr(f.id || '')}', '${f.type}')" title="削除">&#10005;</button>
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
    editingFbId = null;
    document.getElementById('fb-modal-title').textContent = '振り返りを追加';
    document.getElementById('fb-type').value = 'positive';
    document.getElementById('fb-event').value = '';
    document.getElementById('fb-text').value = '';
    document.getElementById('feedback-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('fb-text').focus(), 50);
}

function closeFeedbackModal() {
    document.getElementById('feedback-modal').classList.add('hidden');
    editingFbId = null;
}

async function saveFeedback() {
    const text = document.getElementById('fb-text').value.trim();
    if (!text) { toast('内容を入力してください', 'error'); return; }

    const type = document.getElementById('fb-type').value;
    const eventSel = document.getElementById('fb-event');
    const selectedOpt = eventSel.selectedOptions[0];
    const eventId = eventSel.value;
    const eventTitle = selectedOpt ? (selectedOpt.dataset.title || '') : '';
    const eventDate = selectedOpt ? (selectedOpt.dataset.date || '') : '';

    const field = type === 'positive' ? 'Positives' : 'Reflections';
    const entries = parseFeedbackEntries(currentExp[field]);

    const newEntry = {
        id: genFeedbackId(),
        date: eventDate || todayISO(),
        eventId: eventId,
        eventTitle: eventTitle,
        text: text
    };

    entries.push(newEntry);
    currentExp[field] = stringifyFeedbackEntries(entries);

    const item = { ...currentExp };
    item._baseUpdatedAt = currentExp.UpdatedAt || '';

    try {
        const saved = await api.save('experiments', item);
        Object.assign(currentExp, saved);
        const idx = allExperiments.findIndex(e => e.ID === currentExp.ID);
        if (idx >= 0) allExperiments[idx] = currentExp;
        api.saveCache('experiments', allExperiments);
        closeFeedbackModal();
        renderFeedback();
        toast('振り返りを保存しました', 'success');
    } catch (e) {
        entries.pop();
        currentExp[field] = stringifyFeedbackEntries(entries);
        if (String(e.message).includes('conflict')) {
            toast('他の人が編集しました。ページを再読み込みしてください。', 'error', 5000);
        } else {
            toast('保存失敗: ' + e.message, 'error');
        }
    }
}

async function deleteFeedbackEntry(fbId, type) {
    if (!fbId || !currentExp) return;
    if (!confirm('この振り返りエントリを削除しますか？')) return;

    const field = type === 'positive' ? 'Positives' : 'Reflections';
    const entries = parseFeedbackEntries(currentExp[field]);
    const idx = entries.findIndex(e => e.id === fbId);
    if (idx < 0) { toast('エントリが見つかりません', 'error'); return; }

    const removed = entries.splice(idx, 1)[0];
    currentExp[field] = stringifyFeedbackEntries(entries);

    const item = { ...currentExp };
    item._baseUpdatedAt = currentExp.UpdatedAt || '';

    try {
        const saved = await api.save('experiments', item);
        Object.assign(currentExp, saved);
        const eIdx = allExperiments.findIndex(e => e.ID === currentExp.ID);
        if (eIdx >= 0) allExperiments[eIdx] = currentExp;
        api.saveCache('experiments', allExperiments);
        renderFeedback();
        toast('削除しました', 'success');
    } catch (e) {
        entries.splice(idx, 0, removed);
        currentExp[field] = stringifyFeedbackEntries(entries);
        toast('削除失敗: ' + e.message, 'error');
    }
}

function goEdit() {
    if (currentExp) {
        location.href = 'experiments.html?edit=' + currentExp.ID;
    }
}

// ---- Tab switching ----

function switchExpTab(btn) {
    document.querySelectorAll('.expd-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.expd-tab-pane').forEach(p => {
        p.classList.toggle('hidden', p.dataset.tabPane !== target);
    });
}

// ---- Photo Gallery ----

function renderPhotos() {
    const gallery = document.getElementById('expd-photo-gallery');
    if (!gallery || !currentExp) return;

    let photos = [];
    try { photos = JSON.parse(currentExp.Photos || '[]'); } catch (_) {}
    if (!Array.isArray(photos)) photos = [];

    const adminBtn = document.querySelector('.admin-only-btn');
    if (adminBtn) {
        adminBtn.classList.toggle('hidden', !api.isAdmin() || photos.length >= 5);
    }

    if (photos.length === 0) {
        gallery.innerHTML = '<p class="empty-state" style="padding:30px 20px;">写真はまだありません</p>';
        return;
    }

    // Google Drive の getUrl() は「閲覧ページ」URLのため <img> では表示できない（ファイル名だけ出てしまう）。
    // ファイルIDから thumbnail エンドポイントの直リンクを作って表示する。失敗時は uc?export=view を試す。
    gallery.innerHTML = photos.map((p, i) => {
        const id = p.driveId || extractDriveId(p.url);
        const thumb = id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1600` : p.url;
        const fallback = id ? `https://drive.google.com/uc?export=view&id=${id}` : p.url;
        const openUrl = p.url || thumb;
        return `
        <div class="photo-item">
            <a href="${escapeAttr(openUrl)}" target="_blank" rel="noopener" title="${escapeAttr(p.name || '')}">
                <img src="${escapeAttr(thumb)}" alt="${escapeAttr(p.name || '')}" loading="lazy"
                     referrerpolicy="no-referrer"
                     onerror="this.onerror=null; this.src='${escapeAttr(fallback)}';">
            </a>
            ${api.isAdmin() ? `<button class="photo-delete" onclick="event.preventDefault(); deletePhoto(${i})" title="削除">✕</button>` : ''}
        </div>`;
    }).join('');
}

// Drive の各種URL形式（/d/<id>/view, ?id=<id>, uc?id=<id> 等）からファイルIDを取り出す。
function extractDriveId(url) {
    if (!url) return '';
    const m = String(url).match(/\/d\/([-\w]{20,})/) || String(url).match(/[?&]id=([-\w]{20,})/);
    return m ? m[1] : '';
}

function openPhotoUpload() {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => openPhotoUpload());
        return;
    }
    let photos = [];
    try { photos = JSON.parse(currentExp.Photos || '[]'); } catch (_) {}
    if (photos.length >= 5) { toast('写真は最大5枚までです', 'error'); return; }
    document.getElementById('photo-file-input').click();
}

async function handlePhotoSelect(input) {
    const files = Array.from(input.files);
    input.value = '';
    if (!files.length) return;

    let photos = [];
    try { photos = JSON.parse(currentExp.Photos || '[]'); } catch (_) {}
    const remaining = 5 - photos.length;
    const toUpload = files.slice(0, remaining);

    for (const file of toUpload) {
        if (file.size > 10 * 1024 * 1024) { toast(file.name + ' は10MBを超えています', 'error'); continue; }
        toast('アップロード中: ' + file.name, 'info', 2000);
        try {
            const result = await api.uploadFile(file, currentExp.ID);
            // driveId を保存しておくと、表示時に確実にサムネイル直リンクを生成できる。
            photos.push({ name: file.name, url: result.url, driveId: result.driveId, size: file.size });
        } catch (e) {
            toast('アップロード失敗: ' + e.message, 'error');
        }
    }

    currentExp.Photos = JSON.stringify(photos);
    try {
        const saved = await api.save('experiments', { ...currentExp, _baseUpdatedAt: currentExp.UpdatedAt || '' });
        Object.assign(currentExp, saved);
        const idx = allExperiments.findIndex(e => e.ID === currentExp.ID);
        if (idx >= 0) allExperiments[idx] = currentExp;
        api.saveCache('experiments', allExperiments);
        renderPhotos();
        toast('写真を保存しました', 'success');
    } catch (e) {
        toast('保存失敗: ' + e.message, 'error');
    }
}

async function deletePhoto(index) {
    if (!api.isAdmin()) { showAdminAuthModal(() => deletePhoto(index)); return; }
    let photos = [];
    try { photos = JSON.parse(currentExp.Photos || '[]'); } catch (_) {}
    if (index < 0 || index >= photos.length) return;

    photos.splice(index, 1);
    currentExp.Photos = JSON.stringify(photos);

    try {
        const saved = await api.save('experiments', { ...currentExp, _baseUpdatedAt: currentExp.UpdatedAt || '' });
        Object.assign(currentExp, saved);
        const idx = allExperiments.findIndex(e => e.ID === currentExp.ID);
        if (idx >= 0) allExperiments[idx] = currentExp;
        api.saveCache('experiments', allExperiments);
        renderPhotos();
        toast('写真を削除しました', 'success');
    } catch (e) {
        toast('削除失敗: ' + e.message, 'error');
    }
}
