/**
 * SciComi Portal - Google Apps Script Backend API (v4)
 *
 * 3つのリソースに対応:
 *   - events:      イベントカレンダー
 *   - members:     メンバーリスト（アドバイザー/コーディネーター/メンバー）
 *   - experiments: 実験内容（工作/実験ショー/その他）
 *
 * v4 追加:
 *   - セッショントークン認証（CacheService ベース）
 *   - 管理者（幹部）認証・権限分離
 *   - Gemini API プロキシ（APIキーサーバー側管理）
 *   - 監査ログ（AuditLog シート）
 */

// ====== 設定 ======
const SHEET_ID = '19C7hff94sp6s6rsbhwMPeIvOhhqqbOK-kj9edSu2UPc';
const EVENTS_SHEET = 'Events';
const MEMBERS_SHEET = 'Members';
const EXPERIMENTS_SHEET = 'Experiments';
const CONFIG_SHEET = 'Config';
const AUDIT_LOG_SHEET = 'AuditLog';

const SESSION_TTL = 86400;       // メンバートークン有効期間: 24時間
const ADMIN_SESSION_TTL = 7200;  // 管理者トークン有効期間: 2時間
const GEMINI_MODEL = 'gemini-2.0-flash-lite';
const GEMINI_DAILY_LIMIT = 1500;

// ====== エントリポイント ======

function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || 'list';
    const resource = params.resource || 'events';

    if (!checkAuth(params.token)) {
      return jsonResponse({ success: false, error: 'unauthorized' });
    }

    if (action === 'list') {
      return jsonResponse({ success: true, items: listResource(resource) });
    }
    if (action === 'listAll') {
      return jsonResponse({
        success: true,
        events: listResource('events'),
        members: listResource('members'),
        experiments: listResource('experiments')
      });
    }

    return jsonResponse({ success: false, error: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    let body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (_) {}
    }
    const params = (e && e.parameter) || {};
    const token = body.token || params.token || '';
    const action = body.action || params.action || '';
    const resource = body.resource || params.resource || 'events';

    Logger.log('doPost: action=' + action + ', resource=' + resource);

    // --- 認証（パスワード不要） ---
    if (action === 'auth') {
      const inputPw = (body.password || '').trim();
      const realPw = getConfig('password').trim();
      const ok = inputPw === realPw && inputPw !== '';
      if (!ok) {
        appendAuditLog('auth_fail', '', token);
        throttleFailedAuth_('member');
        return jsonResponse({ success: false });
      }
      resetFailedAuth_('member');
      const newToken = generateToken('member');
      return jsonResponse({ success: true, token: newToken });
    }

    // --- 管理者認証 ---
    if (action === 'adminAuth') {
      const inputPw = (body.admin_password || '').trim();
      const realPw = getConfig('admin_password').trim();
      const ok = inputPw === realPw && inputPw !== '';
      appendAuditLog(ok ? 'adminAuth_success' : 'adminAuth_fail', '', token);
      if (!ok) {
        throttleFailedAuth_('admin');
        return jsonResponse({ success: false });
      }
      resetFailedAuth_('admin');
      const adminToken = generateToken('admin');
      return jsonResponse({ success: true, adminToken: adminToken });
    }

    // --- list/listAll (POST版) ---
    if (action === 'list') {
      if (!checkAuth(token)) return jsonResponse({ success: false, error: 'unauthorized' });
      return jsonResponse({ success: true, items: listResource(resource) });
    }
    if (action === 'listAll') {
      if (!checkAuth(token)) return jsonResponse({ success: false, error: 'unauthorized' });
      return jsonResponse({
        success: true,
        events: listResource('events'),
        members: listResource('members'),
        experiments: listResource('experiments')
      });
    }

    // --- 以下は認証必須 ---
    if (!checkAuth(token)) {
      return jsonResponse({ success: false, error: 'unauthorized' });
    }

    if (action === 'save') {
      try {
        const isNew = !(body.item && body.item.ID);
        const saved = saveResource(resource, body.item || {});
        appendAuditLog(isNew ? 'create' : 'update', resource + ':' + saved.ID, token, 'member');
        return jsonResponse({ success: true, item: saved });
      } catch (err) {
        if (String(err).indexOf('conflict') >= 0) {
          return jsonResponse({ success: false, error: 'conflict' });
        }
        throw err;
      }
    }

    // --- 削除: 管理者権限必須 ---
    if (action === 'delete') {
      if (!checkAdmin(body.adminToken)) {
        return jsonResponse({ success: false, error: 'admin_required' });
      }
      const id = body.id || params.id;
      appendAuditLog('delete', resource + ':' + id, body.adminToken, 'admin');
      const deleted = deleteResource(resource, id);
      return jsonResponse({ success: deleted });
    }

    if (action === 'uploadFile') {
      const result = uploadFileToDrive(body.file || {});
      appendAuditLog('uploadFile', (result.name || '') + ' (' + (result.driveId || '') + ')', token, 'member');
      return jsonResponse({ success: true, file: result });
    }

    // --- ファイル削除: 管理者権限必須 ---
    if (action === 'deleteFile') {
      if (!checkAdmin(body.adminToken)) {
        return jsonResponse({ success: false, error: 'admin_required' });
      }
      appendAuditLog('deleteFile', body.driveId || '', body.adminToken, 'admin');
      const ok = deleteFileFromDrive(body.driveId || '');
      return jsonResponse({ success: ok });
    }

    // --- Gemini プロキシ ---
    if (action === 'geminiProxy') {
      return handleGeminiProxy(body);
    }

    // --- 管理者設定読み取り ---
    if (action === 'adminGetConfig') {
      if (!checkAdmin(body.adminToken)) {
        return jsonResponse({ success: false, error: 'admin_required' });
      }
      return jsonResponse({
        success: true,
        config: {
          password: getConfig('password'),
          admin_password: getConfig('admin_password'),
          gemini_api_key: getConfig('gemini_api_key')
        }
      });
    }

    // --- 管理者設定書き込み ---
    if (action === 'adminSetConfig') {
      if (!checkAdmin(body.adminToken)) {
        return jsonResponse({ success: false, error: 'admin_required' });
      }
      const allowedKeys = ['password', 'admin_password', 'gemini_api_key'];
      const key = body.key || '';
      if (allowedKeys.indexOf(key) < 0) {
        return jsonResponse({ success: false, error: 'forbidden_key' });
      }
      setConfig(key, body.value || '');
      appendAuditLog('adminSetConfig', key, body.adminToken, 'admin');
      if (key === 'password') invalidateAllTokens('member');
      if (key === 'admin_password') invalidateAllTokens('admin');
      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, error: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err), stack: err.stack });
  }
}

