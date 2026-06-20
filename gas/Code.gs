/**
 * SciComi Portal - Google Apps Script Backend API (v2)
 *
 * 3つのリソースに対応:
 *   - events:      イベントカレンダー
 *   - members:     メンバーリスト（アドバイザー/コーディネーター/メンバー）
 *   - experiments: 実験内容（工作/実験ショー/その他）
 */

// ====== 設定 ======
const SHEET_ID = '★ここにスプレッドシートのIDを貼る★';
const EVENTS_SHEET = 'Events';
const MEMBERS_SHEET = 'Members';
const EXPERIMENTS_SHEET = 'Experiments';
const CONFIG_SHEET = 'Config';

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

    if (action === 'auth') {
      const inputPw = (body.password || params.password || '').trim();
      const realPw = getConfig('password').trim();
      const ok = inputPw === realPw && inputPw !== '';
      return jsonResponse({ success: ok, token: ok ? realPw : '' });
    }

    if (!checkAuth(token)) {
      return jsonResponse({ success: false, error: 'unauthorized' });
    }

    if (action === 'save') {
      const saved = saveResource(resource, body.item || {});
      return jsonResponse({ success: true, item: saved });
    }

    if (action === 'delete') {
      const deleted = deleteResource(resource, body.id || params.id);
      return jsonResponse({ success: deleted });
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

function getSheetName(resource) {
  if (resource === 'events') return EVENTS_SHEET;
  if (resource === 'members') return MEMBERS_SHEET;
  if (resource === 'experiments') return EXPERIMENTS_SHEET;
  throw new Error('unknown resource: ' + resource);
}

function getJsonFields(resource) {
  if (resource === 'events') return ['PartsList', 'Files'];
  return [];
}

function getIdPrefix(resource) {
  if (resource === 'events') return 'ev_';
  if (resource === 'members') return 'mb_';
  if (resource === 'experiments') return 'ex_';
  return 'id_';
}

// ====== 汎用CRUD ======

function listResource(resource) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(getSheetName(resource));
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const jsonFields = getJsonFields(resource);
  return rows
    .filter(r => r[0])
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        let val = r[i];
        if (val instanceof Date) {
          val = Utilities.formatDate(val, 'Asia/Tokyo', 'yyyy-MM-dd');
        }
        obj[h] = val === '' || val === null ? '' : String(val);
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

function saveResource(resource, item) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(getSheetName(resource));
  if (!sheet) throw new Error('sheet not found: ' + resource);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const jsonFields = getJsonFields(resource);
  const now = new Date().toISOString();

  if (!item.ID) {
    item.ID = getIdPrefix(resource) + Date.now();
    if (headers.indexOf('CreatedAt') >= 0) item.CreatedAt = now;
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

  const lastRow = sheet.getLastRow();
  let existingRow = -1;
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i][0] === item.ID) { existingRow = i + 2; break; }
    }
  }

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, headers.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }

  // 返却用にパース済みオブジェクトを返す
  const returned = {};
  headers.forEach((h, i) => { returned[h] = rowData[i]; });
  jsonFields.forEach(f => {
    if (returned[f] && typeof returned[f] === 'string') {
      try { returned[f] = JSON.parse(returned[f]); } catch (_) { returned[f] = []; }
    }
  });
  return returned;
}

function deleteResource(resource, id) {
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
}

// ====== 初期セットアップ ======

const EVENTS_HEADERS = [
  'ID', 'Date', 'DateEnd', 'Title', 'Category', 'Location', 'Audience',
  'TimeStart', 'TimeEnd', 'MeetingNumber', 'PartsList',
  'AdminKyoka', 'AdminHoukoku', 'KyokaDeadline', 'HoukokuDeadline',
  'Logistics', 'Remarks', 'Files', 'Belongings',
  'CreatedAt', 'UpdatedAt', 'UpdatedBy'
];
const MEMBERS_HEADERS = [
  'ID', 'Name', 'Category', 'Role', 'StudentID', 'Affiliation', 'Year', 'Note', 'Active',
  'CreatedAt', 'UpdatedAt'
];
const EXPERIMENTS_HEADERS = [
  'ID', 'Name', 'Category', 'Materials', 'Preparation', 'Flow', 'Notes',
  'SlidesURL', 'Active', 'CreatedAt', 'UpdatedAt'
];

/**
 * シート作成のみ。初期データは入れない（既存シートを壊さないため）
 */
function setupSpreadsheet() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    ensureSheet(ss, EVENTS_SHEET, EVENTS_HEADERS);
    ensureSheet(ss, MEMBERS_SHEET, MEMBERS_HEADERS);
    ensureSheet(ss, EXPERIMENTS_SHEET, EXPERIMENTS_HEADERS);
    ensureConfigSheet(ss);
    SpreadsheetApp.flush();
    Logger.log('Setup complete. Password: ' + getConfig('password'));
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
    // 既存ヘッダーに足りない列を追加
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
      ['storage_warn_mb', 60],
      ['storage_block_mb', 100],
      ['file_retention_years', 5]
    ];
    config.getRange(1, 1, rows.length, 2).setValues(rows);
    config.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    config.setFrozenRows(1);
    Logger.log('Created Config sheet with default password');
  }
}
