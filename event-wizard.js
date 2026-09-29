/**
 * イベント編集ウィザード（共通モジュール）
 *
 * events.html と event-series.html の両方から読み込む（config.js / api.js / app.js の後、
 * 各ページスクリプトの前）。含まれるもの:
 *   - サーバー形 ⇔ UI形 のスキーマ変換（gasToUi / uiToGas / cacheItemsToUi）
 *   - 日付レンジピッカー・タグ入力・実験行などの入力部品
 *   - 既存イベントの編集ウィザード（openEventWizard 一式）
 *   - 書類期限の自動計算（calculateDeadlines / updateDeadlines）
 *
 * ページ固有のデータ配列・再描画は EVENT_WIZARD_HOST で差し替える。
 * 未定義ならイベント一覧ページ（script.js の eventsData / renderEvents）を既定とする。
 */

let holidaysData = {};

// 実験マスタ（populateDatalists で取得）。実験名のタイポで振り返りが
// 別レコードに紐づかないよう、ウィザードでは実在する名前しか保存できない。
let experimentsList = [];
let experimentsMasterWarned = false; // マスタ未取得の警告をウィザード 1 回につき 1 度だけ出す

// ---- ホスト連携 ----
// ウィザードが触るページ側データ（取得・楽観更新・確定・巻き戻し・削除）はホスト経由にする。
// event-series.html はサーバー形で持つため window.EVENT_WIZARD_HOST で差し替える。
// 未定義時はイベント一覧ページ（script.js の eventsData / renderEvents）を既定とする。
function _wzHost() {
    return window.EVENT_WIZARD_HOST || _eventsPageWizardHost;
}

const _eventsPageWizardHost = {
    getEvent(id) { return eventsData.find(x => x.ID === id) || null; },
    snapshot() { return JSON.parse(JSON.stringify(eventsData)); },
    applyOptimistic(itemUi) {
        const idx = eventsData.findIndex(x => x.ID === itemUi.ID);
        if (idx > -1) eventsData[idx] = itemUi; else eventsData.unshift(itemUi);
        api.saveCache('events', eventsData);
        renderEvents();
    },
    commitSaved(savedGas) {
        const savedEvent = gasToUi(savedGas);
        const idx = eventsData.findIndex(x => x.ID === savedEvent.ID);
        if (idx >= 0) {
            eventsData[idx] = savedEvent;
            api.saveCache('events', eventsData);
        }
    },
    rollback(snap) {
        eventsData.splice(0, eventsData.length, ...snap);
        api.saveCache('events', eventsData);
        renderEvents();
    },
    onConflict() { refreshData(); },
    confirmDelete(id) { confirmDeleteEvent(id); }
};

// ---- ウィザード定義 ----
let evWizardStep = 0;
let editingEventId = null;
let evWizardCategory = 'normal';

const EV_STEPS_EVENT = [
    { label: '基本情報' },
    { label: '日時' },
    { label: '実験・担当' },
    { label: 'その他' }
];
const EV_STEPS_MEETING = [
    { label: '基本情報' },
    { label: '日時' },
    { label: 'その他' }
];

// ---- スキーマ変換: サーバー形(DB の列名) ⇔ UI形(旧スキーマ) ----
// サーバー側: Date, DateEnd, TimeStart, TimeEnd, PartsList(配列), Files(配列), Logistics, AdminKyoka 等
// UI側:     Date, Date_End, Event_Time, PartsList(JSON文字列), Files(カンマ区切り), Meeting_Logistics, Admin_Kyoka 等
function gasToUi(g) {
    const u = { ...g };
    u.Date_End = g.DateEnd || '';
    u.Event_Time = (g.TimeStart && g.TimeEnd) ? `${g.TimeStart} - ${g.TimeEnd}` : '';
    u.Meeting_Logistics = g.Logistics || '';
    u.Admin_Kyoka = g.AdminKyoka || '';
    u.Admin_Houkoku = g.AdminHoukoku || '';
    u.Kyoka_Deadline = g.KyokaDeadline || '';
    u.Houkoku_Deadline = g.HoukokuDeadline || '';
    u.Vote_Deadline = g.VoteDeadline || '';
    u.Meeting_Number = g.MeetingNumber || '';
    u.Gather_Time = g.GatherTime || '';
    u.Dismiss_Time = g.DismissTime || '';
    u.Accompany = g.Accompany || '';
    u.PlanName = g.PlanName || '';
    u.Address = g.Address || '';
    u.LocationTel = g.LocationTel || '';
    u.EmergencyHospital = g.EmergencyHospital || '';
    u.EmergencyPolice = g.EmergencyPolice || '';
    u.KyokaNotRequired = g.KyokaNotRequired || '';
    u.HoukokuNotRequired = g.HoukokuNotRequired || '';
    u.PartsList = Array.isArray(g.PartsList) ? JSON.stringify(g.PartsList) : (g.PartsList || '');
    u.Files = Array.isArray(g.Files)
        ? g.Files.map(f => typeof f === 'string' ? { name: '', url: f } : f)
        : [];
    return u;
}

function uiToGas(u) {
    const time = (u.Event_Time || '').split(' - ');

    let partsList = [];
    if (u.PartsList) {
        if (typeof u.PartsList === 'string') {
            try { partsList = JSON.parse(u.PartsList); } catch (_) { partsList = []; }
        } else if (Array.isArray(u.PartsList)) {
            partsList = u.PartsList;
        }
    }

    return {
        ID: u.ID || '',
        Date: u.Date || '',
        DateEnd: u.Date_End || '',
        Title: u.Title || '',
        Category: u.Category || 'normal',
        Location: u.Location || '',
        Audience: u.Audience || '',
        TimeStart: (time[0] || '').trim(),
        TimeEnd: (time[1] || '').trim(),
        MeetingNumber: u.Meeting_Number || '',
        GatherTime: u.Gather_Time || '',
        DismissTime: u.Dismiss_Time || '',
        Accompany: u.Accompany || '',
        PlanName: u.PlanName || '',
        PartsList: partsList,
        AdminKyoka: u.Admin_Kyoka || '',
        AdminHoukoku: u.Admin_Houkoku || '',
        KyokaDeadline: u.Kyoka_Deadline || '',
        HoukokuDeadline: u.Houkoku_Deadline || '',
        KyokaNotRequired: u.KyokaNotRequired || '',
        HoukokuNotRequired: u.HoukokuNotRequired || '',
        VoteDeadline: u.Vote_Deadline || '',
        Logistics: u.Meeting_Logistics || '',
        Remarks: u.Remarks || '',
        Belongings: u.Belongings || '',
        Files: Array.isArray(u.Files) ? u.Files : [],
        Address: u.Address || '',
        LocationTel: u.LocationTel || '',
        EmergencyHospital: u.EmergencyHospital || '',
        EmergencyPolice: u.EmergencyPolice || '',
        SeriesKey: u.SeriesKey || '',
        Positives: u.Positives || '',
        Reflections: u.Reflections || '',
        // ウィザードでは編集しない列。サーバーは全列を上書きするので、UI形オブジェクトが持つ値をそのまま通す(無ければ '')
        PostalCode: u.PostalCode || '',
        VisitorCount: u.VisitorCount || '',
        ParticipantCount: u.ParticipantCount || '',
        PrAssignments: u.PrAssignments || '',
        ResultsMemo: u.ResultsMemo || '',
        ReportStatus: u.ReportStatus || '',  // 報告書ステータスをイベント編集保存でも保持する
        KyokaStatus: u.KyokaStatus || '',    // 許可願ステータスも同様に保持する
        UpdatedBy: u.UpdatedBy || '',
        CreatedAt: u.CreatedAt || '',  // 既存の作成日時を保持（更新・UNDO再作成で消さない）
        UpdatedAt: u.UpdatedAt || ''   // サーバー形キャッシュ統一を将来行うための準備。サーバーは送信値を上書きする。
    };
}