// ====== 共通ヘルパー ======

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.TEXT);
}

// ---- セッショントークン認証（ステートレス署名方式） ----
//
// トークンは「ペイロード(role|epoch|発行時刻).HMAC署名」の形式。
// サーバーに保存しないため CacheService の揮発でログアウトする問題が無い。
// パスワード変更時は role ごとの epoch を +1 するだけで既存トークンを即時失効できる。

function getScriptProp_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined) ? fallback : v;
}

function getTokenSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('token_secret');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('token_secret', s);
  }
  return s;
}

function getTokenEpoch_(role) {
  return parseInt(getScriptProp_('token_epoch_' + role, '1'), 10) || 1;
}

function bumpTokenEpoch_(role) {
  PropertiesService.getScriptProperties()
    .setProperty('token_epoch_' + role, String(getTokenEpoch_(role) + 1));
}

function hmacHex_(message) {
  var raw = Utilities.computeHmacSha256Signature(message, getTokenSecret_());
  return raw.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function generateToken(role) {
  var payload = role + '|' + getTokenEpoch_(role) + '|' + Date.now();
  var enc = Utilities.base64EncodeWebSafe(payload);
  return enc + '.' + hmacHex_(enc);
}

function verifyToken_(token, role) {
  if (!token) return false;
  var parts = String(token).split('.');
  if (parts.length !== 2) return false;
  var enc = parts[0];
  if (hmacHex_(enc) !== parts[1]) return false; // 署名不一致
  var payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(enc)).getDataAsString();
  } catch (e) { return false; }
  var seg = payload.split('|');
  if (seg.length !== 3) return false;
  if (seg[0] !== role) return false;
  if ((parseInt(seg[1], 10) || 0) !== getTokenEpoch_(role)) return false; // 世代失効
  var issued = parseInt(seg[2], 10) || 0;
  var ttlMs = (role === 'admin' ? ADMIN_SESSION_TTL : SESSION_TTL) * 1000;
  if (Date.now() - issued > ttlMs) return false; // 期限切れ
  return true;
}

function checkAuth(token) { return verifyToken_(token, 'member'); }
function checkAdmin(adminToken) { return verifyToken_(adminToken, 'admin'); }

function invalidateAllTokens(role) {
  // epoch を進めることで、既存の同 role トークンを即時に無効化する。
  bumpTokenEpoch_(role);
  Logger.log('All ' + role + ' tokens invalidated (epoch bumped)');
}

// ---- 認証試行のスロットリング（総当たり対策） ----
// GAS は接続元IPを取得できないため role 単位のグローバルな漸進的遅延で緩和する。
function throttleFailedAuth_(scope) {
  var cache = CacheService.getScriptCache();
  var key = 'authfail_' + scope;
  var n = (parseInt(cache.get(key), 10) || 0) + 1;
  cache.put(key, String(n), 600); // 10分間カウント保持
  Utilities.sleep(Math.min(n * 300, 4000)); // 失敗を重ねるほど最大4秒まで遅延
}

function resetFailedAuth_(scope) {
  CacheService.getScriptCache().remove('authfail_' + scope);
}

// ---- Config 読み書き ----
// 1リクエスト（1実行）内では Config シートを1回だけ読み、以降はメモ化した値を返す。
// （getConfig は認証・各処理で何度も呼ばれるため、毎回シート全読みを避ける）

var _configCache = null;

function loadConfigMap_() {
  if (_configCache) return _configCache;
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(CONFIG_SHEET);
  var values = sheet.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < values.length; i++) {
    var k = values[i][0];
    if (k !== '' && k !== null && k !== undefined) map[k] = String(values[i][1]);
  }
  _configCache = map;
  return map;
}

function getConfig(key) {
  var map = loadConfigMap_();
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
}

function setConfig(key, value) {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(CONFIG_SHEET);
  var values = sheet.getDataRange().getValues();
  _configCache = null; // 次回読み直し
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

// ---- 監査ログ ----
// 列: Timestamp(JST) | Action | Detail | TokenHash | Role
// 共通パスワード運用のため個人特定はできないが、操作種別・対象・ロール・トークン識別子を残す。

function appendAuditLog(action, detail, token, role) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(AUDIT_LOG_SHEET);
    if (!sheet) return;
    var tokenHash = token ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)
      .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 12) : '';
    var ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss");
    sheet.appendRow([ts, action, detail, tokenHash, role || '']);
  } catch (e) {
    Logger.log('AuditLog write failed: ' + e);
  }
}

/**
 * 監査ログを直近 keepDays 日分に間引く（古い行を削除）。
 * installTriggers() で毎月実行される。手動実行も可。
 */
function trimAuditLog(keepDays) {
  keepDays = keepDays || 365;
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(AUDIT_LOG_SHEET);
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  var cutoffStr = Utilities.formatDate(cutoff, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss");
  var timestamps = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  // 上から連続する古い行をまとめて削除（ログは時系列で追記される前提）
  var deleteCount = 0;
  for (var i = 0; i < timestamps.length; i++) {
    if (String(timestamps[i][0]) < cutoffStr) deleteCount++;
    else break;
  }
  if (deleteCount > 0) {
    sheet.deleteRows(2, deleteCount);
    Logger.log('trimAuditLog: removed ' + deleteCount + ' rows older than ' + cutoffStr);
  }
}

// ====== スキーマ駆動リソースレジストリ ======
// 新しいリソース追加時はここに1エントリ足すだけでCRUD全対応
const RESOURCE_REGISTRY = {
  events:      { sheet: EVENTS_SHEET,      idPrefix: 'ev_', jsonFields: ['PartsList', 'Files'], timeFields: ['TimeStart', 'TimeEnd'] },
  members:     { sheet: MEMBERS_SHEET,     idPrefix: 'mb_', jsonFields: [], timeFields: [] },
  experiments: { sheet: EXPERIMENTS_SHEET, idPrefix: 'ex_', jsonFields: [], timeFields: [] }
};

function getResourceDef(resource) {
  const def = RESOURCE_REGISTRY[resource];
  if (!def) throw new Error('unknown resource: ' + resource);
  return def;
}

function getSheetName(resource) { return getResourceDef(resource).sheet; }
function getJsonFields(resource) { return getResourceDef(resource).jsonFields; }
function getIdPrefix(resource) { return getResourceDef(resource).idPrefix; }
function getTimeFields(resource) { return getResourceDef(resource).timeFields || []; }

// ====== 汎用CRUD ======

function listResource(resource) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(getSheetName(resource));
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rawHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const headers = rawHeaders.map(h => String(h || '').trim());
  const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const jsonFields = getJsonFields(resource);
  const timeFields = getTimeFields(resource);
  return rows
    .filter(r => r[0])
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        if (!h) return;
        let val = r[i];
        if (val instanceof Date) {
          // 時刻列（TimeStart/TimeEnd）はシート側で時刻書式になっていても HH:mm を維持する
          val = (timeFields.indexOf(h) >= 0)
            ? Utilities.formatDate(val, 'Asia/Tokyo', 'HH:mm')
            : Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
        } else if (typeof val === 'boolean') {
          val = String(val);
        }
        obj[h] = val === '' || val === null || val === undefined ? '' : String(val);
      });
      jsonFields.forEach(f => {
        if (obj[f]) {
          try { obj[f] = JSON.parse(obj[f]); } catch (_) { obj[f] = []; }
        } else {
          obj[f] = [];
        }
      });
      return obj;
    });
}

