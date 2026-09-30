/**
 * イベントの新規項目（企画担当者・荷物運搬方法・書類ファイル）のうち、
 * 追加ダイアログ（script.js）と編集ウィザード（event-wizard.js）で共用する部品。
 * event-wizard.js の後に読み込むこと（タグ入力・アップロード処理を使う）。
 *
 * 詳細ページ（event-series.js）でのアップロード・表示は、そちらのファイルにある。
 */

// 荷物運搬方法の選択肢。車を使うもの（運転者・同乗者の欄を出す）は TRANSPORT_WITH_CAR。
const TRANSPORT_OPTIONS = ['レンタカー', '学用車', '配送', 'その他'];
const TRANSPORT_WITH_CAR = ['レンタカー', '学用車'];
// 学用車を運転できるのは教職員（アドバイザー・コーディネーター）だけ
const TRANSPORT_SCHOOL_CAR = '学用車';

// ---- 荷物運搬方法（編集ウィザード） ----

function initTransportInputs(e, splitNames) {
    const sel = document.getElementById('wz-ev-transport');
    if (!sel) return;
    const driver = initTagInput(document.getElementById('wz-ev-driver'), splitNames(e.TransportDriver), '運転者を検索...');
    initTagInput(document.getElementById('wz-ev-passenger'), splitNames(e.TransportPassengers), '同乗者を検索...');
    const hint = document.getElementById('wz-ev-driver-hint');

    // 学用車のときだけ運転者の候補と入力を教職員に限る。userChanged: 利用者が方法を切り替えたとき。
    const applyMethod = (userChanged) => {
        const withCar = TRANSPORT_WITH_CAR.includes(sel.value);
        document.getElementById('wz-ev-car-fields').classList.toggle('hidden', !withCar);
        const school = sel.value === TRANSPORT_SCHOOL_CAR;
        driver.setFilter(school ? isStaffMember : null, school);
        if (hint) hint.textContent = school ? '（学用車は教職員のみ）' : '';
        // メンバー一覧が読めていない間は判定できないので、外すのは切り替えたときだけ
        if (school && userChanged && getActiveMembers().length > 0) {
            const staff = new Set(getActiveMembers().filter(isStaffMember).map(m => m.Name));
            const current = driver.getValues();
            const kept = current.filter(n => staff.has(n));
            if (kept.length !== current.length) {
                driver.setValues(kept);
                toast('学用車の運転者は教職員のみです。教職員以外を外しました', 'error', 4000);
            }
        }
    };
    sel.addEventListener('change', () => applyMethod(true));
    applyMethod(false);
}

// ---- ファイル欄（追加ダイアログ・編集ウィザード用） ----
// 選ぶとすぐアップロードし、tempNewEvent[field] に入れる（保存はダイアログの保存ボタン）。
// アップロード・取り消しの後始末は wzUploadFiles / removeEventFile / closeEventWizard が面倒を見る。

function initFileField(containerId, field, multiple) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = `
        <button type="button" class="btn btn-secondary btn-sm" data-ef-pick>${multiple ? 'ファイルを追加' : 'ファイルを選ぶ（1ファイル）'}</button>
        <input type="file" style="display:none;"${multiple ? ' multiple' : ''}>
        <div class="file-list-edit" style="margin-top:6px;"></div>`;
    const input = box.querySelector('input[type="file"]');
    const list = box.querySelector('.file-list-edit');

    const refresh = () => {
        const files = (tempNewEvent && Array.isArray(tempNewEvent[field])) ? tempNewEvent[field] : [];
        list.innerHTML = files.map((f, i) => {
            const url = safeHttpUrl(f.url);
            const state = f._uploading ? ' (アップロード中...)' : (f._failed ? ' (アップロード失敗)' : '');
            const cls = f._uploading ? ' uploading' : (f._failed ? ' upload-failed' : '');
            return `
            <div class="file-item${cls}">
                <span class="file-name">${escapeHtml(f.name || ('ファイル ' + (i + 1)))}${state}</span>
                <span class="file-size">${f.size ? formatFileSize(f.size) : ''}</span>
                <div class="file-actions">
                    ${!f._uploading && !f._failed && url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="tbl-btn">開く</a>` : ''}
                    <button type="button" class="tbl-btn tbl-btn-danger" data-ef-remove="${i}">${f._uploading ? 'キャンセル' : '外す'}</button>
                </div>
            </div>`;
        }).join('');
    };

    box.querySelector('[data-ef-pick]').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        wzUploadFiles(Array.from(input.files), field, refresh, !multiple);
        input.value = '';
    });
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ef-remove]');
        if (btn) removeEventFile(tempNewEvent, field, Number(btn.dataset.efRemove), refresh);
    });
    refresh();
}
