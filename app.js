/**
 * SciComi Portal - 共通ロジック
 *
 * 全ページで読み込まれる（config.js の後に読み込む前提）:
 *   - 共通ユーティリティ（escapeHtml / 日付ヘルパー）
 *   - パスワード認証モーダル
 *   - ヘッダー＋ナビゲーション描画
 *   - 同期ステータス表示
 *   - トースト通知
 */

// ====== 振り返りフィードバック ユーティリティ ======

function parseFeedbackEntries(raw) {
  if (!raw || (typeof raw === 'string' && !raw.trim())) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch (_) {}
    }
    return [{ id: 'legacy_' + Date.now(), date: '', eventId: '', eventTitle: '', text: trimmed }];
  }
  return [];
}

function stringifyFeedbackEntries(entries) {
  if (!entries || entries.length === 0) return '';
  return JSON.stringify(entries);
}

function getFiscalYear(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-').map(Number);
  if (parts.length < 2) return null;
  return parts[1] >= 4 ? parts[0] : parts[0] - 1;
}

function genFeedbackId() {
  return 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function currentFiscalYear() {
  const now = new Date();
  return (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

// ====== 共通ユーティリティ ======

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// ---- data-* によるイベント委譲（XSS 対策: onclick 属性に ID・URL 等のユーザーデータを埋め込まない） ----
// 使い方: 描画側は data-action="名前" data-id="…"（値は escapeAttr）を持たせ、ページ側は
//   registerActions({ 名前: (el, ev) => … }) で登録する。click は [data-action]、change は [data-change-action]。
// 名前はページをまたいで共有されるため、領域名の接頭辞を付けること（未登録の名前は無視される）。
const _actionHandlers = {};
function registerActions(map) { Object.assign(_actionHandlers, map); }
function _dispatchAction(attr, e) {
  const el = e.target.closest && e.target.closest('[' + attr + ']');
  if (!el) return;
  const fn = _actionHandlers[el.getAttribute(attr)];
  if (fn) fn(el, e);
}
document.addEventListener('click', e => _dispatchAction('data-action', e));
document.addEventListener('change', e => _dispatchAction('data-change-action', e));
// 画像の読み込み失敗時のフォールバック: <img data-fallback="検証済みURL"> を1回だけ差し替える（onerror 属性の代替）。
// error は bubble しないので capture で拾う。fallback は描画側で safeHttpUrl を通すこと。
document.addEventListener('error', e => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.dataset.fallback || img.dataset.fbDone) return;
  img.dataset.fbDone = '1';
  img.src = img.dataset.fallback;
}, true);

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseISODate(str) {
  if (!str) return null;
  const parts = String(str).split('-');
  if (parts.length < 3) return new Date(str);
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
}

function todayISO() {
  return toISODate(new Date());
}

// ISO 日付（YYYY-MM-DD）に n 日（負も可）を足した ISO 日付。iso 省略時は今日から数える。
function addDaysISO(iso, n) {
  const d = iso ? parseISODate(iso) : new Date();
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

// 時刻を "HH:MM" に整形する。Date 1 つ、または (時, 分) の数値 2 つを受ける。
function formatTimeHM(dateOrHour, minute) {
  const h = dateOrHour instanceof Date ? dateOrHour.getHours() : dateOrHour;
  const m = dateOrHour instanceof Date ? dateOrHour.getMinutes() : minute;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function dayOfWeekJP(str) {
  const d = parseISODate(str);
  if (!d) return '';
  return ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
}

function shortDate(str) {
  const parts = String(str || '').split('-');
  if (parts.length < 3) return str || '';
  const md = `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  const dow = dayOfWeekJP(str);
  return dow ? `${md}(${dow})` : md;
}

// 予定一覧などの日付列で「年」だけ小さく2段組にして横幅を抑えるための表示用HTML（YYYY-MM-DD前提）
function dateCellHtml(str) {
  const s = String(str || '');
  const dash = s.indexOf('-');
  if (dash < 0) return escapeHtml(s);
  const year = s.slice(0, dash);
  const md = s.slice(dash + 1);
  return `<span class="ev-date-year">${escapeHtml(year)}</span><br><span class="ev-date-md">${escapeHtml(md)}</span>`;
}

function genId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// JSON 配列を文字列から取り出す。空・不正な JSON・配列以外は [] を返す（Photos / Videos など JSON 列用）。
function parseJsonArray(str) {
  if (Array.isArray(str)) return str;
  if (!str) return [];
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

// 実験レコードの写真一覧（Photos 列）
function getPhotos(exp) {
  return parseJsonArray(exp && exp.Photos);
}

// 保存領域（R2）のファイル実体を消す。deleteFile は管理者専用。
// 失敗（権限なし・通信断など）は握りつぶさず、トーストとコンソールに残す。全件成功なら true。
async function deleteStoredFiles(driveIds) {
  const ids = (driveIds || []).filter(Boolean);
  if (ids.length === 0) return true;
  let failed = 0;
  await Promise.all(ids.map(id => api.deleteFile(id).catch(err => {
    failed++;
    console.warn('ファイル実体を削除できませんでした:', id, err && err.message);
  })));
  if (failed > 0) {
    toast(`保存領域から ${failed} 件のファイルを削除できませんでした（画面上の記録からは外れています）`, 'error', 6000);
  }
  return failed === 0;
}

// ---- イベント保存の直列化 ----
// 同じイベントに対する保存は、前の保存が終わってから最新の UpdatedAt で次を送る。
// 応答前に次を送ると古い UpdatedAt で conflict になり、「他の人が編集しました」と誤表示されるため。
const _eventSaveChains = {};     // イベントID -> 直近の保存 Promise（末尾）
const _eventPatchQueues = {};    // イベントID -> 未送信の patch ジョブ
const _eventDrainScheduled = {}; // イベントID -> drain 予約済みか
const _ownSavedStamps = new Set(); // 自分の保存で確定した「ID:UpdatedAt」（ウィザードの競合判定用）

// task を、同一イベントの保存の列の末尾で実行する。task の失敗は次の保存を止めない。
function runEventSaveSerial(id, task) {
  const prev = _eventSaveChains[id] || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  _eventSaveChains[id] = next;
  next.catch(() => {}).then(() => { if (_eventSaveChains[id] === next) delete _eventSaveChains[id]; });
  return next;
}

// 自分の保存で確定した UpdatedAt か（別の人の編集と区別する）
function isOwnSavedStamp(id, updatedAt) {
  return !!updatedAt && _ownSavedStamps.has(id + ':' + updatedAt);
}

function _cloneEventVal(v) {
  return (v !== null && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
}

// イベントの一部の列を更新して保存する（楽観更新 → 直列化した送信 → 失敗時ロールバック）。
//   patch: { 列名: 値 }
//   opts.getEvent(id)            … 画面が持つ「生の」イベントオブジェクトを返す（必須。以降は同じオブジェクトを更新する）
//   opts.onOptimistic(ev)        … 楽観更新の直後に呼ぶ（再描画）
//   opts.onSaved(ev, saved)      … 保存成功時
//   opts.onRollback(ev)          … 失敗でロールバックした後（再描画）
//   opts.onConflict()            … 競合時（再読み込み）
//   opts.persist()               … ローカルキャッシュへの書き戻し（更新・ロールバックのたびに呼ぶ）
//   opts.successMessage / successDuration / conflictDuration … トースト
// 応答待ちの間に積まれた patch は 1 回の送信にまとめる。失敗した場合は、そのイベントで未確定の
// patch をすべて元に戻す（確定済みの状態へ戻る）。戻り値は保存できたら true の Promise。
function saveEventPatch(id, patch, opts) {
  opts = opts || {};
  const ev = opts.getEvent && opts.getEvent(id);
  if (!ev) return Promise.resolve(false);

  const prev = {};
  Object.keys(patch).forEach(k => { prev[k] = _cloneEventVal(ev[k]); ev[k] = patch[k]; });

  return new Promise(resolve => {
    const job = { id, patch, prev, opts, resolve, ev };
    (_eventPatchQueues[id] || (_eventPatchQueues[id] = [])).push(job);
    if (opts.persist) opts.persist();
    if (opts.onOptimistic) opts.onOptimistic(ev);
    if (!_eventDrainScheduled[id]) {
      _eventDrainScheduled[id] = true;
      runEventSaveSerial(id, () => _drainEventPatches(id));
    }
  });
}

async function _drainEventPatches(id) {
  _eventDrainScheduled[id] = false;
  const batch = (_eventPatchQueues[id] || []).splice(0);
  if (batch.length === 0) return;
  const opts = batch[0].opts;
  const ev = opts.getEvent(id);
  if (!ev) { batch.forEach(j => j.resolve(false)); return; }
  // 待っている間に画面が再読み込みされ、イベントのオブジェクトが入れ替わっていたら、patch を新しい方へ反映し直す
  batch.forEach(j => { if (j.ev !== ev) Object.assign(ev, j.patch); });

  try {
    // ev には、この batch までの楽観更新がすべて入っている。UpdatedAt は直前の保存で更新済み。
    const saved = await api.save('events', { ...ev, _baseUpdatedAt: ev.UpdatedAt || '' });
    Object.assign(ev, saved);
    if (saved && saved.UpdatedAt) _ownSavedStamps.add(id + ':' + saved.UpdatedAt);
    // 送信中に積まれた patch は、応答で上書きされないよう反映し直す
    (_eventPatchQueues[id] || []).forEach(j => Object.assign(ev, j.patch));
    if (opts.persist) opts.persist();
    batch.forEach(j => {
      if (j.opts.onSaved) j.opts.onSaved(ev, saved);
      if (j.opts.successMessage) toast(j.opts.successMessage, 'success', j.opts.successDuration || 2000);
      j.resolve(true);
    });
  } catch (e) {
    // 未確定の patch（この batch と、送信中に積まれた分）を新しい順に元へ戻す
    const later = (_eventPatchQueues[id] || []).splice(0);
    const all = batch.concat(later);
    for (let i = all.length - 1; i >= 0; i--) {
      Object.keys(all[i].prev).forEach(k => { ev[k] = all[i].prev[k]; });
    }
    if (opts.persist) opts.persist();
    all.forEach(j => { if (j.opts.onRollback) j.opts.onRollback(ev); });
    if (String(e && e.message).includes('conflict')) {
      toast('他の人がこのイベントを編集しました。最新を読み込みます。', 'error', opts.conflictDuration || 4000);
      if (opts.onConflict) opts.onConflict();
    } else {
      toast('保存失敗: ' + (e && e.message), 'error');
    }
    all.forEach(j => j.resolve(false));
  }
}

// 学籍番号の先頭2文字（例: "1C"）を学年グループとして返す。members.js の学年フィルタと共有。
function gradeOf(m) {
  const id = (m.StudentID || '').trim();
  if (id.length < 2) return '';
  return id.slice(0, 2).toUpperCase();
}

function isGradStudent(m) {
  const id = (m.StudentID || '').trim();
  return id.length >= 5 && (id[4] === 'm' || id[4] === 'M');
}

// メンバーを学年グループ（1A生・2C生…）ごとにまとめる。出欠・発表者・書類担当などの
// メンバー選択UIで候補を探しやすくするための共通ヘルパー。院生・学籍番号なしは末尾にまとめる。
function groupMembersByGrade(members) {
  const groups = {};
  const grad = [];
  const other = [];
  (members || []).forEach(m => {
    if (isGradStudent(m)) { grad.push(m); return; }
    const g = gradeOf(m);
    if (g && /^\d[A-Z]$/.test(g)) {
      (groups[g] = groups[g] || []).push(m);
    } else {
      other.push(m);
    }
  });
  const sortByName = (a, b) => (a.Name || '').localeCompare(b.Name || '', 'ja');
  const gradeKeys = Object.keys(groups).sort((a, b) => {
    const da = parseInt(a[0], 10), db = parseInt(b[0], 10);
    return da !== db ? da - db : a.localeCompare(b);
  });
  const result = gradeKeys.map(g => ({ label: `${g}生`, members: groups[g].sort(sortByName) }));
  if (grad.length) result.push({ label: '院生', members: grad.sort(sortByName) });
  if (other.length) result.push({ label: 'その他', members: other.sort(sortByName) });
  return result;
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// リンク href に使える URL だけを返す（javascript: 等の危険スキームは空にして無害化）。
// escapeAttr は引用符しかエスケープせずスキームを検証しないため、URL は必ずこれを通す。
// 後方互換: スキーム省略の既存データ（例 "docs.google.com/.."）は https:// を補ってリンク可能に保つ。
// アップロード 1 ファイルの上限(MB)。サーバー設定 file_max_mb を applySiteSettings が反映する。
// 取得できていなければ config.js の既定値。
function getFileMaxMB() {
  const n = CONFIG.FILE_UPLOAD && parseInt(CONFIG.FILE_UPLOAD.maxSizeMB, 10);
  return n >= 1 ? n : 10;
}

function safeHttpUrl(u) {
  u = String(u === null || u === undefined ? '' : u).trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;          // 既に http/https
  if (u.indexOf('//') === 0) return 'https:' + u;  // プロトコル相対 //host/...
  if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return '';  // 他スキーム(javascript:/data: 等)は拒否
  if (u.charAt(0) === '/') return '';              // 相対パスは資料URLとして不正
  return 'https://' + u;                            // スキーム無し → https を補う
}

// 設定 site_links（JSON配列 [{label,url}]）を安全な配列へ正規化する。
// 壊れた値・旧形式でもホームが落ちないよう、必ず配列を返し不正な行は落とす。
function parseSiteLinks(raw) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => ({
      label: String(item && item.label || '').trim(),
      url: safeHttpUrl(item && item.url || '')
    }))
    .filter(l => l.label && l.url);
}

// リンクカードの補足表示に使うホスト名（www. は省く）。解析できなければ空文字。
function siteLinkHost(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch (_) { return ''; }
}

// PartsList を新旧どちらの形式でも {name, presenters:[]} の配列に正規化する（読み取り専用用途）。
//   旧形式: [{partName:"一部", items:[{name, presenter}]}]
//   新形式: [{name, presenters:[]}]
// ※ 編集UIで使う script.js の parsePartsList は空時に空行プレースホルダを返す仕様のため別物。
//   集計・表示（bot 等）はこちらを使う。空・不正は [] を返す。
function normalizeParts(raw) {
  let data = raw;
  if (data === null || data === undefined || data === '') return [];
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return []; }
  }
  if (!Array.isArray(data)) return [];
  if (data[0] && data[0].partName !== undefined) {
    const flat = [];
    data.forEach(p => (p.items || []).forEach(it => {
      if (!it.name && !it.presenter) return;
      flat.push({ name: it.name || '', presenters: it.presenter ? [it.presenter] : [] });
    }));
    return flat;
  }
  return data.map(it => ({
    name: it.name || '',
    presenters: Array.isArray(it.presenters) ? it.presenters : (it.presenter ? [it.presenter] : [])
  }));
}

// メンバーの役職（Role 優先、無ければ旧 Category から導出）。
// members / home / bot / events の各ページで同じ導出が重複していたため共通化。
function memberRoleOf(m) {
  if (m.Role) return m.Role;
  if (m.Category === 'adviser') return 'アドバイザー';
  if (m.Category === 'coordinator') return 'コーディネーター';
  return '';
}

// メンバー詳細ポップアップ（メンバーページ・イベント別の参加回答一覧など、
// メンバーをタップして詳細を見せたい箇所すべてで共通利用する）。
// opts.hideFurigana: ふりがな行を省く（参加回答一覧など、ふりがなを表示していない一覧から開く場合）
// opts.onEdit: 指定時のみ「編集」ボタンを表示し、タップで onEdit(id) を呼ぶ
function openMemberDetailModal(id, members, opts) {
  opts = opts || {};
  const m = (members || []).find(x => x.ID === id);
  if (!m) return;
  const role = memberRoleOf(m);
  const roleInfo = role ? getRoleDisplay(role) : null;
  const isStaff = role === 'アドバイザー' || role === 'コーディネーター';

  const rows = [
    [isStaff ? '教職員番号' : '学籍番号', m.StudentID || ''],
    opts.hideFurigana ? null : ['ふりがな', m.Furigana || ''],
    ['名前', m.Name || ''],
    ...(isStaff ? [
      ['メールアドレス', m.Email || ''],
      ['所属', m.Affiliation || ''],
      ['内線', m.Extension || ''],
      ['緊急連絡先', m.EmergencyContact || '']
    ] : [])
  ].filter(Boolean).filter(r => r[1]);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
        <div class="modal-content" style="max-width:460px;" role="dialog" aria-modal="true" aria-labelledby="member-detail-title">
            <h2 id="member-detail-title" style="margin-top:0;">
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
                ${api.isAdmin() && opts.onEdit ? '<button type="button" class="btn btn-secondary" data-edit>編集</button>' : ''}
                <button type="button" class="btn btn-primary-solid" style="width:auto;" data-close>閉じる</button>
            </div>
        </div>`;

  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  const editBtn = overlay.querySelector('[data-edit]');
  if (editBtn) editBtn.addEventListener('click', () => { close(); opts.onEdit(id); });
  overlay.addEventListener('click', (e) => {
    const cell = e.target.closest('.copy-cell');
    if (cell) copyTextToClipboard(cell.dataset.copy, cell.dataset.copyLabel);
  });
  bindOverlayClose(overlay, close);
  bindModalEscape(overlay, close);
  document.body.appendChild(overlay);
  trapFocus(overlay.querySelector('.modal-content'));
}

// ====== ナビゲーション ======

// 直近取得済みのサーバー設定キャッシュを読む（renderHeader は applySiteSettings より先に
// 走るため、ヘッダーのブランド表示だけは同期的にキャッシュから先出しし、後から _applyCfg で更新する）
function _readCachedSiteSettings() {
  try {
    const raw = localStorage.getItem('scicomi_site_settings');
    if (!raw) return null;
    return JSON.parse(raw).data || null;
  } catch (_) { return null; }
}

function renderHeader(activePage) {
  const header = document.querySelector('.app-header');
  if (!header) return;
  const isAdmin = api.isAdmin();
  const cachedCfg = _readCachedSiteSettings();
  const brandIcon = (cachedCfg && cachedCfg.brand_icon) || 'SC';
  const brandName = (cachedCfg && cachedCfg.brand_name) || 'SciComi Portal';

  const navItems = CONFIG.NAV_ITEMS.filter(item =>
    (!item.adminOnly || isAdmin) && (!item.feature || (CONFIG.FEATURES && CONFIG.FEATURES[item.feature])));
  let navHtml = '';
  navItems.forEach(item => {
    if (item.adminFirst) navHtml += '<span class="nav-separator"></span>';
    navHtml += `<a href="${item.href}" class="nav-link ${item.page === activePage ? 'active' : ''}">${item.label}</a>`;
  });

  header.innerHTML = `
    <div class="header-top">
      <div class="header-brand">
        <a href="index.html" style="color:inherit;text-decoration:none;display:flex;align-items:center;gap:8px;">
          <span class="brand-icon" id="header-brand-icon">${escapeHtml(brandIcon)}</span>
          <span class="brand-name" id="header-brand-name">${escapeHtml(brandName)}</span>
        </a>
      </div>
      <div class="header-actions">
        <div id="sync-status" class="sync-status" title="クリックで再読込" onclick="if(window.refreshData)refreshData(true)"></div>
        ${isAdmin
          ? `<span class="admin-badge">管理者</span>`
          : `<button class="btn btn-text-light" onclick="showAdminAuthModal()">管理者</button>`
        }
        <button class="btn btn-text-light" id="logout-btn" onclick="handleLogout(this)">ログアウト</button>
      </div>
    </div>
    <nav class="app-nav">
      ${navHtml}
    </nav>
  `;
  syncHeaderHeightVar();
}

// ヘッダーは折り返しや管理者バッジの有無で実際の高さが変わる。AI検索ページ（bot.html）は
// ヘッダーの下でぴったりビューポート高に収まるチャットレイアウトのため、固定px値ではなく
// 実測値を --header-h に反映する（ズレるとページがビューポートより少しはみ出す）。
function syncHeaderHeightVar() {
  const header = document.querySelector('.app-header');
  if (!header) return;
  document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
}
window.addEventListener('resize', syncHeaderHeightVar);

function handleLogout(btn) {
  if (btn.dataset.confirming) {
    api.clearToken();
    api.clearAdminToken();
    api.clearAllCache();
    // サーバー設定由来のキャッシュも消す（次のログインで再取得される）
    localStorage.removeItem('scicomi_site_settings');
    localStorage.removeItem('scicomi_welcome_message');
    // 検索履歴も消す（検索語から活動内容が推測できるため。共有端末を想定）
    Object.keys(localStorage)
      .filter(k => k.indexOf('scicomi_search_history_') === 0)
      .forEach(k => localStorage.removeItem(k));
    location.href = 'index.html';
    return;
  }
  btn.dataset.confirming = '1';
  btn.textContent = 'ログアウトする？';
  btn.style.color = '#e74c3c';
  setTimeout(() => {
    if (btn.dataset.confirming) {
      delete btn.dataset.confirming;
      btn.textContent = 'ログアウト';
      btn.style.color = '';
    }
  }, 3000);
}

// ====== モーダル アクセシビリティ ======

function trapFocus(modal) {
  const focusable = modal.querySelectorAll('input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  // 開いた直後にフォーカスがモーダル外（多くは body）に残ると、最初の Tab で背後のページへ
  // 抜けてしまう。まだモーダル内に無ければ先頭要素へ移す（呼び出し側が個別に .focus() する
  // 場合は trapFocus の後に実行されるため、そちらが後勝ちで上書きする）。
  if (!modal.contains(document.activeElement)) {
    try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); }
  }
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

// Esc で閉じるモーダルのスタック。document の keydown は 1 つだけ登録し、
// 表示中のモーダルのうち最後に開いた(=最前面の)1 つだけを閉じる。
// 静的モーダル(.hidden の切替で再利用)は開くたびにここを通るので、そのたびに先頭へ移す。
// DOM から外れたモーダルは、次の Esc のときにスタックから取り除く(常時監視はしない)。
const _modalEscStack = [];

function _isModalShown(modal) {
  return modal.isConnected && !modal.classList.contains('hidden') && modal.getClientRects().length > 0;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || _modalEscStack.length === 0) return;
  for (let i = _modalEscStack.length - 1; i >= 0; i--) {
    const b = _modalEscStack[i];
    if (!b.modal.isConnected) { _modalEscStack.splice(i, 1); continue; }
    if (!_isModalShown(b.modal)) continue;
    e.preventDefault();
    b.closeFn();
    return;
  }
});

function bindModalEscape(modal, closeFn) {
  let binding = modal._escBinding;
  if (binding) {
    binding.closeFn = closeFn;
    const idx = _modalEscStack.indexOf(binding);
    if (idx >= 0) _modalEscStack.splice(idx, 1);
  } else {
    binding = { modal, closeFn };
    binding.cleanup = () => {
      const i = _modalEscStack.indexOf(binding);
      if (i >= 0) _modalEscStack.splice(i, 1);
      delete modal._escBinding;
    };
    modal._escBinding = binding;
  }
  _modalEscStack.push(binding);
  return binding.cleanup;
}

function bindOverlayClose(overlayEl, closeFn) {
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeFn();
  });
}

