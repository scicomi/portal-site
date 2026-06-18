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

function setupSpreadsheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // 1. Events シート
  let events = ss.getSheetByName(EVENTS_SHEET);
  if (!events) events = ss.insertSheet(EVENTS_SHEET);
  if (events.getLastRow() === 0) {
    const headers = [
      'ID', 'Date', 'DateEnd', 'Title', 'Category', 'Location', 'Audience',
      'TimeStart', 'TimeEnd', 'MeetingNumber', 'PartsList',
      'AdminKyoka', 'AdminHoukoku', 'KyokaDeadline', 'HoukokuDeadline',
      'Logistics', 'Remarks', 'Files',
      'CreatedAt', 'UpdatedAt', 'UpdatedBy'
    ];
    events.appendRow(headers);
    events.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    events.setFrozenRows(1);
  }

  // 2. Members シート
  let members = ss.getSheetByName(MEMBERS_SHEET);
  if (!members) members = ss.insertSheet(MEMBERS_SHEET);
  if (members.getLastRow() === 0) {
    const headers = [
      'ID', 'Name', 'Category', 'Role', 'StudentID', 'Affiliation', 'Year', 'Note', 'Active',
      'CreatedAt', 'UpdatedAt'
    ];
    members.appendRow(headers);
    members.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    members.setFrozenRows(1);

    // 初期データを投入
    const initialMembers = [
      // [Category, Name, Role, ID, Affiliation, Year]
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
    initialMembers.forEach((m, i) => {
      members.appendRow([
        'mb_' + (Date.now() + i),
        m[1], m[0], m[2], m[3], m[4], m[5], '', 'true', now, now
      ]);
    });
  }

  // 3. Experiments シート
  let experiments = ss.getSheetByName(EXPERIMENTS_SHEET);
  if (!experiments) experiments = ss.insertSheet(EXPERIMENTS_SHEET);
  if (experiments.getLastRow() === 0) {
    const headers = [
      'ID', 'Name', 'Category', 'Materials', 'Preparation', 'Flow', 'Notes',
      'SlidesURL', 'Active', 'CreatedAt', 'UpdatedAt'
    ];
    experiments.appendRow(headers);
    experiments.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    experiments.setFrozenRows(1);

    // 初期データ投入（Notionや年間スケジュールから）
    const initialExp = [
      // [Category, Name, Materials, Preparation, Flow, Notes, SlidesURL]
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
      ['workshop', '人工いくら', 'アルギン酸ナトリウム\n乳酸カルシウム\n水\n着色料\nプラスチックコップ\nピペット\n蓋付き試験管\nさじ\nマスキングテープ', 'アルギン酸ナトリウム溶液を用意（水100ml:NA 1g）\n着色（顔料）\n乳酸カルシウム溶液を用意（水100ml:Ca 1g）', '', '溶液が目や口に入らないように\nピペット先が乳酸Ca溶液に付かないように\n廃棄の説明を忘れない', ''],
      ['workshop', 'くるくるステンドグラス', '偏光版\nセロハンテープ\n回転式穴あけ\nレース糸\nはさみ', '偏光版を4つに切り面取り\n紐を15cm程度に切る\n紐の見本を作る', '', '穴あけ・糸通しはこちらで行う\nキリを使うときは裏で', ''],
      ['workshop', 'マグヌス効果', '紙コップ×2\n紐\nセロハンテープ', '', '', '', ''],
      ['workshop', 'スーパーボールロケット', '', '', '', '', ''],
      ['workshop', 'レモン電池', '', '', '', '', ''],
      ['workshop', '水中シャボン玉', '', '', '', '', ''],
      ['workshop', 'オーシャンボトル', '蓋の出来るビン\n水\n油(ベビーオイル)\n水性ペン\nろ紙\n飾り(ビーズ)\nプラコップ\nピペット\n雑巾・ブルーシート', 'ベビーオイルの詰め替え\n使用物品の在庫確認', '注意事項・使うものの説明\n作り方の説明\n実際に振らせてみる\n分離の説明→分子間力の説明\n例外（界面活性剤）の説明\nまとめ', 'ベビーオイルを入れる時は瓶を持って入れる\n飾りは細かい方をスプーン1杯、大きい方を2つ', '']
    ];
    const now = new Date().toISOString();
    initialExp.forEach((e, i) => {
      experiments.appendRow([
        'ex_' + (Date.now() + i),
        e[1], e[0], e[2], e[3], e[4], e[5], e[6], 'true', now, now
      ]);
    });
  }

  // 4. Config シート
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