// listResource と同じ規則でセル値を文字列化する（競合検知の版比較用）。
function cellToCompareStr_(val) {
  if (val instanceof Date) return Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
  if (typeof val === 'boolean') return String(val);
  return (val === '' || val === null || val === undefined) ? '' : String(val);
}

function saveResource(resource, item) {
  // LockService で同時書き込みの競合を防ぐ
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (_) {
    throw new Error('他のユーザーが保存中です。数秒後にもう一度お試しください。');
  }

  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(getSheetName(resource));
    if (!sheet) throw new Error('sheet not found: ' + resource);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const jsonFields = getJsonFields(resource);
    const now = new Date().toISOString();

    // 先に既存行を特定する（CreatedAt の保持判定に使う）
    const lastRow = sheet.getLastRow();
    let existingRow = -1;
    if (lastRow >= 2 && item.ID) {
      const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (ids[i][0] === item.ID) { existingRow = i + 2; break; }
      }
    }

    // 楽観的競合検知：クライアントが編集開始時に読んだ版(_baseUpdatedAt)と
    // 現在のシート上の UpdatedAt が食い違えば、別の人が先に更新したとみなして拒否する。
    if (existingRow > 0 && item._baseUpdatedAt !== undefined && item._baseUpdatedAt !== null && item._baseUpdatedAt !== '') {
      const updatedAtCol = headers.indexOf('UpdatedAt');
      if (updatedAtCol >= 0) {
        const curUpdated = sheet.getRange(existingRow, updatedAtCol + 1).getValue();
        if (cellToCompareStr_(curUpdated) !== String(item._baseUpdatedAt)) {
          throw new Error('conflict');
        }
      }
    }

    const createdAtCol = headers.indexOf('CreatedAt');

    if (!item.ID) {
      item.ID = getIdPrefix(resource) + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      if (createdAtCol >= 0) item.CreatedAt = now;
    } else if (existingRow > 0 && createdAtCol >= 0) {
      // 更新時：クライアントが CreatedAt を送ってこなくても既存値を消さない
      if (item.CreatedAt === undefined || item.CreatedAt === null || item.CreatedAt === '') {
        const existingCreated = sheet.getRange(existingRow, createdAtCol + 1).getValue();
        if (existingCreated !== '' && existingCreated !== null && existingCreated !== undefined) {
          item.CreatedAt = (existingCreated instanceof Date) ? existingCreated.toISOString() : existingCreated;
        }
      }
    }
    if (headers.indexOf('UpdatedAt') >= 0) item.UpdatedAt = now;

    const rowData = headers.map(h => {
      let val = item[h];
      if (val === undefined || val === null) return '';
      if (jsonFields.indexOf(h) >= 0 && typeof val !== 'string') {
        return JSON.stringify(val);
      }
      return val;
    });

    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, headers.length).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

    const returned = {};
    headers.forEach((h, i) => { returned[h] = rowData[i]; });
    jsonFields.forEach(f => {
      if (returned[f] && typeof returned[f] === 'string') {
        try { returned[f] = JSON.parse(returned[f]); } catch (_) { returned[f] = []; }
      }
    });
    return returned;
  } finally {
    lock.releaseLock();
  }
}

function deleteResource(resource, id) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (_) {
    throw new Error('他のユーザーが操作中です。数秒後にもう一度お試しください。');
  }
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(getSheetName(resource));
    if (!sheet) return false;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return false;
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i][0] === id) {
        sheet.deleteRow(i + 2);
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

// ====== 初期セットアップ ======

const EVENTS_HEADERS = [
  'ID', 'Date', 'DateEnd', 'Title', 'Category', 'Location', 'Audience',
  'TimeStart', 'TimeEnd', 'MeetingNumber', 'PartsList',
  'AdminKyoka', 'AdminHoukoku', 'KyokaDeadline', 'HoukokuDeadline',
  'Logistics', 'Remarks', 'Files', 'Belongings',
  'SeriesKey', 'Positives', 'Reflections',
  'CreatedAt', 'UpdatedAt', 'UpdatedBy'
];
const MEMBERS_HEADERS = [
  'ID', 'Name', 'Category', 'Role', 'StudentID', 'Affiliation',
  'Email', 'Note', 'FiscalYear', 'Active',
  'CreatedAt', 'UpdatedAt'
];
const EXPERIMENTS_HEADERS = [
  'ID', 'Name', 'Category', 'Materials', 'Preparation', 'Flow', 'Notes',
  'SlidesURL', 'Reflections', 'Positives', 'Active', 'CreatedAt', 'UpdatedAt'
];

function setupSpreadsheet() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    ensureSheet(ss, EVENTS_SHEET, EVENTS_HEADERS);
    ensureSheet(ss, MEMBERS_SHEET, MEMBERS_HEADERS);
    ensureSheet(ss, EXPERIMENTS_SHEET, EXPERIMENTS_HEADERS);
    ensureConfigSheet(ss);
    ensureAuditLogSheet(ss);
    SpreadsheetApp.flush();
    Logger.log('Setup complete.');
    Logger.log('Password: ' + getConfig('password'));
    Logger.log('Admin Password: ' + getConfig('admin_password'));
    Logger.log('シート作成・ヘッダー確認が完了しました。');
  } catch (err) {
    Logger.log('SETUP ERROR: ' + err + '\n' + err.stack);
    throw err;
  }
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    Logger.log('Created sheet: ' + name);
  }
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#464775')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    Logger.log('Added headers to: ' + name + ' (' + headers.length + ' columns)');
  } else {
    const currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const missing = headers.filter(h => currentHeaders.indexOf(h) < 0);
    if (missing.length > 0) {
      const startCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
      sheet.getRange(1, startCol, 1, missing.length)
        .setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
      Logger.log('Added missing columns to ' + name + ': ' + missing.join(', '));
    }
  }
  return sheet;
}