// ---- キャッシュ読込の正規化 ----
// 'events' キャッシュは、イベントページが UI形（Event_Time 等）、home/bot/詳細ページが
// サーバー形（DateEnd/TimeStart 等）を書き込むため、同じキーに2スキーマが混在しうる。
// 直前に別ページがサーバー形で書いていても破綻しないよう、UI形でなければ gasToUi で変換する。
function cacheItemsToUi(items) {
    return (items || []).map(e => (e && 'Event_Time' in e) ? e : gasToUi(e));
}

/**
 * 担当者(members)・実験名(experiments)のdatalist候補を構築。
 * イベントページは events だけを同期するので、members/experiments はキャッシュを使う。
 * キャッシュが無ければ裏で1回だけ取得する。
 */
async function populateDatalists() {
    const memberDl = document.getElementById('member-datalist');
    const expDl = document.getElementById('experiment-datalist');

    let members = (api.loadCache('members') || {}).items;
    let experiments = (api.loadCache('experiments') || {}).items;

    // キャッシュが無ければ裏で取得（失敗しても致命的でない）
    if (!members) {
        try { members = await api.list('members'); api.saveCache('members', members); } catch (_) { members = []; }
    }
    if (!experiments) {
        try { experiments = await api.list('experiments'); api.saveCache('experiments', experiments); } catch (_) { experiments = []; }
    }
    experimentsList = experiments || []; // 実験名の実在チェックに使う

    if (memberDl && members) {
        const curFY = currentFiscalYear();
        memberDl.innerHTML = members
            .filter(m => parseInt(m.FiscalYear || curFY) === curFY && m.Name)
            .map(m => `<option value="${escapeAttr(m.Name)}">${escapeAttr(memberRoleOf(m) || 'メンバー')}</option>`)
            .join('');
    }
    if (expDl && experiments) {
        expDl.innerHTML = experiments
            .filter(e => e.Name)
            .map(e => `<option value="${escapeAttr(e.Name)}">${escapeAttr(getExperimentCategory(e.Category).label)}</option>`)
            .join('');
    }
}

// ---- 日付レンジピッカー（クリックでカレンダーを開く） ----
// events.html の .date-range-picker-wrapper を駆動する。
// 表示用の readonly input をクリックするとポップアップ暦が開き、
// 開始日→終了日の順にクリックすると hidden の Date / Date_End に反映される。
function initDateRangePicker(card) {
    const wrapper = card.querySelector('.date-range-picker-wrapper');
    if (!wrapper) return;
    const display = wrapper.querySelector('.date-range-display');
    const startInput = wrapper.querySelector('[data-field="Date"]');
    const endInput = wrapper.querySelector('[data-field="Date_End"]');
    const popup = wrapper.querySelector('.date-range-popup');
    if (!display || !startInput || !endInput || !popup) return;

    const state = {
        start: startInput.value || '',
        end: endInput.value || '',
        view: parseISODate(startInput.value || todayISO()),
        // 新規作成時は開始日欄に「今日」が初期値として入っている状態で、これはまだ
        // ユーザーが選んだものではない。touched が false のうちは最初のクリックを
        // 必ず開始日として扱う（そうしないと初期値のせいで最初のクリックが終了日
        // 扱いになってしまう）。
        touched: false
    };
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];

    function syncDisplay() {
        if (state.start && state.end && state.end !== state.start) {
            display.value = `${state.start} (${dayOfWeekJP(state.start)}) 〜 ${state.end} (${dayOfWeekJP(state.end)})`;
        } else if (state.start) {
            display.value = `${state.start} (${dayOfWeekJP(state.start)})`;
        } else {
            display.value = '';
        }
        startInput.value = state.start;
        endInput.value = (state.end && state.end !== state.start) ? state.end : '';
        // 開始日が変わると書類期限の表示も更新する
        if (typeof updateDeadlines === 'function') updateDeadlines(startInput);
    }

    function renderCal() {
        const y = state.view.getFullYear();
        const m = state.view.getMonth();
        const startWeekday = new Date(y, m, 1).getDay();
        const daysInMonth = new Date(y, m + 1, 0).getDate();

        let cells = '';
        for (let i = 0; i < startWeekday; i++) cells += '<span class="drp-day drp-empty"></span>';
        for (let d = 1; d <= daysInMonth; d++) {
            const iso = toISODate(new Date(y, m, d));
            const dow = new Date(y, m, d).getDay();
            const cls = ['drp-day'];
            if (dow === 0) cls.push('drp-sun');
            if (dow === 6) cls.push('drp-sat');
            if (holidaysData[iso]) cls.push('drp-holiday');
            if (iso === todayISO()) cls.push('drp-today');
            if (iso === state.start) cls.push('drp-start');
            if (state.end && iso === state.end) cls.push('drp-end');
            if (state.start && state.end && iso > state.start && iso < state.end) cls.push('drp-inrange');
            cells += `<button type="button" class="${cls.join(' ')}" data-iso="${iso}">${d}</button>`;
        }

        popup.innerHTML = `
            <div class="drp-header">
                <button type="button" class="drp-nav" data-nav="-1">‹</button>
                <span class="drp-title">${y}年 ${m + 1}月</span>
                <button type="button" class="drp-nav" data-nav="1">›</button>
            </div>
            <div class="drp-weekdays">${weekdays.map((w, i) => `<span class="${i === 0 ? 'drp-sun' : i === 6 ? 'drp-sat' : ''}">${w}</span>`).join('')}</div>
            <div class="drp-grid">${cells}</div>
            <div class="drp-footer">
                <span class="drp-hint">開始日→終了日の順にクリック</span>
                <button type="button" class="drp-clear">クリア</button>
                <button type="button" class="drp-close">完了</button>
            </div>
        `;
    }

    function openPopup() {
        state.view = parseISODate(state.start || todayISO());
        renderCal();
        popup.classList.remove('hidden');
        setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    }
    function closePopup() {
        popup.classList.add('hidden');
        document.removeEventListener('mousedown', onOutside);
    }
    function onOutside(e) {
        if (!wrapper.contains(e.target)) closePopup();
    }

    display.addEventListener('click', () => {
        if (popup.classList.contains('hidden')) openPopup(); else closePopup();
    });

    popup.addEventListener('click', (e) => {
        const nav = e.target.closest('.drp-nav');
        if (nav) {
            state.view = new Date(state.view.getFullYear(), state.view.getMonth() + parseInt(nav.dataset.nav), 1);
            renderCal();
            return;
        }
        if (e.target.closest('.drp-clear')) {
            state.start = ''; state.end = '';
            syncDisplay(); renderCal();
            return;
        }
        if (e.target.closest('.drp-close')) { closePopup(); return; }

        const day = e.target.closest('.drp-day');
        if (day && day.dataset.iso) {
            const iso = day.dataset.iso;
            if (!state.touched || !state.start || (state.start && state.end) || iso < state.start) {
                // 新しい開始日として設定（終了日はリセット）
                state.start = iso; state.end = '';
            } else {
                // 終了日を設定
                state.end = iso;
            }
            state.touched = true;
            syncDisplay(); renderCal();
            if (state.start && state.end) closePopup();
        }
    });

    syncDisplay();
}

// ---- タグ入力コンポーネント（検索可能な複数選択） ----

function getActiveMembers() {
    const cached = (api.loadCache('members') || {}).items || [];
    const curFY = currentFiscalYear();
    return cached.filter(m => parseInt(m.FiscalYear || curFY) === curFY && m.Name);
}

// 役職判定は app.js の memberRoleOf を使用
function isStaffMember(m) {
    const r = memberRoleOf(m);
    return r === 'アドバイザー' || r === 'コーディネーター';
}
function isRegularMember(m) {
    return !isStaffMember(m);
}

