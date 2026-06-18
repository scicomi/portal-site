/**
 * SciComi Portal - Google Apps Script Backend API
 *
 * デプロイ方法:
 *   1. このファイルを Google Apps Script (script.google.com) に貼り付け
 *   2. スプレッドシートIDを下の SHEET_ID に貼る
 *   3. デプロイ → 新しいデプロイ → 種類: ウェブアプリ
 *      - 実行ユーザー: 自分
 *      - アクセスできるユーザー: 全員
 *   4. 発行された Web App URL を script.js の API_URL に貼る
 *
 * 重要: スプレッドシートを変更したら「デプロイを管理」から再デプロイ不要
 *       ただし Code.gs を変更したら「新しいデプロイ」を作るか同じデプロイを「編集→新しいバージョン」する
 */

// ====== 設定 ======
const SHEET_ID = '★ここにスプレッドシートのIDを貼る★';
const EVENTS_SHEET = 'Events';
const CONFIG_SHEET = 'Config';

// ====== エントリポイント ======

/**
 * GET リクエスト処理
 * 用途: イベント一覧取得 (?action=list&token=XXX)
 */
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || 'list';

    if (!checkAuth(params.token)) {
      return jsonResponse({ success: false, error: 'unauthorized' });
    }

    if (action === 'list') {
      return jsonResponse({ success: true, events: listEvents() });
    }

    return jsonResponse({ success: false, error: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err) });
  }
}

/**
 * POST リクエスト処理
 * 用途: 保存・削除・認証
 * Body: text/plain で JSON 文字列を送る（CORS preflight 回避のため）
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;

    // 認証アクションだけはトークンチェック前
    if (action === 'auth') {
      const ok = (body.password || '') === getConfig('password');
      return jsonResponse({ success: ok, token: ok ? getConfig('password') : '' });
    }

    if (!checkAuth(body.token)) {
      return jsonResponse({ success: false, error: 'unauthorized' });
    }

    if (action === 'save') {
      const saved = saveEvent(body.event || {});
      return jsonResponse({ success: true, event: saved });
    }

    if (action === 'delete') {
      const deleted = deleteEvent(body.id);
      return jsonResponse({ success: deleted });
    }

    return jsonResponse({ success: false, error: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err) });
  }
}

// ====== ヘルパー ======

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkAuth(token) {
  if (!token) return false;
  return token === getConfig('password');
}

function getConfig(key) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(CONFIG_SHEET);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === key) return String(values[i][1]);
  }
  return '';
}

// ====== イベント操作 ======

function getEventsSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(EVENTS_SHEET);
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function rowToEvent(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    let val = row[i];
    // Date型をYYYY-MM-DDに正規化
    if (val instanceof Date) {
      val = Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
    }
    obj[h] = val === '' || val === null ? '' : String(val);
  });
  // JSONフィールドをパース
  ['PartsList', 'Files'].forEach(f => {
    if (obj[f]) {
      try { obj[f] = JSON.parse(obj[f]); } catch (_) { obj[f] = []; }
    } else {
      obj[f] = [];
    }
  });
  return obj;
}

function eventToRow(headers, eventObj) {
  return headers.map(h => {
    let val = eventObj[h];
    if (val === undefined || val === null) return '';
    if ((h === 'PartsList' || h === 'Files') && typeof val !== 'string') {
      return JSON.stringify(val);
    }
    return val;
  });
}

function listEvents() {
  const sheet = getEventsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = getHeaders(sheet);
  const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return rows
    .filter(r => r[0]) // IDが空の行はスキップ
    .map(r => rowToEvent(headers, r));
}

function findRowById(id) {
  const sheet = getEventsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2; // 行番号(1-indexed)
  }
  return -1;
}

function saveEvent(eventObj) {
  const sheet = getEventsSheet();
  const headers = getHeaders(sheet);
  const now = new Date().toISOString();

  // 新規ならIDを採番
  if (!eventObj.ID) {
    eventObj.ID = 'ev_' + Date.now();
    eventObj.CreatedAt = now;
  }
  eventObj.UpdatedAt = now;

  const existingRow = findRowById(eventObj.ID);
  const rowData = eventToRow(headers, eventObj);

  if (existingRow > 0) {
    // 更新
    sheet.getRange(existingRow, 1, 1, headers.length).setValues([rowData]);
  } else {
    // 新規追加
    sheet.appendRow(rowData);
  }

  // 返却用に再パース
  return rowToEvent(headers, rowData);
}

function deleteEvent(id) {
  const row = findRowById(id);
  if (row < 0) return false;
  getEventsSheet().deleteRow(row);
  return true;
}

// ====== 初期セットアップ用ヘルパー ======

/**
 * スプレッドシートに必要なシートとヘッダーを作成する。
 * 一度だけ手動実行する: GASエディタで関数を選んで実行 → 権限承認
 */
function setupSpreadsheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Events シート
  let events = ss.getSheetByName(EVENTS_SHEET);
  if (!events) events = ss.insertSheet(EVENTS_SHEET);
  const headers = [
    'ID', 'Date', 'DateEnd', 'Title', 'Category', 'Location', 'Audience',
    'TimeStart', 'TimeEnd', 'MeetingNumber', 'PartsList',
    'AdminKyoka', 'AdminHoukoku', 'KyokaDeadline', 'HoukokuDeadline',
    'Logistics', 'Remarks', 'Files',
    'CreatedAt', 'UpdatedAt', 'UpdatedBy'
  ];
  if (events.getLastRow() === 0) {
    events.appendRow(headers);
    events.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    events.setFrozenRows(1);
  }

  // Config シート
  let config = ss.getSheetByName(CONFIG_SHEET);
  if (!config) config = ss.insertSheet(CONFIG_SHEET);
  if (config.getLastRow() === 0) {
    config.appendRow(['Key', 'Value']);
    config.appendRow(['password', 'CHANGE_ME_' + Math.random().toString(36).slice(2, 8)]);
    config.appendRow(['storage_warn_mb', 60]);
    config.appendRow(['storage_block_mb', 100]);
    config.appendRow(['file_retention_years', 5]);
    config.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    config.setFrozenRows(1);
  }

  Logger.log('Setup complete. Password: ' + getConfig('password'));
}