function ensureConfigSheet(ss) {
  let config = ss.getSheetByName(CONFIG_SHEET);
  if (!config) config = ss.insertSheet(CONFIG_SHEET);
  if (config.getLastRow() === 0) {
    const rows = [
      ['Key', 'Value'],
      ['password', 'CHANGE_ME_' + Math.random().toString(36).slice(2, 8)],
      ['admin_password', 'ADMIN_' + Math.random().toString(36).slice(2, 10)],
      ['gemini_api_key', ''],
      ['storage_warn_mb', 60],
      ['storage_block_mb', 100],
      ['file_max_mb', 10],
      ['file_sharing', 'domain'],
      ['file_retention_years', 5],
      ['reminder_enabled', 'true'],
      ['reminder_days', '7,3,1'],
      ['report_recipients', ''],
      ['annual_report_enabled', 'true'],
      ['backup_keep_count', 6],
      ['audit_keep_days', 365]
    ];
    config.getRange(1, 1, rows.length, 2).setValues(rows);
    config.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    config.setFrozenRows(1);
    Logger.log('Created Config sheet with default passwords');
  } else {
    // 既存のConfigシートに不足キーを追加（マイグレーション）
    const values = config.getDataRange().getValues();
    const existingKeys = values.map(function(r) { return r[0]; });
    const addIfMissing = function(key, defVal) {
      if (existingKeys.indexOf(key) < 0) {
        config.appendRow([key, defVal]);
        Logger.log('Added ' + key + ' to Config');
      }
    };
    addIfMissing('admin_password', 'ADMIN_' + Math.random().toString(36).slice(2, 10));
    addIfMissing('gemini_api_key', '');
    addIfMissing('file_max_mb', 10);
    addIfMissing('file_sharing', 'domain');
    addIfMissing('annual_report_enabled', 'true');
    addIfMissing('backup_keep_count', 6);
    addIfMissing('audit_keep_days', 365);
  }
}

function ensureAuditLogSheet(ss) {
  const HEADERS = ['Timestamp', 'Action', 'Detail', 'TokenHash', 'Role'];
  let sheet = ss.getSheetByName(AUDIT_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(AUDIT_LOG_SHEET);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    Logger.log('Created AuditLog sheet');
  } else if (sheet.getLastColumn() < HEADERS.length) {
    // 既存の4列シートに Role 列を追加（マイグレーション）
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    Logger.log('Migrated AuditLog sheet to ' + HEADERS.length + ' columns');
  }
  return sheet;
}

// ====================================================================
// Phase 2: ファイルアップロード (Google Drive) + 5年自動削除
// ====================================================================

const DRIVE_FOLDER_NAME = 'SciComi_Portal_Files';

function getUploadFolder() {
  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(DRIVE_FOLDER_NAME);
}

/**
 * アップロードファイルの共有設定を適用する。
 * Config の file_sharing で制御:
 *   'domain' (既定) … 同一 Google Workspace ドメイン内でリンクを知る人のみ閲覧可（推奨・より安全）
 *   'anyone'         … リンクを知る全員が閲覧可（消費者向け Gmail 等、ドメインが無い場合）
 * ドメイン共有が不可能なアカウント（個人 Gmail 等）では自動的に 'anyone' にフォールバックする。
 */
function applyFileSharing_(file) {
  const mode = (getConfig('file_sharing') || 'domain').toLowerCase();
  if (mode === 'anyone') {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return;
  }
  try {
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('DOMAIN_WITH_LINK 共有に失敗（個人アカウント等）。ANYONE_WITH_LINK にフォールバック: ' + e);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
}

function uploadFileToDrive(fileData) {
  if (!fileData || !fileData.base64 || !fileData.name) {
    throw new Error('ファイルデータが不正です');
  }

  const decoded = Utilities.base64Decode(fileData.base64);
  const sizeMB = decoded.length / (1024 * 1024);
  // クライアント(config.js FILE_UPLOAD.maxSizeMB)と同じ上限をサーバーでも強制する
  const maxMB = parseInt(getConfig('file_max_mb')) || 10;

  if (sizeMB > maxMB) {
    throw new Error('ファイルサイズが上限(' + maxMB + 'MB)を超えています');
  }

  const blob = Utilities.newBlob(decoded, fileData.mimeType || 'application/octet-stream', fileData.name);
  const folder = getUploadFolder();
  const file = folder.createFile(blob);
  applyFileSharing_(file);

  return {
    name: fileData.name,
    url: file.getUrl(),
    driveId: file.getId(),
    size: decoded.length,
    uploadedAt: new Date().toISOString()
  };
}

function deleteFileFromDrive(driveId) {
  if (!driveId) return false;
  try {
    DriveApp.getFileById(driveId).setTrashed(true);
    return true;
  } catch (e) {
    Logger.log('File delete failed (' + driveId + '): ' + e);
    return false;
  }
}

/**
 * 保持期限を過ぎた Drive ファイルをゴミ箱に移動。
 * installTriggers() で毎月1日に自動実行される。
 */
function cleanupOldFiles() {
  const retentionYears = parseInt(getConfig('file_retention_years')) || 5;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - retentionYears);

  var folder;
  try { folder = getUploadFolder(); } catch (e) {
    Logger.log('Upload folder not found, nothing to clean up');
    return;
  }

  var files = folder.getFiles();
  var count = 0;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getDateCreated() < cutoff) {
      f.setTrashed(true);
      count++;
    }
  }
  Logger.log('cleanupOldFiles: ' + count + ' files trashed (retention=' + retentionYears + 'y)');
  if (count > 0) appendAuditLog('cleanupOldFiles', count + ' files trashed (retention=' + retentionYears + 'y)', '');
}

/**
 * どのイベントからも参照されていない「孤児」ファイルをゴミ箱へ移動する。
 * イベント行を削除しても Drive ファイルは残るため、それらを回収する。
 * 削除UNDO（再作成）との競合を避けるため、アップロードから30日経過したものだけを対象にする。
 * installTriggers() で毎月実行される。
 */
function cleanupOrphanedFiles() {
  var folder;
  try { folder = getUploadFolder(); } catch (e) {
    Logger.log('Upload folder not found, nothing to clean up');
    return;
  }

  // 全イベントが参照している driveId を集める
  var referenced = {};
  listResource('events').forEach(function (ev) {
    var fs = ev.Files;
    if (typeof fs === 'string') { try { fs = JSON.parse(fs); } catch (_) { fs = []; } }
    (fs || []).forEach(function (f) {
      if (f && f.driveId) referenced[f.driveId] = true;
    });
  });

  var grace = new Date();
  grace.setDate(grace.getDate() - 30); // 30日の猶予（UNDOや一時的な未参照を考慮）

  var files = folder.getFiles();
  var count = 0;
  while (files.hasNext()) {
    var file = files.next();
    if (!referenced[file.getId()] && file.getDateCreated() < grace) {
      file.setTrashed(true);
      count++;
    }
  }
  Logger.log('cleanupOrphanedFiles: ' + count + ' orphaned files trashed');
  if (count > 0) appendAuditLog('cleanupOrphanedFiles', count + ' orphaned files trashed', '');
}