// 開いているタグ入力ドロップダウンをすべて再配置する。row/wizard の再生成のたびに
// window リスナーを追加すると溜まり続けるため、リスナー自体は一度だけ登録する。
let _tagInputViewportListenersBound = false;
function _initTagInputViewportListeners() {
    if (_tagInputViewportListenersBound) return;
    _tagInputViewportListenersBound = true;
    const reposition = () => {
        document.querySelectorAll('.tag-input-dropdown:not(.hidden)').forEach(dd => {
            if (dd.isConnected && dd._reposition) dd._reposition();
        });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
}

function initTagInput(container, selectedValues, placeholder, filterFn) {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'tag-input';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input-field';
    input.placeholder = placeholder || 'メンバーを検索...';

    const dropdown = document.createElement('div');
    dropdown.className = 'tag-input-dropdown hidden';

    wrapper.appendChild(dropdown);
    wrapper.insertBefore(input, dropdown);
    container.appendChild(wrapper);

    let values = [...(selectedValues || [])];

    function renderTags() {
        wrapper.querySelectorAll('.tag-input-tag').forEach(t => t.remove());
        values.forEach(v => {
            const tag = document.createElement('span');
            tag.className = 'tag-input-tag';
            tag.dataset.value = v;
            tag.innerHTML = `${escapeHtml(v)}<button class="tag-input-remove" type="button">&times;</button>`;
            wrapper.insertBefore(tag, input);
        });
    }

    // position:fixed でモーダルの overflow:auto によるクリッピングを避け、
    // 実験内容の datalist のように入力欄の下（入らなければ上）へ画面いっぱいに広げる。
    function positionDropdown() {
        const rect = wrapper.getBoundingClientRect();
        const margin = 8;
        const spaceBelow = window.innerHeight - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        dropdown.style.left = rect.left + 'px';
        dropdown.style.width = rect.width + 'px';
        if (spaceBelow >= 150 || spaceBelow >= spaceAbove) {
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.bottom = '';
            dropdown.style.maxHeight = Math.max(100, spaceBelow) + 'px';
        } else {
            dropdown.style.top = '';
            dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
            dropdown.style.maxHeight = Math.max(100, spaceAbove) + 'px';
        }
    }

    dropdown._reposition = positionDropdown;
    _initTagInputViewportListeners();

    function showDropdown() {
        const query = input.value.toLowerCase().trim();
        const members = filterFn ? getActiveMembers().filter(filterFn) : getActiveMembers();
        const filtered = members.filter(m => {
            if (values.includes(m.Name)) return false;
            if (!query) return true;
            return (m.Name || '').toLowerCase().includes(query) ||
                   (m.Furigana || '').toLowerCase().includes(query);
        });
        if (filtered.length === 0) {
            dropdown.innerHTML = query
                ? '<div class="tag-input-empty">候補なし（Enterで自由入力）</div>'
                : '<div class="tag-input-empty">候補なし</div>';
        } else {
            const maxShow = 30;
            const groups = groupMembersByGrade(filtered);
            let shown = 0;
            let html = '';
            groups.forEach(grp => {
                if (shown >= maxShow) return;
                const take = grp.members.slice(0, maxShow - shown);
                if (take.length === 0) return;
                html += `<div class="tag-input-group-label">${escapeHtml(grp.label)}</div>`;
                html += take.map(m =>
                    `<div class="tag-input-option" data-value="${escapeAttr(m.Name)}">${escapeHtml(m.Name)}${m.Furigana ? ' <span class="text-hint" style="font-size:0.8em;">(' + escapeHtml(m.Furigana) + ')</span>' : ''}</div>`
                ).join('');
                shown += take.length;
            });
            if (filtered.length > maxShow) {
                html += `<div class="tag-input-empty">他 ${filtered.length - maxShow} 件（入力で絞り込み）</div>`;
            }
            dropdown.innerHTML = html;
        }
        dropdown.classList.remove('hidden');
        positionDropdown();
    }

    function hideDropdown() { dropdown.classList.add('hidden'); }

    function addValue(val) {
        val = (val || '').trim();
        if (val && !values.includes(val)) { values.push(val); renderTags(); }
        input.value = '';
        hideDropdown();
    }

    input.addEventListener('focus', showDropdown);
    input.addEventListener('input', showDropdown);
    input.addEventListener('blur', () => setTimeout(hideDropdown, 200));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) addValue(input.value); }
        if (e.key === 'Backspace' && !input.value && values.length > 0) { values.pop(); renderTags(); showDropdown(); }
    });
    dropdown.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const opt = e.target.closest('.tag-input-option');
        if (opt) addValue(opt.dataset.value);
    });
    wrapper.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.tag-input-remove');
        if (removeBtn) {
            e.stopPropagation();
            const tag = removeBtn.closest('.tag-input-tag');
            values = values.filter(v => v !== tag.dataset.value);
            renderTags();
            return;
        }
        input.focus();
    });

    renderTags();
    container._tagInput = {
        getValues: () => [...values],
        setValues: (vals) => { values = [...vals]; renderTags(); }
    };
    return container._tagInput;
}

// ---- PartsList 新旧フォーマット変換 ----
// 旧: [{partName:"一部", items:[{name:"スライム", presenter:"太田"}]}]
// 新: [{name:"スライム", presenters:["太田","鈴木"]}]
function parsePartsList(raw) {
    let data = [];
    if (!raw) return [{ name: '', presenters: [] }];
    try {
        data = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
    } catch (_) { return [{ name: '', presenters: [] }]; }
    if (!Array.isArray(data) || data.length === 0) return [{ name: '', presenters: [] }];

    if (data[0] && data[0].partName !== undefined) {
        const flat = [];
        data.forEach(p => (p.items || []).forEach(it => {
            if (!it.name && !it.presenter) return;
            const existing = flat.find(f => f.name === it.name);
            if (existing && it.presenter && !existing.presenters.includes(it.presenter)) {
                existing.presenters.push(it.presenter);
            } else if (!existing) {
                flat.push({ name: it.name || '', presenters: it.presenter ? [it.presenter] : [] });
            }
        }));
        return flat.length > 0 ? flat : [{ name: '', presenters: [] }];
    }

    return data.map(item => ({
        name: item.name || '',
        presenters: Array.isArray(item.presenters) ? item.presenters : (item.presenter ? [item.presenter] : [])
    }));
}

// ---- 実験行の生成・追加・削除 ----

function buildExperimentRow(expName, presenters) {
    const row = document.createElement('div');
    row.className = 'experiment-row';
    row.innerHTML = `
        <div class="exp-name-col">
            <label>実験内容</label>
            <input type="text" class="e1-input experiment-name" value="${escapeAttr(expName || '')}" placeholder="実験名を検索..." list="experiment-datalist">
        </div>
        <div class="exp-presenter-col">
            <label>発表者</label>
            <div class="presenter-tag-container"></div>
        </div>
        <button class="btn-del" onclick="removeExperimentRow(this)" type="button">✖</button>
    `;
    // 発表者の候補はコーディネーター・アドバイザーを除いたメンバーのみ
    initTagInput(row.querySelector('.presenter-tag-container'), presenters || [], '発表者を検索...', isRegularMember);
    const nameInput = row.querySelector('.experiment-name');
    nameInput.addEventListener('input', () => nameInput.classList.remove('input-invalid'));
    return row;
}