// ====== 編集モーダルの誤操作ガード ======
// 領域外クリック・Esc で閉じる前に、入力へ変更があれば「破棄して閉じる？」確認を挟む。
// 何も触っていなければ従来どおり即閉じる。
// 開いた直後にコードが初期値を流し込むモーダルがあるため、
// 呼び出しは open 関数の最後（初期値の設定がすべて終わった後）に行うこと。

function bindEditDismissGuard(overlay, closeFn) {
  const snapshot = () =>
    [...overlay.querySelectorAll('input, textarea, select')]
      .map(el => (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : el.value)
      .join('\u0000');
  const initial = snapshot();
  // ファイル添付・タグ操作など snapshot に現れにくい操作も input/change で拾う
  let touched = false;
  overlay.addEventListener('input', () => { touched = true; });
  overlay.addEventListener('change', () => { touched = true; });

  const attemptClose = () => {
    if (!touched && snapshot() === initial) { closeFn(); return; }
    showDiscardConfirm(closeFn);
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) attemptClose(); });
  bindModalEscape(overlay, attemptClose);
  return attemptClose;
}

// ====== 汎用確認ダイアログ ======
// 削除確認・投票確認など、ページごとにバラバラだった確認UIを統一する。
// onOk が async の場合は完了まで OK ボタンを無効化し busyLabel を表示する。
function showConfirmDialog({ title, message, okLabel = 'OK', cancelLabel = 'キャンセル', danger = false, busyLabel = '処理中...', onOk }) {
  const ov = document.createElement('div');
  ov.className = 'confirm-dialog-overlay';
  ov.innerHTML = `
    <div class="confirm-dialog" role="alertdialog" aria-modal="true">
      <h3>${escapeHtml(title || '')}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <div class="confirm-dialog-actions">
        <button type="button" class="btn btn-secondary" data-cancel>${escapeHtml(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary-solid'}" data-ok>${escapeHtml(okLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('[data-cancel]').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  bindModalEscape(ov, close);
  const okBtn = ov.querySelector('[data-ok]');
  okBtn.addEventListener('click', async () => {
    if (!onOk) { close(); return; }
    okBtn.disabled = true;
    const orig = okBtn.textContent;
    okBtn.textContent = busyLabel;
    try {
      await onOk();
      close();
    } catch (e) {
      okBtn.disabled = false;
      okBtn.textContent = orig;
      toast('失敗しました: ' + (e && e.message ? e.message : e), 'error');
    }
  });
  setTimeout(() => okBtn.focus(), 30);
  return { close };
}

function showDiscardConfirm(onDiscard) {
  if (document.getElementById('discard-confirm-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'discard-confirm-overlay';
  ov.className = 'confirm-dialog-overlay';
  ov.innerHTML = `
    <div class="confirm-dialog" role="alertdialog" aria-modal="true">
      <h3>編集内容が保存されていません</h3>
      <p>このまま閉じると、入力した内容は失われます。</p>
      <div class="confirm-dialog-actions">
        <button type="button" class="btn btn-secondary" data-stay>編集を続ける</button>
        <button type="button" class="btn btn-danger" data-discard>破棄して閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-stay]').addEventListener('click', () => ov.remove());
  ov.querySelector('[data-discard]').addEventListener('click', () => { ov.remove(); onDiscard(); });
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  bindModalEscape(ov, () => ov.remove());
  setTimeout(() => ov.querySelector('[data-stay]').focus(), 30);
}

