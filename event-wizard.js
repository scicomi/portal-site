/**
 * イベント編集ウィザード（共通モジュール）
 *
 * events.html と event-series.html の両方から読み込む（config.js / api.js / app.js の後、
 * 各ページスクリプトの前）。含まれるもの:
 *   - 日付レンジピッカー・タグ入力・実験行などの入力部品
 *   - 既存イベントの編集・複製ウィザード（openEventWizard 一式）
 *   - 書類期限の自動計算（calculateDeadlines / updateDeadlines）
 *   - 削除と「元に戻す」（deleteEventWithUndo）
 *
 * イベントはどのページでもサーバー形（worker/src/tables.js の events.columns の列名）で扱う。
 * ページ固有のデータ配列・再描画は、各ページが configureEventWizard で渡す。
 */

let holidaysData = {};

// 実験マスタ（populateDatalists で取得）。実験名のタイポで振り返りが
// 別レコードに紐づかないよう、ウィザードでは実在する名前しか保存できない。
let experimentsList = [];
let experimentsMasterWarned = false; // マスタ未取得の警告をウィザード 1 回につき 1 度だけ出す

// ---- ホスト連携 ----
// ウィザードが触るページ側データ（取得・楽観更新・確定・巻き戻し・削除）は、各ページが渡す設定経由にする。
//   list():          そのページのイベント配列（再読込で配列ごと差し替わるので、毎回関数で受け取る）
//   rerender():      一覧・詳細の再描画
//   onConflict():    競合時の再読込
//   onDeleted(id):   （任意）削除がサーバーで確定した後の処理。false を返すと「元に戻す」を出さない
let _wzHostConfig = null;

function configureEventWizard(config) {
    _wzHostConfig = config;
}

function _wzHost() {
    const c = _wzHostConfig;
    if (!c) throw new Error('configureEventWizard が呼ばれていません');
    const list = () => c.list();
    const persist = () => api.saveCache('events', list());
    return {
        getEvent(id) { return list().find(x => x.ID === id) || null; },
        snapshot() { return JSON.parse(JSON.stringify(list())); },
        applyOptimistic(item) {
            const arr = list();
            const idx = arr.findIndex(x => x.ID === item.ID);
            if (idx > -1) arr[idx] = item; else arr.unshift(item);
            persist();
            c.rerender();
        },
        commitSaved(saved) {
            const arr = list();
            const idx = arr.findIndex(x => x.ID === saved.ID);
            if (idx < 0) return;
            arr[idx] = saved;
            persist();
            c.rerender();
        },
        rollback(snap) {
            const arr = list();
            arr.splice(0, arr.length, ...snap);
            persist();
            c.rerender();
        },
        onConflict() { c.onConflict(); }
    };
}

// ---- ウィザード定義 ----
let evWizardStep = 0;
let editingEventId = null;
let evWizardCategory = 'normal';

// 詳細ページの表のグループ（イベント / 日程 / 荷物運搬 / 内容・メンバー / 備考・書類）と同じ並び・同じ区切りにする
const EV_STEPS_EVENT = [
    { label: 'イベント' },
    { label: '日程' },
    { label: '荷物運搬' },
    { label: '内容・メンバー' },
    { label: '備考・書類' }
];
const EV_STEPS_MEETING = [
    { label: '基本情報' },
    { label: '日時' },
    { label: 'その他' }
];

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
// 開始日→終了日の順にクリックすると hidden の Date / DateEnd に反映される。
function initDateRangePicker(card) {
    const wrapper = card.querySelector('.date-range-picker-wrapper');
    if (!wrapper) return;
    const display = wrapper.querySelector('.date-range-display');
    const startInput = wrapper.querySelector('[data-field="Date"]');
    const endInput = wrapper.querySelector('[data-field="DateEnd"]');
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

// opts.strict: true なら候補にないメンバーの自由入力（Enter）を受け付けない。
// opts.onChange: 利用者が値を追加・削除したとき（setValues 以外）に、新しい値の配列を渡して呼ぶ。
// 戻り値の setFilter(fn, strict) で、あとから候補の絞り込みを切り替えられる。
function initTagInput(container, selectedValues, placeholder, filterFn, opts) {
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
    let curFilter = filterFn;
    let strict = !!(opts && opts.strict);
    const notifyChange = () => { if (opts && opts.onChange) opts.onChange([...values]); };

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
        const members = curFilter ? getActiveMembers().filter(curFilter) : getActiveMembers();
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
        if (val && strict) {
            const allowed = (curFilter ? getActiveMembers().filter(curFilter) : getActiveMembers()).some(m => m.Name === val);
            if (!allowed) { toast('候補から選んでください', 'error', 2500); input.value = ''; hideDropdown(); return; }
        }
        if (val && !values.includes(val)) { values.push(val); renderTags(); notifyChange(); }
        input.value = '';
        hideDropdown();
    }

    input.addEventListener('focus', showDropdown);
    input.addEventListener('input', showDropdown);
    input.addEventListener('blur', () => setTimeout(hideDropdown, 200));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) addValue(input.value); }
        if (e.key === 'Backspace' && !input.value && values.length > 0) { values.pop(); renderTags(); notifyChange(); showDropdown(); }
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
            notifyChange();
            return;
        }
        input.focus();
    });

    renderTags();
    container._tagInput = {
        getValues: () => [...values],
        setValues: (vals) => { values = [...vals]; renderTags(); },
        setFilter: (fn, strictFlag) => { curFilter = fn; strict = !!strictFlag; }
    };
    return container._tagInput;
}