// 入力された実験名が実験マスタに実在するか検証し、無いものに印を付けて返す。
// タイポのまま保存すると振り返りが別の実験（または宙）に紐づいてしまうため、先へ進めない。
function invalidExperimentNames() {
    const container = document.getElementById('wz-ev-exp-container');
    if (!container) return [];
    if (experimentsList.length === 0) {
        // マスタを取得できていない（または空）。実在チェックはスキップして入力は妨げないが、無言で無効化せず警告する
        const hasName = Array.from(container.querySelectorAll('.experiment-name')).some(input => input.value.trim());
        if (hasName && !experimentsMasterWarned) {
            experimentsMasterWarned = true;
            toast('実験ネタの一覧を取得できていないため、実験名が登録済みかどうかの確認をスキップしました。名前に誤りがないか確認してください', 'info', 6000);
        }
        return [];
    }
    const invalid = [];
    container.querySelectorAll('.experiment-name').forEach(input => {
        const name = input.value.trim();
        const ok = !name || experimentsList.some(e => e.Name === name);
        input.classList.toggle('input-invalid', !ok);
        if (!ok) invalid.push(name);
    });
    return invalid;
}

function toastInvalidExperiment(names) {
    toast(`実験「${names[0]}」は登録されていません。実験ネタにある名前から選んでください`, 'error', 5000);
    const el = document.querySelector('#wz-ev-exp-container .experiment-name.input-invalid');
    if (el) el.focus();
}

function addExperimentRow(btn) {
    const container = btn.closest('.e1-group').querySelector('.experiments-container');
    container.appendChild(buildExperimentRow('', []));
}

function removeExperimentRow(btn) {
    const row = btn.closest('.experiment-row');
    const container = row.parentElement;
    row.remove();
    if (container.children.length === 0) {
        addExperimentRow(container.closest('.e1-group').querySelector('.btn-add-exp'));
    }
}

// ---- イベント ウィザード（既存イベントの編集用） ----

function genTimeOpts(startH, endH, withEmpty) {
    let html = withEmpty ? '<option value="">--</option>' : '';
    for (let h = startH; h <= endH; h++) {
        for (let m = 0; m < 60; m += 30) {
            if (h === endH && m > 0) break;
            const v = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
            html += `<option value="${v}">${v}</option>`;
        }
    }
    return html;
}