/**
 * スプレッドシート全体を日付入りファイル名で複製してバックアップする。
 * 古いバックアップは keepCount 個まで保持し、それ以前のものはゴミ箱へ。
 * installTriggers() で毎月実行される。手動実行も可。
 */
function backupSpreadsheet() {
  var keepCount = parseInt(getConfig('backup_keep_count')) || 6;
  var src = DriveApp.getFileById(SHEET_ID);
  var folderName = 'SciComi_Portal_Backups';
  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  src.makeCopy('SciComi_Portal_DB_backup_' + stamp, folder);
  Logger.log('backupSpreadsheet: created backup ' + stamp);

  // 古いバックアップを間引く（作成日昇順で keepCount 個を超えた分をゴミ箱へ）
  var backups = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf('SciComi_Portal_DB_backup_') === 0) {
      backups.push(f);
    }
  }
  backups.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
  while (backups.length > keepCount) {
    var old = backups.shift();
    old.setTrashed(true);
    Logger.log('backupSpreadsheet: trashed old backup ' + old.getName());
  }
  appendAuditLog('backupSpreadsheet', 'backup_' + stamp + ' (keep=' + keepCount + ')', '');
}

// ====================================================================
// Phase 5: Gemini API プロキシ
// ====================================================================

/**
 * Bot 用システムプロンプトをサーバー側で生成する。
 * （以前は bot.js が生成して送っていたが、API キー悪用防止のためサーバーに固定）
 */
function buildBotSystemPrompt_() {
  var tz = 'Asia/Tokyo';
  var now = new Date();
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var m = now.getMonth() + 1;
  var fy = m >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  var nmStart = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 1), tz, 'yyyy-MM-dd');
  var nmEnd = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() + 2, 0), tz, 'yyyy-MM-dd');

  return `あなたはSciComi Portal（サイエンスコミュニケーターサークルのポータル）のデータ検索アシスタントです。
ユーザーの質問を分析し、JSON形式の検索クエリに変換してください。
※個人情報は一切送信されません。質問文のみが送られます。

## データスキーマ

### events（イベント）
- Date: 開催日(YYYY-MM-DD), DateEnd: 終了日
- Title: イベント名
- Category: normal(イベント), other(その他), general(全体MTG), admin(幹部MTG)
- Location: 場所, Audience: 対象者
- AdminKyoka: 許可願の担当者名（人名）
- AdminHoukoku: 報告書の担当者名（人名）
- KyokaDeadline: 許可願期限(YYYY-MM-DD), HoukokuDeadline: 報告書期限
- PartsList: 部ごとの実験・担当者リスト JSON配列
  形式: [{"partName":"一部","items":[{"name":"実験名","presenter":"担当者名"}]}]
- Positives: 良かった点, Reflections: 反省点
- Remarks: 備考, Belongings: 持ち物

### members（メンバー）
- Name: 氏名
- Category: adviser(アドバイザー), coordinator(コーディネーター), member(メンバー)
- Role: 役職（例: プロジェクトリーダー）
- StudentID: 学籍番号。先頭2文字が学年コース（例: 4C, 5C, 6C）
- Active: "true"=在籍, "false"=卒業
- FiscalYear: 登録年度
- Note: メモ

### experiments（実験ネタ）
- Name: 実験名
- Category: workshop(工作), show(実験ショー), other(その他)
- Materials: 使用物品, Preparation: 事前準備
- Flow: 発表の流れ, Notes: 注意事項
- SlidesURL: スライドURL, Active: 有効フラグ

## 今日: ${today} / 年度: ${fy}年度（${fy}年4月〜${fy + 1}年3月）

## 書類の判定ルール
「書類を書いた」= イベントのAdminKyoka or AdminHoukokuにその人の名前がある
「書類を書いていない」= どのイベントにも名前がない

## 参加の判定ルール
「イベントに参加した」= PartsList内のitemsのpresenterにその人の名前がある

## 返答JSON形式（必ずこの形式のJSONのみ返す）

{
  "intent": "find_members|find_events|find_experiments|members_docs|member_activity|upcoming|count|general|unknown",
  "params": {
    "name": "人名（部分一致検索用）",
    "grade": "学年コード（例:6C）",
    "member_category": "adviser|coordinator|member",
    "event_category": "normal|other|general|admin",
    "exp_category": "workshop|show|other",
    "date_from": "YYYY-MM-DD",
    "date_to": "YYYY-MM-DD",
    "keyword": "自由キーワード",
    "active_only": true,
    "doc_type": "kyoka|houkoku|both",
    "include_in": "parts|admin|both",
    "fiscal_year": ${fy}
  },
  "response_text": "検索内容を説明する日本語文（結果の前に表示される）"
}

paramsは必要なものだけ含めてください。不要なものは省略。

## 例

Q: 「6Cで最近書類を書いていないメンバーは？」
A: {"intent":"members_docs","params":{"grade":"6C","doc_type":"both","active_only":true},"response_text":"6Cで書類（許可願・報告書）を担当していないメンバーを検索します。"}

Q: 「来月のイベント」
A: {"intent":"find_events","params":{"date_from":"${nmStart}","date_to":"${nmEnd}"},"response_text":"来月のイベント一覧です。"}

Q: 「田中さんが参加したイベント」
A: {"intent":"member_activity","params":{"name":"田中","include_in":"both"},"response_text":"田中さんが関わったイベントを検索します。"}

Q: 「次のミーティングはいつ？」
A: {"intent":"find_events","params":{"event_category":"general","date_from":"${today}"},"response_text":"次の全体ミーティングを検索します。"}

Q: 「工作の実験ネタ」
A: {"intent":"find_experiments","params":{"exp_category":"workshop"},"response_text":"工作カテゴリの実験ネタ一覧です。"}

Q: 「こんにちは」
A: {"intent":"general","params":{},"response_text":"こんにちは！イベント・メンバー・実験に関する質問をどうぞ。\\n\\n例:\\n・来月のイベントは？\\n・6Cで書類を書いていないメンバーは？\\n・工作の実験ネタを教えて\\n・田中さんの参加イベント"}

Q: 「天気教えて」
A: {"intent":"unknown","params":{},"response_text":"すみません、サークルのデータ（イベント・メンバー・実験）に関する質問にお答えできます。"}`;
}

