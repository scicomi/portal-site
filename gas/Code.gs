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
    Logger.log('シート作成完了。初期データ投入は populateInitialData() を別途実行してください。');
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

/**
 * メンバー31名 + 実験19種類の初期データを投入する。
 * シートが空の場合のみ実行する安全装置あり。
 * 上書きしたい場合は forceOverwrite=true で呼ぶ。
 */
function populateInitialData(forceOverwrite) {
  try {
    setupSpreadsheet(); // ヘッダー確実化
    const ss = SpreadsheetApp.openById(SHEET_ID);

    insertMembersData(ss, forceOverwrite === true);
    insertExperimentsData(ss, forceOverwrite === true);
    SpreadsheetApp.flush();
    Logger.log('✅ populateInitialData 完了');
  } catch (err) {
    Logger.log('POPULATE ERROR: ' + err + '\n' + err.stack);
    throw err;
  }
}

function insertMembersData(ss, force) {
  const sheet = ss.getSheetByName(MEMBERS_SHEET);
  if (!sheet) throw new Error('Members sheet not found');

  // 既にデータがある場合
  if (sheet.getLastRow() > 1 && !force) {
    Logger.log('Members already populated (' + (sheet.getLastRow() - 1) + ' rows). Skipping. Use populateInitialData(true) to overwrite.');
    return;
  }
  if (force && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
    Logger.log('Cleared existing Members data');
  }

  // [Category, Name, Role, StudentID, Affiliation, Year]
  const data = [
    ['adviser', '岡田 工', '', '101776', '理系教育センター', ''],
    ['coordinator', '南原 一仁', '', '320383', '学長室研究推進・産学連携担当', ''],
    ['coordinator', '泉水 博', '', '181936', '学長室教育支援担当', ''],
    ['member', '井上 咲笑', 'プロジェクトリーダー', '4CEQ1205', '', '4'],
    ['member', '太田 好信', 'マネージャー', '4CSP1104', '', '4'],
    ['member', '長山 芽唯', '会計リーダー', '4CSM1511', '', '4'],
    ['member', '坂本 渉真', '広報リーダー', '4CHH2123', '', '4'],
    ['member', 'ジョンソン 紫温', '', '4CSC1213', '', '4'],
    ['member', '箕輪 紗季', '', '4CSC2110', '', '4'],
    ['member', '一坪 小春', '', '4CSC3207', '', '4'],
    ['member', '山影 桜綾', '', '4CEK1125', '', '4'],
    ['member', 'ラビーン アメリー 美花', '', '4CEK2112', '', '4'],
    ['member', '下斗米 里咲', '', '4CSC1214', '', '4'],
    ['member', '安藤 春樹', '', '4CSP2106', '', '4'],
    ['member', '藤橋 日向', '', '4CSC3206', '', '4'],
    ['member', '長谷崎 文乃', '', '5CPEM006', '', '5'],
    ['member', '清家 一真', '', '5CSKM012', '', '5'],
    ['member', '今泉 勝', '', '2CSP3209', '', '2'],
    ['member', '納谷 拓実', '', '3CBK1139', '', '3'],
    ['member', '安川 莉来', '', '3CEK1229', '', '3'],
    ['member', '西岡 聖', '', '3CSC3115', '', '3'],
    ['member', '小山田 陸', '', '3CSC1109', '', '3'],
    ['member', '北村 隆盛', '', '3CSC2202', '', '3'],
    ['member', '山形 和斗', '', '3CSP1203', '', '3'],
    ['member', '栗田 祐良', '', '5CSC1210', '', '5'],
    ['member', '佐藤 天翔', '', '5CSC1203', '', '5'],
    ['member', '藤田 龍', '', '5CSC1119', '', '5'],
    ['member', '近藤 鉄平', '', '5CSM1208', '', '5'],
    ['member', '中野 伊織', '', '5CEQ1101', '', '5'],
    ['member', '澤村 彩那', '', '5CSC2218', '', '5'],
    ['member', '根岸 悠杜', '', '5CHJ3228', '', '5']
  ];

  const now = new Date().toISOString();
  const rows = data.map((m, i) => [
    'mb_' + (Date.now() + i),
    m[1], m[0], m[2], m[3], m[4], m[5], '', 'true', now, now
  ]);

  // バッチで一括挿入（速い・確実）
  sheet.getRange(2, 1, rows.length, MEMBERS_HEADERS.length).setValues(rows);
  Logger.log('Inserted ' + rows.length + ' members');
}