// editId のみ: 既存イベントの編集。template のみ（editId 無し）: 複製して新規作成
// （この場合だけは、クイック作成の「枠だけ」ではなく実験・担当などの詳細もこの場で全て入力する）。
function openEventWizard(editId, template) {
    editingEventId = editId || null;
    evWizardStep = 0;

    let e, isEdit;
    if (editingEventId) {
        const existing = _wzHost().getEvent(editingEventId);
        if (!existing) return;
        isEdit = true;
        e = { ...existing, Files: Array.isArray(existing.Files) ? [...existing.Files] : [] };
    } else if (template) {
        isEdit = false;
        e = {
            ...template,
            ID: genId('ev_'),
            Date: todayISO(), Date_End: '',
            Meeting_Number: '',
            Files: [],
            Kyoka_Deadline: '', Houkoku_Deadline: '',
            ReportStatus: '', KyokaStatus: '',
            Positives: '', Reflections: '', ResultsMemo: '',
            UpdatedAt: '', CreatedAt: ''
        };
    } else {
        return; // 新規作成（複製ではない）はクイック作成（openQuickCreate）に一本化した
    }
    evWizardCategory = e.Category || 'normal';

    tempNewEvent = e;
    experimentsMasterWarned = false;
    e._sessionUploads = []; // このウィザードでアップロードした R2 ファイルの driveId（保存せず閉じたら消す）

    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const isAdmin = api.isAdmin();
    const catInfo = getEventCategory(evWizardCategory);

    const overlay = document.createElement('div');
    overlay.id = 'ev-wizard-overlay';
    overlay.className = 'wizard-overlay';

    // 時間未定のイベントに架空の時間を入れない（空欄 = 未定のまま保存できる）
    const timeStart = (e.Event_Time || '').split(' - ')[0]?.trim() || '';
    const timeEnd = (e.Event_Time || '').split(' - ')[1]?.trim() || '';

    let stepsHtml = '';

    if (isMeeting) {
        // Meeting step 1: 基本情報
        stepsHtml += `
            <div class="wizard-step active" data-step="0">
                <div class="wizard-step-label">Step 1 / ${steps.length} &mdash; ${steps[0].label}</div>
                <div style="margin-bottom:12px;"><span class="cat-badge" style="background:${catInfo.bg};color:${catInfo.text};">${catInfo.short}</span></div>
                <div class="flex-row">
                    <div class="e1-group" style="flex:0 0 100px;">
                        <label class="e1-label">回数</label>
                        <input id="wz-ev-meeting-num" class="e1-input" type="number" placeholder="3" value="${escapeAttr(e.Meeting_Number || '')}">
                    </div>
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">ミーティング名</label>
                        <input id="wz-ev-title" class="e1-input" type="text" placeholder="例: イベント振り返り" value="${escapeAttr(e.Title || '')}">
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">場所</label>
                    <input id="wz-ev-location" class="e1-input" type="text" placeholder="例: 学生会館3F" value="${escapeAttr(e.Location || '')}">
                </div>
            </div>`;
        // Meeting step 2: 日時
        stepsHtml += `
            <div class="wizard-step" data-step="1">
                <div class="wizard-step-label">Step 2 / ${steps.length} &mdash; ${steps[1].label}</div>
                <div class="e1-group">
                    <label class="e1-label">日にち</label>
                    <div class="date-range-picker-wrapper">
                        <input type="text" class="e1-input date-range-display" id="wz-ev-date-display" readonly placeholder="クリックして日にちを選択">
                        <input type="hidden" id="wz-ev-date" data-field="Date" value="${escapeAttr(e.Date || '')}">
                        <input type="hidden" id="wz-ev-date-end" data-field="Date_End" value="${escapeAttr(e.Date_End || '')}">
                        <div class="date-range-popup hidden"></div>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">ミーティング時間（未定なら空欄のまま）</label>
                    <div class="time-select-group">
                        <select class="e1-input" id="wz-ev-time-start">${genTimeOpts(7, 21, true)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="wz-ev-time-end">${genTimeOpts(7, 21, true)}</select>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">出欠回答の締切（任意）</label>
                    <input type="date" id="wz-ev-vote-deadline" class="e1-input" value="${escapeAttr(e.Vote_Deadline || '')}">
                    <span class="text-muted" style="font-size:0.8rem;">未設定なら最終日まで回答できます。締切後の変更は管理者のみ。</span>
                </div>
            </div>`;
        // Meeting step 3: その他
        stepsHtml += `
            <div class="wizard-step" data-step="2">
                <div class="wizard-step-label">Step 3 / ${steps.length} &mdash; ${steps[2].label}</div>
                <div class="e1-group">
                    <label class="e1-label">議題 / 備考</label>
                    <textarea id="wz-ev-remarks" class="e1-input" rows="6" placeholder="議題や備考を入力">${escapeHtml(e.Remarks || '')}</textarea>
                </div>
            </div>`;
    } else {
        // Event step 1: 基本情報
        stepsHtml += `
            <div class="wizard-step active" data-step="0">
                <div class="wizard-step-label">Step 1 / ${steps.length} &mdash; ${steps[0].label}</div>
                <div style="margin-bottom:12px;"><span class="cat-badge" style="background:${catInfo.bg};color:${catInfo.text};">${catInfo.short}</span></div>
                <div class="e1-group">
                    <label class="e1-label">イベント名 *</label>
                    <input id="wz-ev-title" class="e1-input" type="text" placeholder="例: サイエンスフェスタ" value="${escapeAttr(e.Title || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">企画名</label>
                    <input id="wz-ev-planname" class="e1-input" type="text" placeholder="例: 夏休み科学教室" value="${escapeAttr(e.PlanName || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">場所</label>
                    <input id="wz-ev-location" class="e1-input" type="text" placeholder="例: ○○公民館" value="${escapeAttr(e.Location || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">対象者・人数</label>
                    <input id="wz-ev-audience" class="e1-input" type="text" placeholder="例: 小学1〜3年生 40名" value="${escapeAttr(e.Audience || '')}">
                </div>
            </div>`;
        // Event step 2: 日時
        stepsHtml += `
            <div class="wizard-step" data-step="1">
                <div class="wizard-step-label">Step 2 / ${steps.length} &mdash; ${steps[1].label}</div>
                <div class="e1-group">
                    <label class="e1-label">日にち</label>
                    <div class="date-range-picker-wrapper">
                        <input type="text" class="e1-input date-range-display" id="wz-ev-date-display" readonly placeholder="クリックして日にちを選択">
                        <input type="hidden" id="wz-ev-date" data-field="Date" value="${escapeAttr(e.Date || '')}">
                        <input type="hidden" id="wz-ev-date-end" data-field="Date_End" value="${escapeAttr(e.Date_End || '')}">
                        <div class="date-range-popup hidden"></div>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">イベント時間（未定なら空欄のまま）</label>
                    <div class="time-select-group">
                        <select class="e1-input" id="wz-ev-time-start">${genTimeOpts(7, 21, true)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="wz-ev-time-end">${genTimeOpts(7, 21, true)}</select>
                    </div>
                </div>
                <div class="flex-row">
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">集合時間</label>
                        <select class="e1-input" id="wz-ev-gather">${genTimeOpts(7, 21, true)}</select>
                    </div>
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">解散時間</label>
                        <select class="e1-input" id="wz-ev-dismiss">${genTimeOpts(7, 21, true)}</select>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">出欠回答の締切（任意）</label>
                    <input type="date" id="wz-ev-vote-deadline" class="e1-input" value="${escapeAttr(e.Vote_Deadline || '')}">
                    <span class="text-muted" style="font-size:0.8rem;">未設定なら最終日まで回答できます。締切後の変更は管理者のみ。</span>
                </div>
            </div>`;
        // Event step 3: 実験・担当
        stepsHtml += `
            <div class="wizard-step" data-step="2">
                <div class="wizard-step-label">Step 3 / ${steps.length} &mdash; ${steps[2].label}</div>
                <div class="e1-group">
                    <label class="e1-label">実験内容・発表者</label>
                    <div id="wz-ev-exp-container" class="experiments-container"></div>
                    <button class="btn-add-exp" onclick="addWzEvExpRow()" type="button">＋ 実験を追加</button>
                </div>
                <div class="e1-group">
                    <label class="e1-label">帯同（コーディネーター・アドバイザー）</label>
                    <div id="wz-ev-accompany"></div>
                </div>
            </div>`;
        // Event step 4: その他
        stepsHtml += `
            <div class="wizard-step" data-step="3">
                <div class="wizard-step-label">Step 4 / ${steps.length} &mdash; ${steps[3].label}</div>
                <div class="e1-group">
                    <label class="e1-label">スケジュール・運搬</label>
                    <textarea id="wz-ev-logistics" class="e1-input" rows="4" placeholder="タイムテーブルや運搬の段取り">${escapeHtml(e.Meeting_Logistics || '')}</textarea>
                </div>
                <div class="e1-group">
                    <label class="e1-label">備考</label>
                    <textarea id="wz-ev-remarks" class="e1-input" rows="3" placeholder="その他メモ">${escapeHtml(e.Remarks || '')}</textarea>
                </div>
                <div class="e1-group">
                    <label class="e1-label">関連ファイル</label>
                    <div class="file-upload-area">
                        <div class="file-drop-zone" id="wz-ev-drop-zone">
                            <p style="margin:0; font-weight:bold;">ファイルをここにドラッグ＆ドロップ</p>
                            <p style="margin:5px 0 0 0; font-size:0.85rem;">またはクリックして選択 (上限 10MB/ファイル)</p>
                        </div>
                        <input type="file" id="wz-ev-file-input" multiple style="display:none;">
                        <div id="wz-ev-file-list" class="file-list-edit"></div>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">書類期限（日付は自動計算されます）</label>
                    <div class="deadline-grid">
                        <div>
                            <label class="text-label doc-not-required-toggle">
                                <input type="checkbox" id="wz-ev-kyoka-not-required" ${e.KyokaNotRequired ? 'checked' : ''} onchange="onDocNotRequiredToggle('kyoka')">
                                許可願は不要
                            </label>
                            <div id="wz-ev-kyoka-fields" class="${e.KyokaNotRequired ? 'hidden' : ''}">
                                <label class="text-label" style="font-size:0.85rem; display:block; margin-bottom:4px;">許可願 (担当)</label>
                                <div id="wz-ev-admin-kyoka"></div>
                                <span class="text-muted" style="font-size:0.8rem;">期限: <span id="wz-ev-kyoka-dl">${escapeHtml(e.Kyoka_Deadline || '---')}</span></span>
                            </div>
                        </div>
                        <div>
                            <label class="text-label doc-not-required-toggle">
                                <input type="checkbox" id="wz-ev-houkoku-not-required" ${e.HoukokuNotRequired ? 'checked' : ''} onchange="onDocNotRequiredToggle('houkoku')">
                                報告書は不要
                            </label>
                            <div id="wz-ev-houkoku-fields" class="${e.HoukokuNotRequired ? 'hidden' : ''}">
                                <label class="text-label" style="font-size:0.85rem; display:block; margin-bottom:4px;">報告書 (担当)</label>
                                <div id="wz-ev-admin-houkoku"></div>
                                <span class="text-muted" style="font-size:0.8rem;">期限: <span id="wz-ev-houkoku-dl">${escapeHtml(e.Houkoku_Deadline || '---')}</span></span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    overlay.innerHTML = `
        <div class="wizard-panel" role="dialog" aria-modal="true" style="max-width:560px;">
            <div class="wizard-header">
                <h2 class="wizard-title">${isEdit ? 'イベントを編集' : '予定を複製して追加'}</h2>
                <p class="wizard-subtitle">${isEdit ? escapeHtml(e.Title || '') : `「${escapeHtml(template.Title || '(無題)')}」の内容を引き継いで作成します`}</p>
            </div>
            <div class="wizard-progress">
                ${steps.map((s, i) => `
                    ${i > 0 ? '<div class="wizard-step-line" data-line="' + i + '"></div>' : ''}
                    <button type="button" class="wizard-step-dot${i === 0 ? ' active' : ''}" data-dot="${i}" title="${escapeAttr(s.label)}へ移動" data-action="ew-goto">${i + 1}</button>
                `).join('')}
            </div>
            <div class="wizard-body">${stepsHtml}</div>
            <div class="wizard-footer">
                ${isEdit && isAdmin ? '<button class="btn btn-danger" onclick="deleteFromEvWizard()">削除</button>' : ''}
                <div class="wizard-footer-spacer"></div>
                <button class="btn btn-text" onclick="closeEventWizard()">キャンセル</button>
                <button id="wz-ev-prev" class="btn btn-secondary" onclick="evWizardPrev()" style="display:none;">戻る</button>
                <button id="wz-ev-next" class="btn btn-primary" onclick="evWizardNext()">次へ</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    trapFocus(overlay.querySelector('.wizard-panel'));

    // Initialize time selects
    const tsEl = document.getElementById('wz-ev-time-start');
    const teEl = document.getElementById('wz-ev-time-end');
    if (tsEl) tsEl.value = timeStart;
    if (teEl) teEl.value = timeEnd;
    if (!isMeeting) {
        const gEl = document.getElementById('wz-ev-gather');
        const dEl = document.getElementById('wz-ev-dismiss');
        if (gEl) gEl.value = e.Gather_Time || '';
        if (dEl) dEl.value = e.Dismiss_Time || '';
    }

    // Initialize date range picker
    initDateRangePicker(overlay);

    // Initialize experiment rows (event only)
    if (!isMeeting) {
        const expContainer = document.getElementById('wz-ev-exp-container');
        const expList = parsePartsList(e.PartsList);
        expList.forEach(item => {
            expContainer.appendChild(buildExperimentRow(item.name, item.presenters));
        });

        // Initialize accompany tag input
        const accompanyEl = document.getElementById('wz-ev-accompany');
        const accompanyVals = (e.Accompany || '').split(',').map(s => s.trim()).filter(Boolean);
        initTagInput(accompanyEl, accompanyVals, 'コーディネーター・アドバイザーを検索...', isStaffMember);

        // Initialize admin tag inputs for deadlines
        const kyokaEl = document.getElementById('wz-ev-admin-kyoka');
        const houkokuEl = document.getElementById('wz-ev-admin-houkoku');
        const kyokaVals = (e.Admin_Kyoka || '').split(',').map(s => s.trim()).filter(Boolean);
        const houkokuVals = (e.Admin_Houkoku || '').split(',').map(s => s.trim()).filter(Boolean);
        initTagInput(kyokaEl, kyokaVals, '担当者を検索...', isRegularMember);
        initTagInput(houkokuEl, houkokuVals, '担当者を検索...', isRegularMember);

        // File upload bindings
        const dropZone = document.getElementById('wz-ev-drop-zone');
        const fileInput = document.getElementById('wz-ev-file-input');
        if (dropZone) {
            dropZone.addEventListener('drop', (ev) => { ev.preventDefault(); dropZone.classList.remove('dragover'); const files = [...(ev.dataTransfer.files || [])]; if (files.length) wzUploadFiles(files); });
            dropZone.addEventListener('dragover', (ev) => ev.preventDefault());
            dropZone.addEventListener('dragenter', () => dropZone.classList.add('dragover'));
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
            dropZone.addEventListener('click', () => fileInput.click());
        }
        if (fileInput) {
            fileInput.addEventListener('change', () => { wzUploadFiles(Array.from(fileInput.files)); fileInput.value = ''; });
        }
        // Render existing files
        wzRefreshFileList();
    }

    // 領域外クリック・Esc は、入力に変更があれば破棄確認を挟む（誤タップで編集内容が消えないように）。
    // 初期値の流し込み（時間セレクト・日付ピッカー・タグ入力）が終わった後に呼ぶこと。
    bindEditDismissGuard(overlay, closeEventWizard);

    setTimeout(() => {
        const firstInput = overlay.querySelector('.wizard-step.active input:not([type="hidden"]), .wizard-step.active textarea, .wizard-step.active select');
        if (firstInput) firstInput.focus();
    }, 80);
}

// 保存しないで閉じたときは、このウィザードでアップロード済みの未保存ファイルを R2 から消す。
// 保存時は saveEventFromWizard が _sessionUploads を空にしてから呼ぶので、保存したファイルは消えない。
function closeEventWizard() {
    const overlay = document.getElementById('ev-wizard-overlay');
    if (overlay) overlay.remove();
    if (tempNewEvent && Array.isArray(tempNewEvent._sessionUploads)) {
        tempNewEvent._sessionUploads.forEach(discardUploadedFile);
        tempNewEvent._sessionUploads = [];
    }
    editingEventId = null;
    evWizardStep = 0;
    tempNewEvent = null;
}

// アップロード済みで不要になったファイルを R2 から消す。deleteFile は管理者のみ可能なので、
// 権限が無いなどで失敗しても握りつぶさずコンソールに残す。
function discardUploadedFile(driveId) {
    if (!driveId) return;
    api.deleteFile(driveId).catch(err => {
        console.warn('不要になったアップロード済みファイルを削除できませんでした（管理者権限が必要な場合があります）:', driveId, err && err.message);
    });
}

function updateEvWizardUI() {
    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const total = steps.length;
    const isLast = evWizardStep === total - 1;

    document.querySelectorAll('#ev-wizard-overlay .wizard-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === evWizardStep);
    });
    document.querySelectorAll('#ev-wizard-overlay .wizard-step-dot').forEach(el => {
        const i = parseInt(el.dataset.dot);
        el.classList.toggle('active', i === evWizardStep);
        el.classList.toggle('done', i < evWizardStep);
    });
    document.querySelectorAll('#ev-wizard-overlay .wizard-step-line').forEach(el => {
        const i = parseInt(el.dataset.line);
        el.classList.toggle('done', i <= evWizardStep);
    });

    const prevBtn = document.getElementById('wz-ev-prev');
    const nextBtn = document.getElementById('wz-ev-next');
    if (prevBtn) prevBtn.style.display = evWizardStep > 0 ? '' : 'none';
    if (nextBtn) nextBtn.textContent = isLast ? '保存' : '次へ';
}