// ---- Files の正規化 ----
// 古いデータには URL 文字列だけの要素があるため、ウィザードで扱う { name, url, ... } にそろえる（コピーを返す）。
function normalizeEventFiles(files) {
    return (Array.isArray(files) ? files : []).map(f => typeof f === 'string' ? { name: '', url: f } : f);
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

function genTimeOpts(startH, endH, withEmpty) {
    let html = withEmpty ? '<option value="">--</option>' : '';
    for (let h = startH; h <= endH; h++) {
        for (let m = 0; m < 60; m += 30) {
            if (h === endH && m > 0) break;
            const v = formatTimeHM(h, m);
            html += `<option value="${v}">${v}</option>`;
        }
    }
    return html;
}

// ---- ウィザード・クイック作成の入力部品（HTML） ----

// 日付レンジピッカー（initDateRangePicker で駆動する）。idPrefix を渡すと各 input に id を付ける。
function dateRangePickerHtml(date, dateEnd, idPrefix) {
    const id = suffix => idPrefix ? ` id="${idPrefix}-${suffix}"` : '';
    return `
                    <div class="date-range-picker-wrapper">
                        <input type="text" class="e1-input date-range-display"${id('date-display')} readonly placeholder="クリックして日にちを選択">
                        <input type="hidden"${id('date')} data-field="Date" value="${escapeAttr(date || '')}">
                        <input type="hidden"${id('date-end')} data-field="DateEnd" value="${escapeAttr(dateEnd || '')}">
                        <div class="date-range-popup hidden"></div>
                    </div>`;
}

// 開始・終了の時間セレクト（値は描画後に設定する。読み取りは readTimeRange）
function timeRangeSelectHtml(startId, endId) {
    return `
                    <div class="time-select-group">
                        <select class="e1-input" id="${startId}">${genTimeOpts(7, 21, true)}</select>
                        <span>〜</span>
                        <select class="e1-input" id="${endId}">${genTimeOpts(7, 21, true)}</select>
                    </div>`;
}

function voteDeadlineInputHtml(value) {
    return `
                <div class="e1-group">
                    <label class="e1-label">出欠回答の締切（任意）</label>
                    <input type="date" id="wz-ev-vote-deadline" class="e1-input" value="${escapeAttr(value || '')}">
                    <span class="text-muted" style="font-size:0.8rem;">未設定なら最終日まで回答できます。締切後の変更は管理者のみ。</span>
                </div>`;
}

// 許可願／報告書の「不要」チェック・担当者・自動計算の期限（type: 'kyoka' | 'houkoku'）
function docDeadlineFieldHtml(type, e) {
    const isKyoka = type === 'kyoka';
    const notRequired = isKyoka ? e.KyokaNotRequired : e.HoukokuNotRequired;
    const deadline = isKyoka ? e.KyokaDeadline : e.HoukokuDeadline;
    const name = isKyoka ? '許可願' : '報告書';
    return `
                        <div>
                            <label class="text-label doc-not-required-toggle">
                                <input type="checkbox" id="wz-ev-${type}-not-required" ${notRequired ? 'checked' : ''} onchange="onDocNotRequiredToggle('${type}')">
                                ${name}は不要
                            </label>
                            <div id="wz-ev-${type}-fields" class="${notRequired ? 'hidden' : ''}">
                                <label class="text-label" style="font-size:0.85rem; display:block; margin-bottom:4px;">${name} (担当)</label>
                                <div id="wz-ev-admin-${type}"></div>
                                <span class="text-muted" style="font-size:0.8rem;">期限: <span id="wz-ev-${type}-dl">${escapeHtml(deadline || '---')}</span></span>
                            </div>
                        </div>`;
}

function wizardStepHtml(index, steps, inner) {
    return `
            <div class="wizard-step${index === 0 ? ' active' : ''}" data-step="${index}">
                <div class="wizard-step-label">Step ${index + 1} / ${steps.length} &mdash; ${steps[index].label}</div>${inner}
            </div>`;
}

function categoryBadgeHtml(catInfo) {
    return `
                <div style="margin-bottom:12px;"><span class="cat-badge" style="background:${catInfo.bg};color:${catInfo.text};">${catInfo.short}</span></div>`;
}

function meetingWizardStepsHtml(e, steps, catInfo) {
    return wizardStepHtml(0, steps, categoryBadgeHtml(catInfo) + `
                <div class="flex-row">
                    <div class="e1-group" style="flex:0 0 100px;">
                        <label class="e1-label">回数</label>
                        <input id="wz-ev-meeting-num" class="e1-input" type="number" placeholder="3" value="${escapeAttr(e.MeetingNumber || '')}">
                    </div>
                    <div class="e1-group" style="flex:1;">
                        <label class="e1-label">ミーティング名</label>
                        <input id="wz-ev-title" class="e1-input" type="text" placeholder="例: イベント振り返り" value="${escapeAttr(e.Title || '')}">
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">場所</label>
                    <input id="wz-ev-location" class="e1-input" type="text" placeholder="例: 学生会館3F" value="${escapeAttr(e.Location || '')}">
                </div>`)
        + wizardStepHtml(1, steps, `
                <div class="e1-group">
                    <label class="e1-label">日にち</label>${dateRangePickerHtml(e.Date, e.DateEnd, 'wz-ev')}
                </div>
                <div class="e1-group">
                    <label class="e1-label">ミーティング時間（未定なら空欄のまま）</label>${timeRangeSelectHtml('wz-ev-time-start', 'wz-ev-time-end')}
                </div>${voteDeadlineInputHtml(e.VoteDeadline)}`)
        + wizardStepHtml(2, steps, `
                <div class="e1-group">
                    <label class="e1-label">議題</label>
                    <textarea id="wz-ev-remarks" class="e1-input" rows="6" placeholder="例: 1. 前回イベントの振り返り&#10;2. 次回企画の担当決め&#10;3. 連絡事項">${escapeHtml(e.Remarks || '')}</textarea>
                </div>
                <div class="e1-group">
                    <label class="e1-label">関連資料</label>
                    <div id="wz-ev-meeting-docs"></div>
                </div>`);
}

function eventWizardStepsHtml(e, steps, catInfo) {
    return wizardStepHtml(0, steps, categoryBadgeHtml(catInfo) + `
                <div class="e1-group">
                    <label class="e1-label">イベント名 *</label>
                    <input id="wz-ev-title" class="e1-input" type="text" placeholder="例: サイエンスフェスタ" value="${escapeAttr(e.Title || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">企画名</label>
                    <input id="wz-ev-planname" class="e1-input" type="text" placeholder="例: 夏休み科学教室" value="${escapeAttr(e.PlanName || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">企画担当者</label>
                    <div id="wz-ev-planleader"></div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">場所</label>
                    <input id="wz-ev-location" class="e1-input" type="text" placeholder="例: ○○公民館" value="${escapeAttr(e.Location || '')}">
                </div>
                <div class="e1-group">
                    <label class="e1-label">対象者・人数</label>
                    <input id="wz-ev-audience" class="e1-input" type="text" placeholder="例: 小学1〜3年生 40名" value="${escapeAttr(e.Audience || '')}">
                </div>`)
        + wizardStepHtml(1, steps, `
                <div class="e1-group">
                    <label class="e1-label">日にち</label>${dateRangePickerHtml(e.Date, e.DateEnd, 'wz-ev')}
                </div>
                <div class="e1-group">
                    <label class="e1-label">イベント時間（未定なら空欄のまま）</label>${timeRangeSelectHtml('wz-ev-time-start', 'wz-ev-time-end')}
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
                </div>${voteDeadlineInputHtml(e.VoteDeadline)}`)
        + wizardStepHtml(2, steps, `
                <div class="e1-group">
                    <label class="e1-label">帯同（コーディネーター・アドバイザー）</label>
                    <div id="wz-ev-accompany"></div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">荷物運搬方法</label>
                    <select class="e1-input" id="wz-ev-transport">
                        <option value="">選択してください</option>
                        ${TRANSPORT_OPTIONS.map(o => `<option value="${o}"${o === e.TransportMethod ? ' selected' : ''}>${o}</option>`).join('')}
                    </select>
                </div>
                <div id="wz-ev-car-fields" class="${TRANSPORT_WITH_CAR.includes(e.TransportMethod) ? '' : 'hidden'}">
                    <div class="e1-group">
                        <label class="e1-label">運転者を選択<span id="wz-ev-driver-hint" class="text-muted" style="font-size:0.8rem;"></span></label>
                        <label id="wz-ev-driver-same-wrap" class="text-label doc-not-required-toggle hidden">
                            <input type="checkbox" id="wz-ev-driver-same" ${driverSameChecked(e) ? 'checked' : ''}>
                            運転者は帯同と同じ
                        </label>
                        <div id="wz-ev-driver"></div>
                    </div>
                    <div class="e1-group">
                        <label class="e1-label">同乗者を選択</label>
                        <div id="wz-ev-passenger"></div>
                    </div>
                </div>`)
        + wizardStepHtml(3, steps, `
                <div class="e1-group">
                    <label class="e1-label">実験内容・発表者</label>
                    <div id="wz-ev-exp-container" class="experiments-container"></div>
                    <button class="btn-add-exp" onclick="addWzEvExpRow()" type="button">＋ 実験を追加</button>
                </div>
`)
        + wizardStepHtml(4, steps, `
                <div class="e1-group">
                    <label class="e1-label">備考</label>
                    <textarea id="wz-ev-remarks" class="e1-input" rows="5" placeholder="スケジュール・運搬の段取り、その他メモ">${escapeHtml(e.Remarks || '')}</textarea>
                </div>
                <div class="e1-group">
                    <label class="e1-label">関連ファイル</label>
                    <div class="file-upload-area">
                        <div class="file-drop-zone" id="wz-ev-drop-zone">
                            <p style="margin:0; font-weight:bold;">ファイルをここにドラッグ＆ドロップ</p>
                            <p style="margin:5px 0 0 0; font-size:0.85rem;">またはクリックして選択 (上限 ${getFileMaxMB()}MB/ファイル)</p>
                        </div>
                        <input type="file" id="wz-ev-file-input" multiple style="display:none;">
                        <div id="wz-ev-file-list" class="file-list-edit"></div>
                    </div>
                </div>
                <div class="e1-group">
                    <label class="e1-label">書類期限（日付は自動計算されます）</label>
                    <div class="deadline-grid">${docDeadlineFieldHtml('kyoka', e)}${docDeadlineFieldHtml('houkoku', e)}
                    </div>
                </div>`);
}

// ---- イベント ウィザード（既存イベントの編集・複製） ----

// 編集なら既存イベントのコピー、複製なら回ごとの値を空にしたテンプレートのコピーを返す（対象が無ければ null）
function eventForWizard(editId, template) {
    if (editId) {
        const existing = _wzHost().getEvent(editId);
        return existing ? { ...existing, Files: normalizeEventFiles(existing.Files) } : null;
    }
    if (!template) return null;
    return {
        ...template,
        ID: genId('ev_'),
        Date: todayISO(), DateEnd: '',
        MeetingNumber: '',
        Files: [],
        KyokaDeadline: '', HoukokuDeadline: '',
        VoteDeadline: '',   // 出欠締切は元イベントの日付なので引き継がない
        ReportStatus: '', KyokaStatus: '',
        Positives: '', Reflections: '', ResultsMemo: '',
        // 実施後の記録(来場者数・参加人数・広報担当)は回ごとの値なので引き継がない。郵便番号は会場情報として引き継ぐ
        VisitorCount: '', ParticipantCount: '', PrAssignments: '',
        // 企画担当者・運搬・書類ファイルも回ごとの値なので引き継がない
        PlanLeader: '', TransportMethod: '', TransportDriver: '', TransportPassengers: '',
        RequestDoc: [], KyokaDoc: [], HoukokuDoc: [], MeetingDocs: [], Minutes: [],
        UpdatedAt: '', CreatedAt: ''
    };
}

// editId のみ: 既存イベントの編集。template のみ（editId 無し）: 複製して新規作成
// （この場合だけは、クイック作成の「枠だけ」ではなく実験・担当などの詳細もこの場で全て入力する）。
// 真っさらな新規作成はクイック作成（openQuickCreate）に一本化した。
// focusId: 開いた直後に、その入力欄があるステップへ移って入力欄にフォーカスする（詳細の「—」から直行する用）
function openEventWizard(editId, template, focusId) {
    const e = eventForWizard(editId, template);
    if (!e) return;
    const isEdit = !!editId;
    editingEventId = editId || null;
    evWizardStep = 0;
    evWizardCategory = e.Category || 'normal';

    tempNewEvent = e;
    experimentsMasterWarned = false;
    e._sessionUploads = []; // このウィザードでアップロードした R2 ファイルの driveId（保存せず閉じたら消す）

    const isMeeting = isMeetingCategory(evWizardCategory);
    const steps = isMeeting ? EV_STEPS_MEETING : EV_STEPS_EVENT;
    const catInfo = getEventCategory(evWizardCategory);
    const stepsHtml = isMeeting ? meetingWizardStepsHtml(e, steps, catInfo) : eventWizardStepsHtml(e, steps, catInfo);

    const overlay = document.createElement('div');
    overlay.id = 'ev-wizard-overlay';
    overlay.className = 'wizard-overlay';
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
                ${isEdit && api.isAdmin() ? '<button class="btn btn-danger" onclick="deleteFromEvWizard()">削除</button>' : ''}
                <div class="wizard-footer-spacer"></div>
                <button class="btn btn-text" onclick="closeEventWizard()">キャンセル</button>
                <button id="wz-ev-prev" class="btn btn-secondary" onclick="evWizardPrev()" style="display:none;">戻る</button>
                <button id="wz-ev-next" class="btn btn-primary" onclick="evWizardNext()">次へ</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    trapFocus(overlay.querySelector('.wizard-panel'));
    initEventWizardInputs(overlay, e, isMeeting);

    // 領域外クリック・Esc は、入力に変更があれば破棄確認を挟む（誤タップで編集内容が消えないように）。
    // 初期値の流し込み（時間セレクト・日付ピッカー・タグ入力）が終わった後に呼ぶこと。
    bindEditDismissGuard(overlay, closeEventWizard);

    setTimeout(() => {
        const firstInput = overlay.querySelector('.wizard-step.active input:not([type="hidden"]), .wizard-step.active textarea, .wizard-step.active select');
        if (firstInput) firstInput.focus();
    }, 80);
    if (focusId) setTimeout(() => focusEvWizardField(overlay, focusId), 160);
}

function focusEvWizardField(overlay, focusId) {
    let el = document.getElementById(focusId);
    // 運転者・同乗者は運搬方法が車のときだけ表示される。隠れているときは運搬方法の欄へ
    if (el && el.closest('.hidden')) el = document.getElementById('wz-ev-transport');
    if (!el) return;
    const stepEl = el.closest('.wizard-step');
    if (stepEl) {
        evWizardStep = parseInt(stepEl.dataset.step) || 0;
        updateEvWizardUI();
    }
    const target = el.matches('input, textarea, select, button') ? el : el.querySelector('input, textarea, select, button');
    if (target) target.focus();
    (target || el).scrollIntoView({ block: 'center' });
}

// 描画後に、セレクトの値・日付ピッカー・実験行・タグ入力・ファイル欄を初期化する
function initEventWizardInputs(overlay, e, isMeeting) {
    // 時間未定のイベントに架空の時間を入れない（空欄 = 未定のまま保存できる）
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    setVal('wz-ev-time-start', e.TimeStart);
    setVal('wz-ev-time-end', e.TimeEnd);
    initDateRangePicker(overlay);
    if (isMeeting) {
        initFileField('wz-ev-meeting-docs', 'MeetingDocs', true);
        return;
    }

    setVal('wz-ev-gather', e.GatherTime);
    setVal('wz-ev-dismiss', e.DismissTime);

    const expContainer = document.getElementById('wz-ev-exp-container');
    parsePartsList(e.PartsList).forEach(item => {
        expContainer.appendChild(buildExperimentRow(item.name, item.presenters));
    });

    const splitNames = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
    initTagInput(document.getElementById('wz-ev-accompany'), splitNames(e.Accompany), 'コーディネーター・アドバイザーを検索...', isStaffMember,
        { onChange: () => { if (wzSyncDriver) wzSyncDriver(); } });
    initTagInput(document.getElementById('wz-ev-planleader'), splitNames(e.PlanLeader), '企画担当者を検索...', isRegularMember);
    initTransportInputs(e, splitNames);
    initTagInput(document.getElementById('wz-ev-admin-kyoka'), splitNames(e.AdminKyoka), '担当者を検索...', isRegularMember);
    initTagInput(document.getElementById('wz-ev-admin-houkoku'), splitNames(e.AdminHoukoku), '担当者を検索...', isRegularMember);

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
    wzRefreshFileList();
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
    const isMeeting = isMeetingCategory(evWizardCategory);
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
    const isMeeting = isMeetingCategory(evWizardCategory);
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
    const isMeeting = isMeetingCategory(evWizardCategory);
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

    // 内容・メンバー（実験）ステップから先へ進む前に、実験名が実在するか確認する
    if (evWizardStep === 3 && !isMeeting) {
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
// field: イベントの列名（既定は関連ファイル）。single: true なら 1 ファイルだけ持つ（選び直すと差し替える）。
async function wzUploadFiles(fileList, field = 'Files', refresh = wzRefreshFileList, single = false) {
    // 開始時の対象を握る。完了時に tempNewEvent が別物（閉じた・別イベントに切替）なら結果を捨てる。
    const target = tempNewEvent;
    if (!target) return;
    const maxSizeMB = getFileMaxMB();
    if (single) {
        fileList = fileList.slice(0, 1);
        if (fileList.length) removeEventFile(target, field, 0, refresh);   // 選び直しは差し替え
    }
    for (const file of fileList) {
        if (tempNewEvent !== target) return;
        if (file.size > maxSizeMB * 1024 * 1024) {
            toast(`「${file.name}」はサイズ上限(${maxSizeMB}MB)を超えています`, 'error');
            continue;
        }
        if (!Array.isArray(target[field])) target[field] = [];
        if (!Array.isArray(target._sessionUploads)) target._sessionUploads = [];

        const placeholder = { name: file.name, size: file.size, _uploading: true };
        target[field].push(placeholder);
        refresh();

        try {
            const result = await api.uploadFile(file);
            const idx = target[field].indexOf(placeholder);
            if (tempNewEvent !== target || idx < 0) {
                // ウィザードが閉じた／切り替わった、またはキャンセル済み → 一覧に戻さず、アップロード済みの実体を消す
                discardUploadedFile(result && result.driveId);
                continue;
            }
            target[field][idx] = result;
            if (result && result.driveId) target._sessionUploads.push(result.driveId);
            toast(`「${file.name}」をアップロードしました`, 'success', 2000);
        } catch (err) {
            if (tempNewEvent !== target) return;
            const idx = target[field].indexOf(placeholder);
            if (idx < 0) continue; // キャンセル済み。失敗を表示しない
            toast(`「${file.name}」のアップロード失敗: ${err.message}`, 'error');
            target[field][idx] = { name: file.name, size: file.size, _failed: true };
        }
        refresh();
    }
}

// ウィザード内ボタンの委譲先（onclick 属性にインデックス等を埋め込まない。app.js の registerActions 参照）
registerActions({
    'ew-goto': el => evWizardGoto(Number(el.dataset.dot)),
    'ew-remove-file': el => wzRemoveFile(Number(el.dataset.index))
});

function wzRemoveFile(index) {
    removeEventFile(tempNewEvent, 'Files', index, wzRefreshFileList);
}

// target[field] の index 番目のファイルを外す。
// このダイアログでアップロードしたばかりのファイルはその場で実体も消し、保存済みのものは保存成功後に消す。
function removeEventFile(target, field, index, refresh) {
    if (!target || !Array.isArray(target[field])) return;
    const file = target[field][index];
    if (!file) return;
    if (file.driveId) {
        const si = Array.isArray(target._sessionUploads) ? target._sessionUploads.indexOf(file.driveId) : -1;
        if (si >= 0) {
            target._sessionUploads.splice(si, 1);
            discardUploadedFile(file.driveId);
        } else {
            if (!Array.isArray(target._filesToDelete)) target._filesToDelete = [];
            target._filesToDelete.push(file.driveId);
        }
    }
    target[field].splice(index, 1);
    refresh();
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

// ---- ウィザードから保存（検証 → 組み立て → 保存） ----
function saveEventFromWizard() {
    if (!tempNewEvent) return;
    const checked = validateEventWizard();
    if (!checked) return;
    persistEventFromWizard(buildEventFromWizard(checked.time));
}

// 入力を検証する。問題があれば該当ステップへ移ってエラーを表示し、null を返す。
// ドットで直接最終ステップへ来られるため、各ステップの必須チェックを保存時にもやり直す。
function validateEventWizard() {
    const isMeeting = isMeetingCategory(evWizardCategory);
    const title = (document.getElementById('wz-ev-title')?.value || '').trim();
    if (!title) {
        toast(isMeeting ? 'ミーティング名を入力してください' : 'イベント名を入力してください', 'error');
        evWizardGoto(0);
        return null;
    }
    const time = readTimeRange('wz-ev-time-start', 'wz-ev-time-end');
    if (!time) {
        evWizardGoto(1);
        return null;
    }
    if (!isMeeting) {
        const badExps = invalidExperimentNames();
        if (badExps.length > 0) {
            evWizardGoto(2);
            toastInvalidExperiment(badExps);
            return null;
        }
    }
    if (['Files', 'MeetingDocs'].some(k => Array.isArray(tempNewEvent[k]) && tempNewEvent[k].some(f => f._uploading))) {
        toast('ファイルのアップロードが完了するまでお待ちください', 'error');
        return null;
    }
    return { time };
}

// フォームの値を tempNewEvent に重ねて、保存するイベント（サーバー形）を作る。
// ウィザードに欄が無い列（来場者数・広報担当など）は tempNewEvent の値をそのまま引き継ぐ。
function buildEventFromWizard(time) {
    const val = id => document.getElementById(id)?.value || '';
    const tags = id => {
        const el = document.getElementById(id);
        return el?._tagInput ? el._tagInput.getValues().join(', ') : null;
    };
    const isMeeting = isMeetingCategory(evWizardCategory);
    const item = { ...tempNewEvent };
    delete item._filesToDelete;
    delete item._sessionUploads;

    item.Category = evWizardCategory;
    item.Title = val('wz-ev-title').trim();
    item.Location = val('wz-ev-location').trim();
    const planNameEl = document.getElementById('wz-ev-planname');
    if (planNameEl) item.PlanName = planNameEl.value.trim();
    item.Date = val('wz-ev-date');
    item.DateEnd = val('wz-ev-date-end');
    item.TimeStart = time.start;
    item.TimeEnd = time.end;
    item.Remarks = val('wz-ev-remarks');
    // 出欠回答の締切（任意）。欄が無ければ既存値を保持する。
    if (document.getElementById('wz-ev-vote-deadline')) item.VoteDeadline = val('wz-ev-vote-deadline');
    item.Files = (Array.isArray(item.Files) ? item.Files : []).filter(f => !f._failed);
    item.MeetingDocs = (Array.isArray(item.MeetingDocs) ? item.MeetingDocs : []).filter(f => !f._failed);

    if (isMeeting) {
        item.MeetingNumber = val('wz-ev-meeting-num');
        item.KyokaDeadline = '';
        item.HoukokuDeadline = '';
        return item;
    }

    item.Audience = val('wz-ev-audience').trim();
    item.GatherTime = val('wz-ev-gather');
    item.DismissTime = val('wz-ev-dismiss');
    const planLeader = tags('wz-ev-planleader');
    if (planLeader !== null) item.PlanLeader = planLeader;
    item.TransportMethod = val('wz-ev-transport');
    const withCar = TRANSPORT_WITH_CAR.includes(item.TransportMethod);   // 車を使わない方法なら運転者・同乗者は持たせない
    const driverSame = withCar && item.TransportMethod === TRANSPORT_SCHOOL_CAR && document.getElementById('wz-ev-driver-same')?.checked;
    item.TransportDriver = withCar ? (driverSame ? (tags('wz-ev-accompany') || '') : (tags('wz-ev-driver') || '')) : '';
    item.TransportPassengers = withCar ? (tags('wz-ev-passenger') || '') : '';

    const expContainer = document.getElementById('wz-ev-exp-container');
    if (expContainer) {
        const collected = [];
        expContainer.querySelectorAll('.experiment-row').forEach(row => {
            const name = (row.querySelector('.experiment-name')?.value || '').trim();
            const tagContainer = row.querySelector('.presenter-tag-container');
            const presenters = tagContainer?._tagInput ? tagContainer._tagInput.getValues() : [];
            if (name || presenters.length > 0) collected.push({ name, presenters });
        });
        item.PartsList = collected;
    }

    // 書類が不要な場合は担当者・期限を持たせない（非表示のタグ入力に値が残っていても採用しない。チェックを外せばまた計算に戻る）
    item.KyokaNotRequired = document.getElementById('wz-ev-kyoka-not-required')?.checked ? 'true' : '';
    item.HoukokuNotRequired = document.getElementById('wz-ev-houkoku-not-required')?.checked ? 'true' : '';
    const accompany = tags('wz-ev-accompany');
    if (accompany !== null) item.Accompany = accompany;
    const kyoka = tags('wz-ev-admin-kyoka');
    const houkoku = tags('wz-ev-admin-houkoku');
    if (item.KyokaNotRequired) item.AdminKyoka = ''; else if (kyoka !== null) item.AdminKyoka = kyoka;
    if (item.HoukokuNotRequired) item.AdminHoukoku = ''; else if (houkoku !== null) item.AdminHoukoku = houkoku;

    const dl = calculateDeadlines(item.Date);
    item.KyokaDeadline = item.KyokaNotRequired ? '' : dl.kyoka;
    item.HoukokuDeadline = item.HoukokuNotRequired ? '' : dl.houkoku;
    return item;
}

// 画面へ先に反映（楽観更新）してウィザードを閉じ、裏でサーバーへ保存する。失敗したら画面を巻き戻す。
function persistEventFromWizard(item) {
    const host = _wzHost();
    const eventId = item.ID;
    const isExisting = !!host.getEvent(eventId);
    const openedUpdatedAt = tempNewEvent.UpdatedAt || '';
    const filesToDelete = Array.isArray(tempNewEvent._filesToDelete) ? tempNewEvent._filesToDelete.slice() : [];
    // このウィザードでアップロードして、いま一覧に残っているファイル（保存に成功しなければ孤児になる）
    const uploadedNow = Array.isArray(tempNewEvent._sessionUploads) ? tempNewEvent._sessionUploads.slice() : [];
    tempNewEvent._sessionUploads = []; // closeEventWizard がアップロード済みファイルを消さないようにする

    const snapshot = host.snapshot();
    host.applyOptimistic({ ...item });
    closeEventWizard();
    toast('保存しました', 'success');
    warnKyokaOverdue(item);

    // 同じイベントへの保存（詳細ページの個別保存など）が送信中なら、その完了を待ってから送る。
    // 待っている間に自分の保存で UpdatedAt が進んでいたら、それを基準にする（別の人の編集だけを競合とみなす）。
    runEventSaveSerial(eventId, () => {
        if (isExisting) {
            const live = host.getEvent(eventId);
            const liveStamp = live && live.UpdatedAt;
            item._baseUpdatedAt = (liveStamp && liveStamp !== openedUpdatedAt && isOwnSavedStamp(eventId, liveStamp))
                ? liveStamp : openedUpdatedAt;
        }
        return api.save('events', item);
    }).then(saved => {
        host.commitSaved(saved);
        if (saved && saved.UpdatedAt) _ownSavedStamps.add(eventId + ':' + saved.UpdatedAt);
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
    confirmDeleteEvent(id);
}

// ---- イベント削除（確認 → 削除 → 「元に戻す」）: events.html / event-series.html 共通 ----
function confirmDeleteEvent(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => confirmDeleteEvent(id));
        return;
    }
    const ev = _wzHost().getEvent(id);
    if (!ev) return;
    showConfirmDialog({
        title: `「${ev.Title || '(無題)'}」を削除`,
        message: 'この操作は元に戻せます（削除直後のみ）。',
        okLabel: '削除する',
        danger: true,
        onOk: () => deleteEventWithUndo(id)
    });
}

// 画面から先に消し、サーバーで削除する。「元に戻す」は削除前のデータをそのまま再保存して元の位置へ戻す。
// 添付ファイルの実体（R2）は、元に戻せる期間が過ぎてから消す（復元した記録のリンクが壊れないように）。
async function deleteEventWithUndo(id) {
    if (!api.isAdmin()) {
        showAdminAuthModal(() => deleteEventWithUndo(id));
        return;
    }
    const c = _wzHostConfig;
    const list = c.list();
    const idx = list.findIndex(e => e.ID === id);
    if (idx < 0) return;
    const backup = list[idx];
    const putBack = item => {
        const cur = c.list();
        if (!cur.some(e => e.ID === item.ID)) cur.splice(Math.min(idx, cur.length), 0, item);
        api.saveCache('events', cur);
        c.rerender();
    };

    list.splice(idx, 1);
    api.saveCache('events', list);
    c.rerender();

    try {
        await api.delete('events', id);
    } catch (err) {
        putBack(backup);
        toast('削除失敗: ' + err.message, 'error');
        return;
    }
    if (c.onDeleted && c.onDeleted(id) === false) return;

    toastUndo(
        `「${backup.Title || '(無題)'}」を削除しました`,
        async () => {
            try {
                putBack(await api.save('events', backup));
                toast('元に戻しました', 'success', 2000);
            } catch (err) {
                toast('復元に失敗しました: ' + err.message, 'error');
            }
        },
        () => deleteStoredFiles(normalizeEventFiles(backup.Files).map(f => f && f.driveId)),
        5000
    );
}

// Temporary storage for the event currently being created or edited in the modal
let tempNewEvent = null;

// ウィザード表示中は Ctrl+S（Mac は Cmd+S）で保存する（どのステップからでも。検証は保存時に全ステップ分行う）
document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
    if (!document.getElementById('ev-wizard-overlay') || !tempNewEvent) return;
    if (document.querySelector('.confirm-dialog-overlay')) return; // 破棄確認などが上に出ているときは何もしない
    e.preventDefault();
    saveEventFromWizard();
});

// 日付変更時に期限表示を即時更新する（期限は自動計算のみ・表示専用スパン）。
// 実際の保存値は saveEventFromWizard / saveQuickCreate で確定する。
// 許可願の期限が既に過ぎている場合は赤字で警告する。
function updateDeadlines(dateInput) {
    const newDate = dateInput.value;
    const cat = (tempNewEvent && tempNewEvent.Category) || 'normal';
    const isMeeting = isMeetingCategory(cat);
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

// 時間セレクトの開始・終了を読む（未定なら両方空欄）。片方だけ・終了が開始以前ならエラーを表示して null を返す。
function readTimeRange(startId, endId) {
    const ts = document.getElementById(startId)?.value || '';
    const te = document.getElementById(endId)?.value || '';
    if ((ts && !te) || (!ts && te)) {
        toast('時間は開始と終了の両方を選択してください（未定なら両方空欄）', 'error');
        return null;
    }
    if (ts && te && te <= ts) {
        toast('終了時刻は開始時刻より後にしてください', 'error');
        return null;
    }
    return { start: ts, end: te };
}

// 許可願の期限が過去なのにイベントがまだ先の場合は注意を促す（保存は妨げない）
function warnKyokaOverdue(ev) {
    if (isMeetingCategory(ev.Category) || !ev.KyokaDeadline) return;
    const today = todayISO();
    if (ev.KyokaDeadline < today && (ev.DateEnd || ev.Date) >= today) {
        toast(`許可願の期限（${ev.KyokaDeadline}）を過ぎています。至急対応してください`, 'error', 6000);
    }
}

function calculateDeadlines(dateStr) {
    if (!dateStr) return { kyoka: '', houkoku: '' };

    const rules = CONFIG.DEADLINE_RULES;
    return {
        kyoka: addDaysISO(dateStr, rules.kyoka),       // 既定: -10日
        houkoku: addDaysISO(dateStr, rules.houkoku)    // 既定: +7日
    };
}