// Gemini 日次使用量（ScriptProperties 永続）。{date, count} を保持し、日付が変われば 0 にリセット。
function geminiUsageGet_(today) {
  var raw = PropertiesService.getScriptProperties().getProperty('gemini_usage');
  if (raw) {
    try {
      var o = JSON.parse(raw);
      if (o && o.date === today) return parseInt(o.count, 10) || 0;
    } catch (_) {}
  }
  return 0;
}

function geminiUsageInc_(today) {
  var props = PropertiesService.getScriptProperties();
  var cur = geminiUsageGet_(today);
  var next = cur + 1;
  props.setProperty('gemini_usage', JSON.stringify({ date: today, count: next }));
  return next;
}

function handleGeminiProxy(body) {
  var apiKey = getConfig('gemini_api_key');
  if (!apiKey) {
    return jsonResponse({ success: false, error: 'gemini_key_not_configured' });
  }

  var message = body.message || '';
  if (!message) {
    return jsonResponse({ success: false, error: 'empty_message' });
  }
  if (message.length > 2000) {
    message = message.slice(0, 2000); // 過大入力を切り詰め（コスト・悪用対策）
  }

  // システムプロンプトはサーバー側で固定生成する。
  // クライアントから渡された systemPrompt は信用しない（API キーの汎用 LLM 化を防止）。
  var systemPrompt = buildBotSystemPrompt_();

  var cache = CacheService.getScriptCache();

  // セッション単位の毎分レート制限（1セッションが全体枠を使い切るのを防ぐ）
  var th = body.token ? hmacHex_(body.token).slice(0, 16) : 'anon';
  var rlKey = 'gemini_rl_' + th + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmm');
  var rlCount = (parseInt(cache.get(rlKey), 10) || 0) + 1;
  cache.put(rlKey, String(rlCount), 120);
  if (rlCount > 20) {
    return jsonResponse({ success: false, error: 'RATE_LIMIT' });
  }

  // 日次使用量チェック（全体枠）。
  // CacheService は揮発するとカウンタが 0 に戻り上限が機能しなくなるため、
  // ScriptProperties（永続）に {date, count} で保持する。
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var usage = geminiUsageGet_(today);
  if (usage >= GEMINI_DAILY_LIMIT) {
    return jsonResponse({ success: false, error: 'DAILY_LIMIT', usage: usage, limit: GEMINI_DAILY_LIMIT });
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  var payload = {
    contents: [{ role: 'user', parts: [{ text: message }] }],
    generationConfig: { responseMimeType: 'application/json' }
  };
  if (systemPrompt) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  var maxRetries = 2;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      var code = res.getResponseCode();
      if (code === 200) {
        var newUsage = geminiUsageInc_(today);
        var data = JSON.parse(res.getContentText());
        return jsonResponse({ success: true, data: data, usage: newUsage, limit: GEMINI_DAILY_LIMIT });
      }

      if (code === 429 && attempt < maxRetries) {
        Utilities.sleep(1200 * Math.pow(2, attempt));
        continue;
      }

      var errText = res.getContentText().slice(0, 500);
      if (code === 400 && errText.indexOf('API_KEY_INVALID') >= 0) {
        return jsonResponse({ success: false, error: 'API_KEY_INVALID' });
      }
      if (code === 429) {
        return jsonResponse({ success: false, error: 'RATE_LIMIT' });
      }
      return jsonResponse({ success: false, error: 'API_ERROR_' + code });
    } catch (e) {
      if (attempt < maxRetries) {
        Utilities.sleep(1200 * Math.pow(2, attempt));
        continue;
      }
      return jsonResponse({ success: false, error: 'NETWORK_ERROR' });
    }
  }
  return jsonResponse({ success: false, error: 'NETWORK_ERROR' });
}

// ====================================================================
// Phase 4: 期限リマインダーメール
// ====================================================================

/**
 * 毎日実行される期限リマインダー。
 * 各期限(許可願/報告書)に対し、Config の reminder_days で指定した日数前に
 * 担当者(名前からメンバーのメールを逆引き) + 全コーディネーター/アドバイザーにメール通知する。
 *
 * 使い方: installTriggers() を1回実行するだけ。
 */
function sendDeadlineReminders() {
  if (getConfig('reminder_enabled') !== 'true') {
    Logger.log('Reminders are disabled');
    return;
  }

  // トリガーの二重発火による多重送信を防ぐ。
  // ※ saveResource と同じグローバルなスクリプトロックは使わない
  //    （メール送信中に保存処理をブロックしないため）。CacheService の短期ガードで十分。
  const cache = CacheService.getScriptCache();
  if (cache.get('reminders_running')) {
    Logger.log('sendDeadlineReminders: already running, skip');
    return;
  }
  cache.put('reminders_running', '1', 600); // 10分ガード
  try {
    sendDeadlineRemindersImpl_();
  } finally {
    cache.remove('reminders_running');
  }
}

function sendDeadlineRemindersImpl_() {
  const reminderDaysStr = getConfig('reminder_days') || '7,3,1';
  const reminderDays = reminderDaysStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

  const events = listResource('events');
  const members = listResource('members');
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const todayDate = parseDateLocal(today);

  // アドバイザー/コーディネーターのメールを収集（CC用）
  const staffEmails = members
    .filter(m => (m.Category === 'adviser' || m.Category === 'coordinator') && m.Email && m.Active !== 'false')
    .map(m => m.Email);

  const notifications = [];

  events.forEach(ev => {
    // ミーティング系（全体MTG/幹部MTG）には書類期限が無いのでスキップ
    if (ev.Category === 'general' || ev.Category === 'admin') return;
    checkDeadline(ev, 'KyokaDeadline', '許可願', ev.AdminKyoka, todayDate, reminderDays, members, notifications);
    checkDeadline(ev, 'HoukokuDeadline', '報告書', ev.AdminHoukoku, todayDate, reminderDays, members, notifications);
  });

  if (notifications.length === 0) {
    Logger.log('No reminders to send today');
    return;
  }

  // 担当者別にグループ化
  const grouped = {};
  notifications.forEach(n => {
    const key = n.recipientEmail || 'staff';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(n);
  });

  const prefix = '[SciComi]';

  Object.keys(grouped).forEach(email => {
    const items = grouped[email];
    const subject = prefix + ' 期限リマインダー (' + items.length + '件)';
    const body = buildReminderHtml(items);

    const to = email !== 'staff' ? email : staffEmails.join(',');
    if (!to) {
      Logger.log('No recipients for: ' + JSON.stringify(items.map(i => i.summary)));
      appendAuditLog('reminder_no_recipient', items.map(i => i.summary).join(' / '), '');
      return;
    }

    const textBody = items.map(i =>
      '・[' + i.deadlineType + '] ' + i.eventTitle + '（' + i.eventDate + '）期限 ' + i.deadlineDate + ' / あと' + i.daysUntil + '日 / 担当: ' + i.adminName
    ).join('\n') + '\n\n— SciComi Portal 自動送信';

    try {
      MailApp.sendEmail({
        to: to,
        cc: email !== 'staff' ? staffEmails.filter(e => e !== email).join(',') : '',
        subject: subject,
        htmlBody: body,
        body: textBody  // HTML非対応クライアント用の代替テキスト（スパム判定対策にもなる）
      });
      Logger.log('Sent reminder to ' + to + ': ' + items.length + ' items');
    } catch (err) {
      Logger.log('Failed to send to ' + to + ': ' + err);
      appendAuditLog('reminder_send_fail', to + ': ' + err, '');
    }
  });
}