function evWizardPrev() {
    if (evWizardStep > 0) { evWizardStep--; updateEvWizardUI(); }
}

// 進捗ドットのクリックで任意のステップへ移動（1項目だけ直したい時に全ステップたどらなくてよい）
function evWizardGoto(n) {
    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    if (n < 0 || n >= steps.length || n === evWizardStep) return;
    evWizardStep = n;
    updateEvWizardUI();
    const step = document.querySelector('#ev-wizard-overlay .wizard-step.active');
    if (step) {
        const fi = step.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
        if (fi) setTimeout(() => fi.focus(), 100);
    }
}

function evWizardNext() {
    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const total = steps.length;

    if (evWizardStep === 0 && !isMeeting) {
        const title = document.getElementById('wz-ev-title').value.trim();
        if (!title) {
            toast('イベント名を入力してください', 'error');
            document.getElementById('wz-ev-title').focus();
            return;
        }
    }

    // 実験・担当ステップから先へ進む前に、実験名が実在するか確認する
    if (evWizardStep === 2 && !isMeeting) {
        const bad = invalidExperimentNames();
        if (bad.length > 0) {
            toastInvalidExperiment(bad);
            return;
        }
    }

    if (evWizardStep < total - 1) {
        evWizardStep++;
        updateEvWizardUI();
        const step = document.querySelector('#ev-wizard-overlay .wizard-step.active');
        if (step) {
            const fi = step.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select');
            if (fi) setTimeout(() => fi.focus(), 100);
        }
    } else {
        saveEventFromWizard();
    }
}

function addWzEvExpRow() {
    const container = document.getElementById('wz-ev-exp-container');
    if (container) container.appendChild(buildExperimentRow('', []));
}

// ---- ウィザード内ファイルアップロード ----
async function wzUploadFiles(fileList) {
    // 開始時の対象を握る。完了時に tempNewEvent が別物（閉じた・別イベントに切替）なら結果を捨てる。
    const target = tempNewEvent;
    if (!target) return;
    const maxSizeMB = (CONFIG.FILE_UPLOAD && CONFIG.FILE_UPLOAD.maxSizeMB) || 10;
    for (const file of fileList) {
        if (tempNewEvent !== target) return;
        if (file.size > maxSizeMB * 1024 * 1024) {
            toast(`「${file.name}」はサイズ上限(${maxSizeMB}MB)を超えています`, 'error');
            continue;
        }
        if (!Array.isArray(target.Files)) target.Files = [];
        if (!Array.isArray(target._sessionUploads)) target._sessionUploads = [];

        const placeholder = { name: file.name, size: file.size, _uploading: true };
        target.Files.push(placeholder);
        wzRefreshFileList();

        try {
            const result = await api.uploadFile(file);
            const idx = target.Files.indexOf(placeholder);
            if (tempNewEvent !== target || idx < 0) {
                // ウィザードが閉じた／切り替わった、またはキャンセル済み → 一覧に戻さず、アップロード済みの実体を消す
                discardUploadedFile(result && result.driveId);
                continue;
            }
            target.Files[idx] = result;
            if (result && result.driveId) target._sessionUploads.push(result.driveId);
            toast(`「${file.name}」をアップロードしました`, 'success', 2000);
        } catch (err) {
            if (tempNewEvent !== target) return;
            const idx = target.Files.indexOf(placeholder);
            if (idx < 0) continue; // キャンセル済み。失敗を表示しない
            toast(`「${file.name}」のアップロード失敗: ${err.message}`, 'error');
            target.Files[idx] = { name: file.name, size: file.size, _failed: true };
        }
        wzRefreshFileList();
    }
}

