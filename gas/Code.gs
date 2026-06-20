/**
 * SciComi Portal - Google Apps Script Backend API (v3)
 *
 * 3つのリソースに対応:
 *   - events:      イベントカレンダー
 *   - members:     メンバーリスト（アドバイザー/コーディネーター/メンバー）
 *   - experiments: 実験内容（工作/実験ショー/その他）
 *
 * Phase 4 追加:
 *   - sendDeadlineReminders(): 期限リマインダーメール（毎日トリガー）
 *   - generateAnnualReport(year): 年間レポート自動生成
 *   - installTriggers(): トリガー設置
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
  'ID', 'Name', 'Category', 'Role', 'StudentID', 'Affiliation', 'Year',
  'Email', 'Note', 'Active',
  'CreatedAt', 'UpdatedAt'
];
const EXPERIMENTS_HEADERS = [
  'ID', 'Name', 'Category', 'Materials', 'Preparation', 'Flow', 'Notes',
  'SlidesURL', 'Active', 'CreatedAt', 'UpdatedAt'
];

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
      ['file_retention_years', 5],
      ['reminder_enabled', 'true'],
      ['reminder_days', '7,3,1'],
      ['report_recipients', '']
    ];
    config.getRange(1, 1, rows.length, 2).setValues(rows);
    config.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#464775').setFontColor('#ffffff');
    config.setFrozenRows(1);
    Logger.log('Created Config sheet with default password');
  }
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
      return;
    }

    try {
      MailApp.sendEmail({
        to: to,
        cc: email !== 'staff' ? staffEmails.filter(e => e !== email).join(',') : '',
        subject: subject,
        htmlBody: body
      });
      Logger.log('Sent reminder to ' + to + ': ' + items.length + ' items');
    } catch (err) {
      Logger.log('Failed to send to ' + to + ': ' + err);
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
  const catLabels = {
    normal: '通常イベント', other: '学内イベント',
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
    MailApp.sendEmail({
      to: recipients,
      subject: '[SciComi] ' + fiscalYear + '年度 年間活動レポート',
      htmlBody: html
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
  // 既存のリマインダートリガーを削除
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'sendDeadlineReminders') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Deleted existing trigger for sendDeadlineReminders');
    }
  });

  // 毎日午前8時に実行
  ScriptApp.newTrigger('sendDeadlineReminders')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();

  Logger.log('Installed daily trigger for sendDeadlineReminders at 8:00 AM');
  Logger.log('To configure: set reminder_enabled=true and reminder_days=7,3,1 in Config sheet');
}