// ====== クリップボード ======

// テキストをコピーしてトーストで通知する。navigator.clipboard は
// https/localhost 以外（file:// 配布など）で使えないため execCommand へフォールバック。
async function copyTextToClipboard(text, label) {
  const value = String(text === null || text === undefined ? '' : text).trim();
  if (!value) return;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      ok = true;
    }
  } catch (_) {}
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
  }
  toast(ok ? `${label || 'テキスト'}をコピーしました` : 'コピーできませんでした', ok ? 'success' : 'error', 2000);
}

// ====== 管理者認証モーダル ======

function showAdminAuthModal(onSuccess) {
  let existing = document.getElementById('admin-auth-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'admin-auth-modal';
  modal.innerHTML = `
    <div class="pw-overlay">
      <div class="pw-box" role="dialog" aria-modal="true" aria-labelledby="admin-auth-title">
        <h2 id="admin-auth-title">管理者認証</h2>
        <p>管理者モードのパスワードを入力してください。</p>
        <input id="admin-pw-input" type="password" placeholder="管理者モードのパスワード" autofocus>
        <div id="admin-pw-error" class="pw-error" role="alert"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button id="admin-pw-cancel" class="btn btn-secondary">キャンセル</button>
          <button id="admin-pw-submit" class="btn btn-primary-solid">認証</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const box = modal.querySelector('.pw-box');
  const input = modal.querySelector('#admin-pw-input');
  const errEl = modal.querySelector('#admin-pw-error');
  const submitBtn = modal.querySelector('#admin-pw-submit');
  const cancelBtn = modal.querySelector('#admin-pw-cancel');
  trapFocus(box);
  bindModalEscape(modal, () => modal.remove());
  setTimeout(() => input.focus(), 50);

  const tryAdminLogin = async () => {
    errEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = '認証中...';
    try {
      const ok = await api.adminAuth(input.value);
      if (ok) {
        modal.remove();
        toast('管理者モードに切り替えました', 'success');
        if (onSuccess) {
          await onSuccess();
        } else {
          location.reload();
        }
      } else {
        errEl.textContent = 'パスワードが違います';
        submitBtn.disabled = false;
        submitBtn.textContent = '認証';
        input.select();
      }
    } catch (e) {
      errEl.textContent = humanizeApiError(e);
      submitBtn.disabled = false;
      submitBtn.textContent = '認証';
    }
  };

  submitBtn.addEventListener('click', tryAdminLogin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryAdminLogin(); });
  cancelBtn.addEventListener('click', () => modal.remove());
  modal.querySelector('.pw-overlay').addEventListener('click', (e) => {
    if (e.target === modal.querySelector('.pw-overlay')) modal.remove();
  });
}


// ====== 認証ゲート ======

async function requireAuth(onReady) {
  if (!api.getToken()) {
    showPasswordModal(onReady);
    return;
  }
  await onReady();
}

function showPasswordModal(onSuccess) {
  // 複数の API 呼び出しが同時に unauthorized を返すと多重に開くため、既存があれば作り直す
  const existing = document.getElementById('pw-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'pw-modal';
  modal.innerHTML = `
    <div class="pw-overlay">
      <div class="pw-box" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title">
        <h2 id="pw-modal-title">ログイン</h2>
        <p>パスワードを入力してください。<br>
          <span class="text-muted" style="font-size:0.8rem;">管理者モードのパスワードを入力すると、自動的に管理者モードでログインします。</span>
        </p>
        <input id="pw-input" type="password" placeholder="パスワード" autofocus>
        <div id="pw-error" class="pw-error" role="alert"></div>
        <button id="pw-submit" class="btn btn-primary-solid">ログイン</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const box = modal.querySelector('.pw-box');
  const input = modal.querySelector('#pw-input');
  const errEl = modal.querySelector('#pw-error');
  const submitBtn = modal.querySelector('#pw-submit');
  trapFocus(box);
  setTimeout(() => input.focus(), 50);

  const tryLogin = async () => {
    errEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = '認証中...';
    try {
      const result = await api.login(input.value);
      if (result.ok) {
        modal.remove();
        toast(result.role === 'admin' ? '管理者としてログインしました' : 'ログインしました', 'success');
        await onSuccess();
      } else {
        errEl.textContent = 'パスワードが違います';
        submitBtn.disabled = false;
        submitBtn.textContent = 'ログイン';
        input.select();
      }
    } catch (e) {
      errEl.textContent = humanizeApiError(e);
      submitBtn.disabled = false;
      submitBtn.textContent = 'ログイン';
    }
  };

  submitBtn.addEventListener('click', tryLogin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
}

// ====== 同期ステータス ======

function updateSyncStatus(state, timestamp, errMsg) {
  const el = document.getElementById('sync-status');
  if (!el) return;

  const fmtTime = (ts) => {
    if (!ts) return '';
    return formatTimeHM(new Date(ts));
  };

  // 正常同期済みはドットだけにして常時のテキストノイズを減らす（詳細はツールチップで）
  const labels = {
    'initial-loading': '<span class="sync-dot loading"></span>読み込み中...',
    'syncing-bg':      '<span class="sync-dot loading"></span>同期中...',
    'syncing':         '<span class="sync-dot loading"></span>更新中...',
    'fresh':           '<span class="sync-dot fresh"></span>',
    'cached':          `<span class="sync-dot cached"></span>キャッシュ表示 ${fmtTime(timestamp)}`,
    'error':           `<span class="sync-dot error"></span>同期エラー`
  };
  el.innerHTML = labels[state] || '';
  if (state === 'fresh') {
    el.title = `${fmtTime(timestamp)} 同期済 — クリックで再読込`;
  } else if (state === 'error') {
    // エラー詳細（ツールチップ）は既知のコードを日本語へ変換して表示する
    el.title = errMsg
      ? (typeof humanizeApiError === 'function' ? humanizeApiError({ code: errMsg, message: errMsg }) : errMsg)
      : '';
  } else {
    el.title = 'クリックで再読込';
  }
}

// ====== トースト通知 ======

function toast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('role', 'status');
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, duration);
}