// ウィザード内ボタンの委譲先（onclick 属性にインデックス等を埋め込まない。app.js の registerActions 参照）
registerActions({
    'ew-goto': el => evWizardGoto(Number(el.dataset.dot)),
    'ew-remove-file': el => wzRemoveFile(Number(el.dataset.index))
});

function wzRemoveFile(index) {
    if (!tempNewEvent || !Array.isArray(tempNewEvent.Files)) return;
    const file = tempNewEvent.Files[index];
    if (!file) return;
    if (file.driveId) {
        const si = Array.isArray(tempNewEvent._sessionUploads) ? tempNewEvent._sessionUploads.indexOf(file.driveId) : -1;
        if (si >= 0) {
            // このウィザードでアップロードしたばかりのファイル（未保存）は、その場で実体も消す
            tempNewEvent._sessionUploads.splice(si, 1);
            discardUploadedFile(file.driveId);
        } else {
            // 保存済みのファイルは、イベントの保存が成功してから消す（保存に失敗しても失われないように）
            if (!Array.isArray(tempNewEvent._filesToDelete)) tempNewEvent._filesToDelete = [];
            tempNewEvent._filesToDelete.push(file.driveId);
        }
    }
    tempNewEvent.Files.splice(index, 1);
    wzRefreshFileList();
}

function wzRefreshFileList() {
    const el = document.getElementById('wz-ev-file-list');
    if (!el || !tempNewEvent) return;
    const files = tempNewEvent.Files || [];
    if (files.length === 0) { el.innerHTML = ''; return; }
    // ファイル実体（R2）を消せるのは管理者だけ。それ以外の人が外したファイルは、この一覧から外れるだけで保存領域には残る。
    const isAdmin = api.isAdmin();
    const removeHint = isAdmin ? '' : '<p class="text-hint" style="font-size:0.78rem; margin:6px 0 0;">※ ファイルを外しても、保存領域からは削除されません（削除は管理者のみ可能です）</p>';
    el.innerHTML = files.map((f, i) => {
        const name = escapeHtml(f.name || ('ファイル ' + (i + 1)));
        const size = f.size ? formatFileSize(f.size) : '';
        const uploading = f._uploading;
        const failed = f._failed;
        let statusCls = '';
        let statusLabel = '';
        if (uploading) { statusCls = ' uploading'; statusLabel = ' (アップロード中...)'; }
        if (failed) { statusCls = ' upload-failed'; statusLabel = ' (アップロード失敗)'; }
        return `
            <div class="file-item${statusCls}" data-index="${i}">
                <span class="file-name">${name}${statusLabel}</span>
                <span class="file-size">${size}</span>
                <div class="file-actions">
                    ${!uploading && !failed && safeHttpUrl(f.url) ? `<a href="${escapeAttr(safeHttpUrl(f.url))}" target="_blank" rel="noopener" class="tbl-btn">開く</a>` : ''}
                    <button class="tbl-btn tbl-btn-danger" data-action="ew-remove-file" data-index="${i}" type="button">${uploading ? 'キャンセル' : (isAdmin ? '削除' : '外す')}</button>
                </div>
            </div>
        `;
    }).join('') + removeHint;
}

