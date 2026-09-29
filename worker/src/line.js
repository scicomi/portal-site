// LINE 公式アカウントによる新規イベント通知(gas/Code.gs の notifyNewEvent_ / sendLineBroadcast_ の移植)

import { getConfig, getSecret } from './config.js';
import { appendAuditLog } from './data.js';

// ラベルはフロント config.js の EVENT_CATEGORIES と一致させる
const CAT_LABELS = { normal: 'イベント', other: 'その他', general: '全体ミーティング', admin: '幹部ミーティング' };

export async function notifyNewEvent(env, event) {
  if ((await getConfig(env, 'event_notify_enabled')) === 'false') return;
  try {
    const catLabel = CAT_LABELS[event.Category] || event.Category || '';
    const dateRange = (event.Date || '') + (event.DateEnd && event.DateEnd !== event.Date ? '(〜' + event.DateEnd + ')' : '');
    const text = '📅 新しいイベントが登録されました\n\n'
      + 'タイトル: ' + (event.Title || '(無題)') + '\n'
      + '日付: ' + dateRange + '\n'
      + 'カテゴリ: ' + catLabel + '\n'
      + '場所: ' + (event.Location || '未定');
    await sendLineBroadcast(env, text);
  } catch (err) {
    console.error('Failed to send new event notification: ' + err);
    await appendAuditLog(env, 'event_notify_fail', String(err), '');
  }
}

// LINE Messaging API のブロードキャスト配信(公式アカウントを友だち追加した全員に送信)
async function sendLineBroadcast(env, text) {
  const token = ((await getSecret(env, 'line_channel_access_token')) || '').trim();
  if (!token) { console.log('LINE notify skipped: line_channel_access_token not configured'); return; }
  const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ messages: [{ type: 'text', text }] })
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('LINE broadcast failed (' + res.status + '): ' + body);
    await appendAuditLog(env, 'event_notify_fail', 'LINE broadcast ' + res.status + ': ' + body, '');
  }
}