function checkDeadline(event, field, typeName, adminName, todayDate, reminderDays, members, out) {
  const deadlineStr = event[field];
  if (!deadlineStr) return;

  const deadlineDate = parseDateLocal(deadlineStr);
  if (!deadlineDate) return;

  const daysUntil = Math.round((deadlineDate - todayDate) / (1000 * 60 * 60 * 24));
  if (reminderDays.indexOf(daysUntil) < 0) return;

  // 担当者名からメール逆引き
  let recipientEmail = '';
  if (adminName) {
    const member = members.find(m => m.Name === adminName && m.Email);
    if (member) recipientEmail = member.Email;
  }

  out.push({
    eventTitle: event.Title || '(無題)',
    eventDate: event.Date,
    deadlineType: typeName,
    deadlineDate: deadlineStr,
    daysUntil: daysUntil,
    adminName: adminName || '未定',
    recipientEmail: recipientEmail,
    summary: typeName + ': ' + event.Title + ' (あと' + daysUntil + '日)'
  });
}

function buildReminderHtml(items) {
  let rows = items.map(n => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">${n.deadlineType}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">${n.eventTitle}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${n.eventDate}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${n.deadlineDate}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:${n.daysUntil <= 3 ? '#c92a2a' : '#92400e'};font-weight:bold;">あと${n.daysUntil}日</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${n.adminName}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family:'Segoe UI','Noto Sans JP',sans-serif;max-width:700px;margin:0 auto;">
      <div style="background:#464775;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:1.2rem;">SciComi Portal - 期限リマインダー</h2>
      </div>
      <div style="background:white;padding:20px 24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
        <p>以下の書類期限が近づいています。</p>
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
          <thead>
            <tr style="background:#f8f9fa;">
              <th style="padding:8px;text-align:left;">種類</th>
              <th style="padding:8px;text-align:left;">イベント</th>
              <th style="padding:8px;text-align:left;">開催日</th>
              <th style="padding:8px;text-align:left;">期限</th>
              <th style="padding:8px;text-align:left;">残り</th>
              <th style="padding:8px;text-align:left;">担当</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;font-size:0.85rem;color:#888;">
          このメールは SciComi Portal から自動送信されています。
        </p>
      </div>
    </div>
  `;
}

// ====================================================================
// Phase 4: 年間レポート自動生成
// ====================================================================

/**
 * 指定年度（4月〜翌3月）の年間活動レポートを生成し、メール送信する。
 * @param {number} fiscalYear - 年度（例: 2026 → 2026年4月〜2027年3月）
 *
 * 使い方:
 *   GASエディタで generateAnnualReport(2026) を実行
 *   または年度末にトリガー設定
 */
function generateAnnualReport(fiscalYear) {
  if (!fiscalYear) {
    const now = new Date();
    const month = now.getMonth() + 1;
    fiscalYear = month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  }

  const startDate = fiscalYear + '-04-01';
  const endDate = (fiscalYear + 1) + '-03-31';

  const events = listResource('events');
  const members = listResource('members');
  const experiments = listResource('experiments');

  // 対象イベント
  const yearEvents = events.filter(ev => ev.Date >= startDate && ev.Date <= endDate);

  // カテゴリ別集計
  const catCounts = {};
  yearEvents.forEach(ev => {
    const cat = ev.Category || 'normal';
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  });

  // 使用された実験名を集計
  const expUsage = {};
  yearEvents.forEach(ev => {
    if (!ev.PartsList) return;
    let parts = ev.PartsList;
    if (typeof parts === 'string') {
      try { parts = JSON.parse(parts); } catch (_) { return; }
    }
    (parts || []).forEach(p => {
      (p.items || []).forEach(item => {
        if (item.name) {
          expUsage[item.name] = (expUsage[item.name] || 0) + 1;
        }
      });
    });
  });

  const expRanking = Object.entries(expUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  // メンバー統計
  const activeMembers = members.filter(m => m.Active !== 'false');
  const advisers = activeMembers.filter(m => m.Category === 'adviser').length;
  const coordinators = activeMembers.filter(m => m.Category === 'coordinator').length;
  const regulars = activeMembers.filter(m => m.Category === 'member').length;

  // HTML生成
  // ラベルはフロント config.js の EVENT_CATEGORIES と一致させる
  const catLabels = {
    normal: 'イベント', other: 'その他',
    general: '全体ミーティング', admin: '幹部ミーティング'
  };

  const catRows = Object.entries(catCounts)
    .map(([k, v]) => `<tr><td style="padding:6px 12px;">${catLabels[k] || k}</td><td style="padding:6px 12px;font-weight:bold;">${v}回</td></tr>`)
    .join('');

  const expRows = expRanking
    .map(([name, count]) => `<tr><td style="padding:6px 12px;">${name}</td><td style="padding:6px 12px;font-weight:bold;">${count}回</td></tr>`)
    .join('');

  const html = `
    <div style="font-family:'Segoe UI','Noto Sans JP',sans-serif;max-width:700px;margin:0 auto;">
      <div style="background:#464775;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">SciComi Portal 年間レポート</h2>
        <p style="margin:4px 0 0;opacity:0.9;">${fiscalYear}年度（${fiscalYear}/4 - ${fiscalYear + 1}/3）</p>
      </div>
      <div style="background:white;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">

        <h3 style="color:#464775;border-bottom:2px solid #eee;padding-bottom:6px;">概要</h3>
        <table style="border-collapse:collapse;margin-bottom:20px;">
          <tr><td style="padding:6px 12px;color:#666;">イベント総数</td><td style="padding:6px 12px;font-weight:bold;">${yearEvents.length}回</td></tr>
          <tr><td style="padding:6px 12px;color:#666;">登録実験</td><td style="padding:6px 12px;font-weight:bold;">${experiments.length}種類</td></tr>
          <tr><td style="padding:6px 12px;color:#666;">在籍メンバー</td><td style="padding:6px 12px;font-weight:bold;">${activeMembers.length}名（アドバイザー${advisers} / コーディネーター${coordinators} / メンバー${regulars}）</td></tr>
        </table>

        <h3 style="color:#464775;border-bottom:2px solid #eee;padding-bottom:6px;">カテゴリ別イベント数</h3>
        <table style="border-collapse:collapse;margin-bottom:20px;">${catRows || '<tr><td style="padding:6px 12px;">データなし</td></tr>'}</table>

        <h3 style="color:#464775;border-bottom:2px solid #eee;padding-bottom:6px;">実験使用ランキング</h3>
        <table style="border-collapse:collapse;margin-bottom:20px;">${expRows || '<tr><td style="padding:6px 12px;">データなし</td></tr>'}</table>

        <h3 style="color:#464775;border-bottom:2px solid #eee;padding-bottom:6px;">イベント一覧</h3>
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <thead><tr style="background:#f8f9fa;">
            <th style="padding:6px 8px;text-align:left;">日付</th>
            <th style="padding:6px 8px;text-align:left;">カテゴリ</th>
            <th style="padding:6px 8px;text-align:left;">タイトル</th>
            <th style="padding:6px 8px;text-align:left;">場所</th>
          </tr></thead>
          <tbody>${yearEvents.sort((a, b) => (a.Date || '').localeCompare(b.Date || '')).map(ev => `
            <tr>
              <td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;">${ev.Date}</td>
              <td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;">${catLabels[ev.Category] || ev.Category}</td>
              <td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;">${ev.Title}</td>
              <td style="padding:4px 8px;border-bottom:1px solid #f0f0f0;">${ev.Location || ''}</td>
            </tr>
          `).join('')}</tbody>
        </table>

        <p style="margin-top:20px;font-size:0.85rem;color:#888;">
          このレポートは SciComi Portal から自動生成されました。
        </p>
      </div>
    </div>
  `;

  // 送信先: Config の report_recipients（カンマ区切り）、または全コーディネーター/アドバイザー
  let recipients = getConfig('report_recipients');
  if (!recipients) {
    recipients = members
      .filter(m => (m.Category === 'adviser' || m.Category === 'coordinator') && m.Email && m.Active !== 'false')
      .map(m => m.Email)
      .join(',');
  }

  if (recipients) {
    const textBody = fiscalYear + '年度 年間活動レポート\n'
      + 'イベント総数: ' + yearEvents.length + '回 / 登録実験: ' + experiments.length + '種類 / '
      + '在籍メンバー: ' + activeMembers.length + '名\n'
      + '（詳細はHTML版をご覧ください）\n\n— SciComi Portal 自動送信';
    MailApp.sendEmail({
      to: recipients,
      subject: '[SciComi] ' + fiscalYear + '年度 年間活動レポート',
      htmlBody: html,
      body: textBody
    });
    Logger.log('Annual report sent to: ' + recipients);
  } else {
    Logger.log('No recipients configured. Report generated but not sent.');
    Logger.log('HTML preview:\n' + html.slice(0, 500));
  }

  return html;
}

// ====== ユーティリティ ======

function parseDateLocal(str) {
  if (!str) return null;
  const parts = String(str).split('-');
  if (parts.length < 3) return null;
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
}

// ====== トリガー設置 ======

/**
 * 1回だけ実行すれば OK。
 * - 毎朝8時にリマインダーメールを送信するトリガーを設置する。
 * - 重複設置を防ぐため、既存の同名トリガーは削除してから再設置する。
 */
function installTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  const managed = [
    'sendDeadlineReminders', 'cleanupOldFiles', 'scheduledAnnualReport',
    'cleanupOrphanedFiles', 'backupSpreadsheet', 'monthlyMaintenance'
  ];

  // 既存トリガーを削除（重複防止）
  triggers.forEach(t => {
    const fn = t.getHandlerFunction();
    if (managed.indexOf(fn) >= 0) {
      ScriptApp.deleteTrigger(t);
      Logger.log('Deleted existing trigger: ' + fn);
    }
  });

  // 毎日午前8時: リマインダーメール
  ScriptApp.newTrigger('sendDeadlineReminders')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();

  // 毎月1日午前2時: バックアップ
  ScriptApp.newTrigger('backupSpreadsheet')
    .timeBased()
    .onMonthDay(1)
    .atHour(2)
    .create();

  // 毎月1日午前3時: 古いファイルのクリーンアップ
  ScriptApp.newTrigger('cleanupOldFiles')
    .timeBased()
    .onMonthDay(1)
    .atHour(3)
    .create();

  // 毎月1日午前4時: 孤児ファイル整理 + 監査ログ間引き
  ScriptApp.newTrigger('monthlyMaintenance')
    .timeBased()
    .onMonthDay(1)
    .atHour(4)
    .create();

  // 毎月1日午前5時: 年間レポート（実際に送信されるのは4月1日＝前年度分のみ）
  ScriptApp.newTrigger('scheduledAnnualReport')
    .timeBased()
    .onMonthDay(1)
    .atHour(5)
    .create();

  Logger.log('Installed triggers: sendDeadlineReminders(daily 8AM), backupSpreadsheet(monthly 1st 2AM), cleanupOldFiles(monthly 1st 3AM), monthlyMaintenance(monthly 1st 4AM), scheduledAnnualReport(yearly Apr 1 5AM)');
}

/**
 * 月次メンテナンス（孤児ファイル整理＋監査ログ間引き）。installTriggers() で毎月1日に実行。
 * 個々の処理が失敗しても他に影響しないよう個別に try/catch する。
 */
function monthlyMaintenance() {
  try { cleanupOrphanedFiles(); } catch (e) { Logger.log('cleanupOrphanedFiles failed: ' + e); }
  try { trimAuditLog(parseInt(getConfig('audit_keep_days')) || 365); } catch (e) { Logger.log('trimAuditLog failed: ' + e); }
}

/**
 * 年間レポートの自動送信用ラッパー。
 * installTriggers() で毎月1日に呼ばれるが、実際に送信するのは4月（前年度の集計）のみ。
 */
function scheduledAnnualReport() {
  const now = new Date();
  if (now.getMonth() + 1 !== 4) return; // 4月以外は何もしない
  if (getConfig('annual_report_enabled') === 'false') return; // 明示的に無効化されていればスキップ
  generateAnnualReport(now.getFullYear() - 1); // 直前に終わった年度を集計
}