// ---- ウィザードから保存 ----
function saveEventFromWizard() {
    if (!tempNewEvent) return;

    const isMeeting = evWizardCategory === 'general' || evWizardCategory === 'admin';

    // Collect form data
    tempNewEvent.Title = (document.getElementById('wz-ev-title')?.value || '').trim();
    if (!tempNewEvent.Title) {
        // ドットで直接最終ステップへ来られるため、保存時にも必須チェックする
        toast(isMeeting ? 'ミーティング名を入力してください' : 'イベント名を入力してください', 'error');
        evWizardGoto(0);
        return;
    }
    tempNewEvent.Location = (document.getElementById('wz-ev-location')?.value || '').trim();
    const planNameEl = document.getElementById('wz-ev-planname');
    if (planNameEl) tempNewEvent.PlanName = planNameEl.value.trim();
    tempNewEvent.Category = evWizardCategory;
    tempNewEvent.Date = document.getElementById('wz-ev-date')?.value || '';
    tempNewEvent.Date_End = document.getElementById('wz-ev-date-end')?.value || '';
    tempNewEvent.Remarks = (document.getElementById('wz-ev-remarks')?.value || '');
    // 出欠回答の締切（任意）。欄が無い画面（クイック作成）では既存値を保持する。
    const voteDlEl = document.getElementById('wz-ev-vote-deadline');
    if (voteDlEl) tempNewEvent.Vote_Deadline = voteDlEl.value || '';

    const ts = document.getElementById('wz-ev-time-start')?.value || '';
    const te = document.getElementById('wz-ev-time-end')?.value || '';
    if ((ts && !te) || (!ts && te)) {
        toast('時間は開始と終了の両方を選択してください（未定なら両方空欄）', 'error');
        evWizardGoto(1);
        return;
    }
    if (ts && te && te <= ts) {
        toast('終了時刻は開始時刻より後にしてください', 'error');
        evWizardGoto(1);
        return;
    }
    tempNewEvent.Event_Time = ts && te ? `${ts} - ${te}` : '';

    if (isMeeting) {
        tempNewEvent.Meeting_Number = document.getElementById('wz-ev-meeting-num')?.value || '';
    } else {
        // ドットで直接最終ステップへ来られるため、保存時にも実験名の実在チェックをする
        const badExps = invalidExperimentNames();
        if (badExps.length > 0) {
            evWizardGoto(2);
            toastInvalidExperiment(badExps);
            return;
        }
        tempNewEvent.Audience = (document.getElementById('wz-ev-audience')?.value || '').trim();
        tempNewEvent.Gather_Time = document.getElementById('wz-ev-gather')?.value || '';
        tempNewEvent.Dismiss_Time = document.getElementById('wz-ev-dismiss')?.value || '';
        tempNewEvent.Meeting_Logistics = (document.getElementById('wz-ev-logistics')?.value || '');

        // Collect experiments
        const expContainer = document.getElementById('wz-ev-exp-container');
        if (expContainer) {
            const rows = expContainer.querySelectorAll('.experiment-row');
            const collected = [];
            rows.forEach(row => {
                const name = (row.querySelector('.experiment-name')?.value || '').trim();
                const tagContainer = row.querySelector('.presenter-tag-container');
                const presenters = tagContainer?._tagInput ? tagContainer._tagInput.getValues() : [];
                if (name || presenters.length > 0) collected.push({ name, presenters });
            });
            tempNewEvent.PartsList = JSON.stringify(collected);
        }

        // 書類が不要な場合は担当者・期限を持たせない（チェックを外せばまた計算に戻る）
        tempNewEvent.KyokaNotRequired = document.getElementById('wz-ev-kyoka-not-required')?.checked ? 'true' : '';
        tempNewEvent.HoukokuNotRequired = document.getElementById('wz-ev-houkoku-not-required')?.checked ? 'true' : '';

        // Collect tag inputs（不要チェック時は、非表示のタグ入力に値が残っていても採用しない）
        const accompanyEl = document.getElementById('wz-ev-accompany');
        if (accompanyEl?._tagInput) tempNewEvent.Accompany = accompanyEl._tagInput.getValues().join(', ');
        if (tempNewEvent.KyokaNotRequired) {
            tempNewEvent.Admin_Kyoka = '';
        } else {
            const kyokaEl = document.getElementById('wz-ev-admin-kyoka');
            if (kyokaEl?._tagInput) tempNewEvent.Admin_Kyoka = kyokaEl._tagInput.getValues().join(', ');
        }
        if (tempNewEvent.HoukokuNotRequired) {
            tempNewEvent.Admin_Houkoku = '';
        } else {
            const houkokuEl = document.getElementById('wz-ev-admin-houkoku');
            if (houkokuEl?._tagInput) tempNewEvent.Admin_Houkoku = houkokuEl._tagInput.getValues().join(', ');
        }
    }

    // Recalculate deadlines（不要フラグが立っている方は期限を持たせない）
    if (isMeeting) {
        tempNewEvent.Kyoka_Deadline = '';
        tempNewEvent.Houkoku_Deadline = '';
    } else {
        const dl = calculateDeadlines(tempNewEvent.Date);
        tempNewEvent.Kyoka_Deadline = tempNewEvent.KyokaNotRequired ? '' : dl.kyoka;
        tempNewEvent.Houkoku_Deadline = tempNewEvent.HoukokuNotRequired ? '' : dl.houkoku;
    }

    // Uploading check
    if (Array.isArray(tempNewEvent.Files) && tempNewEvent.Files.some(f => f._uploading)) {
        toast('ファイルのアップロードが完了するまでお待ちください', 'error');
        return;
    }
    if (Array.isArray(tempNewEvent.Files)) {
        tempNewEvent.Files = tempNewEvent.Files.filter(f => !f._failed);
    }

    const host = _wzHost();
    const eventId = tempNewEvent.ID;
    const isExisting = !!host.getEvent(eventId);
    const gasItem = uiToGas(tempNewEvent);
    const openedUpdatedAt = tempNewEvent.UpdatedAt || '';

    const filesToDelete = Array.isArray(tempNewEvent._filesToDelete) ? tempNewEvent._filesToDelete.slice() : [];
    // このウィザードでアップロードして、いま一覧に残っているファイル（保存に成功しなければ孤児になる）
    const uploadedNow = Array.isArray(tempNewEvent._sessionUploads) ? tempNewEvent._sessionUploads.slice() : [];
    tempNewEvent._sessionUploads = []; // closeEventWizard がアップロード済みファイルを消さないようにする

    // Optimistic UI
    const snapshot = host.snapshot();
    const optimisticItem = { ...tempNewEvent };
    delete optimisticItem._filesToDelete;
    delete optimisticItem._sessionUploads;
    host.applyOptimistic(optimisticItem);

    closeEventWizard();
    toast('保存しました', 'success');

    // 許可願の期限が過去なのにイベントがまだ先の場合は注意を促す（保存は妨げない）
    if (!isMeeting && optimisticItem.Kyoka_Deadline && optimisticItem.Kyoka_Deadline < todayISO()
        && (optimisticItem.Date_End || optimisticItem.Date) >= todayISO()) {
        toast(`許可願の期限（${optimisticItem.Kyoka_Deadline}）を過ぎています。至急対応してください`, 'error', 6000);
    }

    // 同じイベントへの保存（詳細ページの個別保存など）が送信中なら、その完了を待ってから送る。
    // 待っている間に自分の保存で UpdatedAt が進んでいたら、それを基準にする（別の人の編集だけを競合とみなす）。
    runEventSaveSerial(eventId, () => {
        if (isExisting) {
            const live = host.getEvent(eventId);
            const liveStamp = live && live.UpdatedAt;
            gasItem._baseUpdatedAt = (liveStamp && liveStamp !== openedUpdatedAt && isOwnSavedStamp(eventId, liveStamp))
                ? liveStamp : openedUpdatedAt;
        }
        return api.save('events', gasItem);
    }).then(savedGas => {
        host.commitSaved(savedGas);
        if (savedGas && savedGas.UpdatedAt) _ownSavedStamps.add(eventId + ':' + savedGas.UpdatedAt);
        filesToDelete.forEach(driveId => {
            api.deleteFile(driveId).catch(err => {
                // 削除は管理者のみ可能。イベントからは外れているが、R2 には残る
                console.warn('外したファイルを削除できませんでした（管理者権限が必要な場合があります）:', driveId, err && err.message);
            });
        });
    }).catch(err => {
        host.rollback(snapshot);
        if (String(err.message).includes('conflict')) {
            // 競合ならサーバーは何も保存していない。今回アップロードしたファイルは参照されないので消す
            uploadedNow.forEach(discardUploadedFile);
            toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', 5000);
            host.onConflict();
        } else {
            toast('保存失敗: ' + err.message, 'error');
        }
    });
}

// 「許可願/報告書は不要」チェック時、担当者・期限入力を隠す（保存時は担当も期限も送らない）
function onDocNotRequiredToggle(type) {
    const checkbox = document.getElementById(`wz-ev-${type}-not-required`);
    const fields = document.getElementById(`wz-ev-${type}-fields`);
    if (!checkbox || !fields) return;
    fields.classList.toggle('hidden', checkbox.checked);
}

// ---- イベント削除（ウィザード内から） ----
function deleteFromEvWizard() {
    if (!editingEventId) return;
    const id = editingEventId;
    closeEventWizard();
    _wzHost().confirmDelete(id);
}

// Temporary storage for the event currently being created or edited in the modal
let tempNewEvent = null;

// 日付変更時に期限表示を即時更新する（期限は自動計算のみ・表示専用スパン）。
// 実際の保存値は saveEventFromWizard / saveQuickCreate で確定する。
// 許可願の期限が既に過ぎている場合は赤字で警告する。
function updateDeadlines(dateInput) {
    const newDate = dateInput.value;
    const cat = (tempNewEvent && tempNewEvent.Category) || 'normal';
    const isMeeting = cat === 'general' || cat === 'admin';
    const calc = isMeeting ? { kyoka: '', houkoku: '' } : calculateDeadlines(newDate);
    const kyokaPast = !!calc.kyoka && calc.kyoka < todayISO();

    // 編集ウィザード（Step 4 の期限表示）
    const wzKyoka = document.getElementById('wz-ev-kyoka-dl');
    const wzHoukoku = document.getElementById('wz-ev-houkoku-dl');
    if (wzKyoka) {
        wzKyoka.textContent = calc.kyoka || '---';
        wzKyoka.classList.toggle('deadline-past', kyokaPast);
        wzKyoka.title = kyokaPast ? '許可願の期限が既に過ぎています' : '';
    }
    if (wzHoukoku) wzHoukoku.textContent = calc.houkoku || '---';

    // クイック作成（日付の下の期限メモ）
    const qcNote = document.getElementById('qc-deadline-note');
    if (qcNote) {
        if (isMeeting || !newDate) {
            qcNote.innerHTML = '';
        } else {
            qcNote.innerHTML = `書類期限（自動計算）: 許可願 <strong class="${kyokaPast ? 'deadline-past' : ''}">${escapeHtml(calc.kyoka)}</strong> ／ 報告書 ${escapeHtml(calc.houkoku)}`
                + (kyokaPast ? '<br><span class="deadline-past">開催日まで10日を切っています。許可願を至急提出してください。</span>' : '');
        }
    }
}

function calculateDeadlines(dateStr) {
    if (!dateStr) return { kyoka: '', houkoku: '' };

    const eventDate = parseISODate(dateStr); // タイムゾーン安全
    const rules = CONFIG.DEADLINE_RULES;

    const kyokaDate = new Date(eventDate);
    kyokaDate.setDate(eventDate.getDate() + rules.kyoka); // 既定: -10日

    const houkokuDate = new Date(eventDate);
    houkokuDate.setDate(eventDate.getDate() + rules.houkoku); // 既定: +7日

    return {
        kyoka: toISODate(kyokaDate),
        houkoku: toISODate(houkokuDate)
    };
}