function toastUndo(message, onUndo, onCommit, delay = 5000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('role', 'status');
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast toast-undo';
  t.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button class="toast-undo-btn">元に戻す</button>
    <div class="toast-progress"></div>
  `;
  container.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);

  let undone = false;
  const undoBtn = t.querySelector('.toast-undo-btn');
  undoBtn.addEventListener('click', () => {
    undone = true;
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
    onUndo();
  });

  const progress = t.querySelector('.toast-progress');
  progress.style.transition = `width ${delay}ms linear`;
  setTimeout(() => { progress.style.width = '0%'; }, 10);

  setTimeout(async () => {
    if (undone) return;
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
    try { await onCommit(); } catch (e) { toast('削除失敗: ' + e.message, 'error'); }
  }, delay);
}

// ====== サーバー設定の反映 ======

// 設定を書き換えた直後にキャッシュを捨てる（次回 applySiteSettings で必ずサーバーへ取りに行く）。
// settings.js・experiments.js など、Config キーを保存する複数ページから使う共通処理。
function invalidateSettingsCache() {
  localStorage.removeItem('scicomi_site_settings');
}

async function applySiteSettings() {
    const SETTINGS_CACHE_KEY = 'scicomi_site_settings';
    const SETTINGS_TTL = 10 * 60 * 1000; // 10分
    try {
        const cached = localStorage.getItem(SETTINGS_CACHE_KEY);
        if (cached) {
            const obj = JSON.parse(cached);
            // 旧版は管理者設定（パスワード・APIキー）ごと保存していたため、残っていれば破棄する
            const LEGACY_SECRET_KEYS = ['password', 'admin_password', 'gemini_api_key', 'line_channel_access_token', 'report_recipients'];  // report_recipients は廃止済み。古いキャッシュの掃除用に残す
            if (obj.data && LEGACY_SECRET_KEYS.some(k => k in obj.data)) {
                localStorage.removeItem(SETTINGS_CACHE_KEY);
            } else if (Date.now() - obj.ts < SETTINGS_TTL) {
                _applyCfg(obj.data);
                return;
            }
        }
    } catch (_) {}
    try {
        // 表示に使うのは公開設定だけなので、管理者でも公開設定を取得する
        // （管理者専用の設定を localStorage に残さないため）。
        const cfg = await api.getPublicConfig();
        _applyCfg(cfg);
        localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ data: cfg, ts: Date.now() }));
    } catch (_) {}
}

function _applyCfg(cfg) {
    if (!cfg) return;
    const safeInt = (v, fallback) => { const n = parseInt(v, 10); return isNaN(n) ? fallback : n; };
    if (cfg.deadline_kyoka != null && cfg.deadline_kyoka !== '') CONFIG.DEADLINE_RULES.kyoka = safeInt(cfg.deadline_kyoka, CONFIG.DEADLINE_RULES.kyoka);
    if (cfg.deadline_houkoku != null && cfg.deadline_houkoku !== '') CONFIG.DEADLINE_RULES.houkoku = safeInt(cfg.deadline_houkoku, CONFIG.DEADLINE_RULES.houkoku);
    if (cfg.deadline_alert_danger != null && cfg.deadline_alert_danger !== '') CONFIG.DEADLINE_ALERT.danger = safeInt(cfg.deadline_alert_danger, CONFIG.DEADLINE_ALERT.danger);
    if (cfg.deadline_alert_warning != null && cfg.deadline_alert_warning !== '') CONFIG.DEADLINE_ALERT.warning = safeInt(cfg.deadline_alert_warning, CONFIG.DEADLINE_ALERT.warning);
    // ホームのメッセージは空なら削除（管理者がクリアしたら既定文へ戻す）
    if (cfg.welcome_message !== undefined) {
        if (cfg.welcome_message) localStorage.setItem('scicomi_welcome_message', cfg.welcome_message);
        else localStorage.removeItem('scicomi_welcome_message');
    }
    if (cfg.pr_channels) CONFIG.PR_CHANNELS = cfg.pr_channels.split(',').map(s => s.trim()).filter(Boolean);
    // アップロード上限はサーバー(worker の file_max_mb)が正。取得できたらフロントの事前チェックも合わせる
    const maxMb = safeInt(cfg.file_max_mb, 0);
    if (maxMb >= 1) CONFIG.FILE_UPLOAD.maxSizeMB = maxMb;
    // ヘッダーはキャッシュ値で先出し済みのことがあるため、取得できた最新値で上書きする
    if (cfg.brand_icon) {
        const el = document.getElementById('header-brand-icon');
        if (el) el.textContent = cfg.brand_icon;
    }
    if (cfg.brand_name) {
        const el = document.getElementById('header-brand-name');
        if (el) el.textContent = cfg.brand_name;
    }
}

// ====== リッチテキスト編集 ======

function createRichEditor(container, initialHtml, options = {}) {
  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-editor';

  const toolbar = document.createElement('div');
  toolbar.className = 'rich-editor-toolbar';
  toolbar.innerHTML = `
    <button type="button" class="re-btn" data-cmd="bold" title="太字"><b>B</b></button>
    <button type="button" class="re-btn" data-cmd="underline" title="下線"><u>U</u></button>
    <button type="button" class="re-btn" data-cmd="createLink" title="リンクを挿入">🔗</button>
    <button type="button" class="re-btn" data-cmd="unlink" title="リンクを解除">✂</button>
  `;

  const content = document.createElement('div');
  content.className = 'rich-editor-content';
  content.contentEditable = 'true';
  // 編集中の DOM も生きた DOM なので、流し込む HTML は必ず無害化してから入れる
  content.innerHTML = sanitizeRichHtml(initialHtml || '');
  if (options.placeholder) content.dataset.placeholder = options.placeholder;

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.re-btn');
    if (!btn) return;
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    if (cmd === 'createLink') {
      const input = prompt('URLを入力してください', 'https://');
      if (input) {
        const url = safeHttpUrl(input);
        if (url) document.execCommand('createLink', false, url);
        else toast('http:// または https:// で始まるURLを入力してください', 'error');
      }
    } else {
      document.execCommand(cmd, false, null);
    }
    content.focus();
  });

  // 貼り付けは既定だと任意の HTML(img onerror 等)がそのまま入るため、無害化してから挿入する
  content.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    const html = cd.getData('text/html');
    if (html) document.execCommand('insertHTML', false, sanitizeRichHtml(html));
    else document.execCommand('insertText', false, cd.getData('text/plain') || '');
  });

  wrapper.appendChild(toolbar);
  wrapper.appendChild(content);
  container.appendChild(wrapper);

  const editorApi = {
    getHtml: () => sanitizeRichHtml(content.innerHTML),
    setHtml: (html) => { content.innerHTML = sanitizeRichHtml(html); },
    focus: () => content.focus()
  };
  container._richEditor = editorApi;
  return editorApi;
}

// リッチテキスト(ホームの挨拶文・実験ネタ募集の案内文)の無害化。許可リスト方式。
// DOMParser で作る文書は画面に属さず、スクリプトも画像も読み込まれない(img onerror が発火しない)。
const RICH_ALLOWED_TAGS = new Set(['B', 'I', 'U', 'A', 'BR', 'DIV', 'P', 'SPAN', 'UL', 'OL', 'LI']);
// 中身ごと捨てるタグ(許可外でも中の文字は残す「その他のタグ」と区別する)
const RICH_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'TEMPLATE', 'NOSCRIPT',
  'SVG', 'MATH', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'PICTURE', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT',
  'BUTTON', 'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'FRAME', 'FRAMESET']);
// 許可する style のプロパティ(execCommand の太字・斜体・下線が span の style で出る場合がある)
const RICH_ALLOWED_STYLES = ['font-weight', 'font-style', 'text-decoration', 'text-decoration-line'];

function sanitizeRichHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString('<body>' + String(html) + '</body>', 'text/html');
  const clean = (parent) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue; }   // コメント等
      const tag = node.tagName.toUpperCase();
      if (RICH_DROP_TAGS.has(tag)) { node.remove(); continue; }
      clean(node);
      if (!RICH_ALLOWED_TAGS.has(tag)) {
        // 許可外のタグ(h1, strong 等)はタグだけ外して中身の文字は残す
        node.replaceWith(...node.childNodes);
        continue;
      }
      const href = tag === 'A' ? safeHttpUrl(node.getAttribute('href')) : '';
      const style = node.style;
      const kept = [];
      if (style) {
        RICH_ALLOWED_STYLES.forEach(p => {
          const v = style.getPropertyValue(p);
          // 値に url( や expression を含むものは入れない(許可したプロパティでも念のため)
          if (v && !/url\s*\(|expression|javascript:/i.test(v)) kept.push(p + ':' + v);
        });
      }
      for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      if (kept.length) node.setAttribute('style', kept.join(';'));
      if (tag === 'A') {
        if (!href) { node.replaceWith(...node.childNodes); continue; }   // 危険・不正な URL はリンクを外す
        node.setAttribute('href', href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

// ====== 起動共通 ======

async function bootPage(activePage, onAuthReady) {
  renderHeader(activePage);
  await requireAuth(async () => {
    await applySiteSettings();
    await onAuthReady();
  });
}