function insertExperimentsData(ss, force) {
  const sheet = ss.getSheetByName(EXPERIMENTS_SHEET);
  if (!sheet) throw new Error('Experiments sheet not found');

  if (sheet.getLastRow() > 1 && !force) {
    Logger.log('Experiments already populated. Skipping. Use populateInitialData(true) to overwrite.');
    return;
  }
  if (force && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
    Logger.log('Cleared existing Experiments data');
  }

  // [Category, Name, Materials, Preparation, Flow, Notes, SlidesURL]
  const data = [
    ['show', '超撥水で遊ぼう', '', '', '', '', ''],
    ['show', '空気・真空の実験', '', '', '', '', ''],
    ['show', 'シャカシャカ！カメレオン水', '水\n炭酸ナトリウム\nグルコース\nインジゴカルミン\nウォーターバス\nスターラー', '物品があるかを確認する\n発表者は発表練習', '', '', ''],
    ['show', '光の実験', '', '', '', '', ''],
    ['show', 'ルミノール反応', '', '', '', '', ''],
    ['show', 'マグヌス効果', '紙コップ ×2\n紐\nセロハンテープ', '見本を作成しておく\n紐を適当な長さに切り、結んで指を通せる穴を作る', '', '投げるための十分なスペースを確保\n天井（特に照明）に当たらないようにする', ''],
    ['show', 'バンジーチャイム', 'バンジーチャイム\n銅板\n真鍮板\nアルミニウム板', '', '', 'バンジーチャイムを落とす際に子どもの目の前までいってタイミングを伝える\n子どもが説明を理解しているか確認', ''],
    ['show', '顕微鏡', '', '', '', '', ''],
    ['show', '象の歯磨き粉', '', '', '', '', ''],
    ['show', '水中シャボン玉', '', '', '', '', 'https://www.canva.com/design/DAG7Go_cTR4/fK4v7p39-USk-YpYABNDrQ/edit'],
    ['show', '空気砲', '', '', '', '', ''],
    ['workshop', 'スライム', '', '', '', '', ''],
    ['workshop', '人工いくら', 'アルギン酸ナトリウム\n乳酸カルシウム\n水\n着色料\nプラスチックコップ\nピペット\n蓋付き試験管\nさじ\nマスキングテープ', 'アルギン酸ナトリウム溶液(水100ml:NA 1g)\n着色(顔料)\n乳酸カルシウム溶液(水100ml:Ca 1g)', '', '溶液が目や口に入らないように\nピペット先が乳酸Ca溶液に付かないように\n廃棄の説明を忘れない', ''],
    ['workshop', 'くるくるステンドグラス', '偏光版\nセロハンテープ\n回転式穴あけ\nレース糸\nはさみ', '偏光版を4つに切り面取り\n紐を15cm程度に切る\n紐の見本を作る', '', '穴あけ・糸通しはこちらで行う\nキリを使うときは裏で', ''],
    ['workshop', 'マグヌス効果', '紙コップ×2\n紐\nセロハンテープ', '', '', '', ''],
    ['workshop', 'スーパーボールロケット', '', '', '', '', ''],
    ['workshop', 'レモン電池', '', '', '', '', ''],
    ['workshop', '水中シャボン玉', '', '', '', '', ''],
    ['workshop', 'オーシャンボトル', '蓋の出来るビン\n水\n油(ベビーオイル)\n水性ペン\nろ紙\n飾り(ビーズ)\nプラコップ\nピペット\n雑巾・ブルーシート', 'ベビーオイルの詰め替え\n使用物品の在庫確認', '注意事項・使うものの説明\n作り方の説明\n実際に振らせてみる\n分離→分子間力の説明\n例外(界面活性剤)の説明\nまとめ', 'ベビーオイルを入れる時は瓶を持って入れる', '']
  ];

  const now = new Date().toISOString();
  const rows = data.map((e, i) => [
    'ex_' + (Date.now() + i),
    e[1], e[0], e[2], e[3], e[4], e[5], e[6], 'true', now, now
  ]);

  sheet.getRange(2, 1, rows.length, EXPERIMENTS_HEADERS.length).setValues(rows);
  Logger.log('Inserted ' + rows.length + ' experiments');
}
