/**
 * ゴミ箱ページ（メンバー全員が閲覧・復元・完全削除できる）
 *
 * 削除したレコード（イベント・メンバー・実験ネタ）と、レコードから外した項目（添付ファイル・写真・動画・
 * 振り返り・セクション）を、サーバーが期限（既定 7 日）まで保管している。期限が来たものはサーバーが完全に削除する。
 * パスワード一覧の分は、管理者トークンがあるときだけサーバーから返る（メンバーには見えない）。
 * 一覧には中身を持ってこない（名前・種類・日時だけ）。
 */

let trashItems = [];
let trashFilter = '';

const TRASH_RESOURCE_LABELS = { events: 'イベント', members: 'メンバー', experiments: '実験ネタ', passwords: 'パスワード' };
const TRASH_FIELD_LABELS = {
    Files: '関連ファイル', RequestDoc: '依頼書', KyokaDoc: '活動許可願', HoukokuDoc: '活動報告書',
    MeetingDocs: '関連資料', Minutes: '議事録',
    Photos: '写真', Videos: '動画', Reflections: '振り返り', Positives: '良かった点', Sections: 'セクション'
};
const TRASH_ERRORS = {
    already_exists: '同じものがすでにあるため戻せません。',
    parent_missing: '元の記録が見つかりません。元の記録もゴミ箱にある場合は、先にそちらを戻してください。',
    slot_occupied: 'すでに別のファイルが入っているため戻せません。入れ替えるには、先に今のファイルを削除してください。',
    conflict: '他の人が同時に編集しました。もう一度お試しください。',
    not_found: 'すでに戻された、または完全に削除されています。',
    admin_required: 'パスワード一覧のものは、管理者だけが扱えます。',
    broken_entry: 'このデータは読み取れないため戻せません。'
};

document.addEventListener('DOMContentLoaded', () => {
    bootPage('trash', init);
});

registerActions({
    'trash-restore': el => restoreTrashEntry(el.dataset.id),
    'trash-purge': el => confirmPurgeTrashEntry(el.dataset.id)
});

async function init() {
    await refreshTrash();
}

async function refreshTrash() {
    updateSyncStatus(trashItems.length ? 'syncing' : 'initial-loading');
    try {
        trashItems = await api.listTrash();
        updateSyncStatus('fresh', Date.now());
    } catch (e) {
        if (!e.handled) updateSyncStatus('error', null, e.message);
        if (trashItems.length) {
            // すでに一覧を表示しているときは、それを残して知らせるだけにする(再読込の失敗で、操作できる一覧まで消さない)
            if (!e.handled) toast('ゴミ箱を最新にできませんでした: ' + humanizeApiError(e), 'error', 5000);
        } else {
            document.getElementById('trash-tbody').innerHTML =
                `<tr><td colspan="5" class="loading-text">読み込みに失敗しました: ${escapeHtml(humanizeApiError(e))}</td></tr>`;
        }
        return;
    }
    renderTrash();
}

function setTrashFilter(kind) {
    trashFilter = kind;
    document.querySelectorAll('.filter-chip[data-kind]').forEach(b => {
        const on = b.dataset.kind === kind;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderTrash();
}

function trashKindLabel(t) {
    if (t.kind === 'record') return TRASH_RESOURCE_LABELS[t.resource] || t.resource;
    return TRASH_FIELD_LABELS[t.field] || t.field;
}

// 日時は端末の時刻で「月/日 時:分」
function trashDateLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 完全に削除されるまでの残り（日・時間）
function trashRemainingLabel(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms)) return '';
    if (ms <= 0) return 'まもなく削除';
    const days = Math.floor(ms / 86400000);
    if (days >= 1) return `あと${days}日`;
    return `あと${Math.max(1, Math.floor(ms / 3600000))}時間`;
}

function renderTrash() {
    const tbody = document.getElementById('trash-tbody');
    const items = trashItems.filter(t => !trashFilter || t.kind === trashFilter);
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading-text">ゴミ箱は空です</td></tr>';
        return;
    }
    tbody.innerHTML = items.map(t => {
        const parent = t.kind === 'item' && t.recordLabel
            ? `<div class="text-muted" style="font-size:0.78rem;">「${escapeHtml(t.recordLabel)}」（${escapeHtml(TRASH_RESOURCE_LABELS[t.resource] || '')}）から外した</div>` : '';
        return `
            <tr data-id="${escapeAttr(t.id)}">
                <td>${escapeHtml(trashKindLabel(t))}</td>
                <td>${escapeHtml(t.label || '(名前なし)')}${parent}</td>
                <td class="hide-mobile">${escapeHtml(trashDateLabel(t.deletedAt))}</td>
                <td>${escapeHtml(trashRemainingLabel(t.expiresAt))}</td>
                <td data-action-cell>
                    <div class="inline-actions">
                        <button class="inline-action-btn" data-action="trash-restore" data-id="${escapeAttr(t.id)}" title="元の場所に戻す">復元</button>
                        <button class="inline-action-btn danger" data-action="trash-purge" data-id="${escapeAttr(t.id)}" title="完全に削除する（元に戻せません）">完全に削除</button>
                    </div>
                </td>
            </tr>`;
    }).join('');
}

function trashErrorMessage(e) {
    const code = String((e && e.message) || e);
    return TRASH_ERRORS[code] || code;
}

// 復元・完全削除の通信中に、同じ項目をもう一度押しても、2 回目を送らない(2 回目は not_found の失敗トーストになるため)
const _trashBusy = new Set();

async function restoreTrashEntry(id) {
    const t = trashItems.find(x => x.id === id);
    if (!t || _trashBusy.has(id)) return;
    _trashBusy.add(id);
    setTrashRowBusy(id, true);
    try {
        await api.restoreTrash(id);
        trashItems = trashItems.filter(x => x.id !== id);
        renderTrash();
        toast(`「${t.label || trashKindLabel(t)}」を元に戻しました`, 'success');
    } catch (e) {
        toast('復元できませんでした: ' + trashErrorMessage(e), 'error', 6000);
        if (String(e.message) === 'not_found') refreshTrash();
    } finally {
        _trashBusy.delete(id);
        setTrashRowBusy(id, false);
    }
}

function setTrashRowBusy(id, busy) {
    document.querySelectorAll(`#trash-tbody tr[data-id="${CSS.escape(id)}"] button`).forEach(b => { b.disabled = busy; });
}

function confirmPurgeTrashEntry(id) {
    const t = trashItems.find(x => x.id === id);
    if (!t) return;
    showConfirmDialog({
        title: `「${t.label || trashKindLabel(t)}」を完全に削除`,
        message: '完全に削除します。ファイルも消え、元に戻せません。',
        okLabel: '完全に削除する',
        danger: true,
        onOk: async () => {
            if (_trashBusy.has(id)) return;
            _trashBusy.add(id);
            setTrashRowBusy(id, true);
            try {
                await api.purgeTrash(id);
                trashItems = trashItems.filter(x => x.id !== id);
                renderTrash();
                toast('完全に削除しました', 'success');
            } catch (e) {
                toast('削除できませんでした: ' + trashErrorMessage(e), 'error', 6000);
                if (String(e.message) === 'not_found') refreshTrash();
            } finally {
                _trashBusy.delete(id);
                setTrashRowBusy(id, false);
            }
        }
    });
}

// ヘッダーの同期表示（クリックで再読込）から呼ばれる
async function refreshData() {
    await refreshTrash();
}
