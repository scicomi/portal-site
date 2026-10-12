// Teams への通知: 新規は自動(保存の約 3 分後)、変更は画面のボタン。設計は docs/12_teams_notify_plan.md。
//
// 送り先は Power Automate の「Teams Webhook 要求を受信したとき」で作ったフローの URL(Secret の TEAMS_WEBHOOK_URL)。
// フローは本文の attachments のカードを Teams に投稿する。変更(kind: 'update')のときは、カードに入れた目印
// (ボタンのリンクの `id=イベントのID~`)で元の投稿を探し、その投稿への返信にする。見つからなければ新しい投稿にする。
// 202 は「受け付けた」だけで、投稿の成功ではない(フローの失敗は Worker からは見えない)。
//
// このファイルのうち、カードと差分の組み立て(buildNewCard から diffTeams まで)は D1 を使わないので、Node の単体テストから直接呼べる。

import { WATCHED, fieldValue, isMeeting, eventDisplayName } from './eventNotify.js';
import { teamsConfigured } from './config.js';
import { parseJsonList, appendAuditLog } from './data.js';
import { jstIso } from './util.js';

export const TEAMS_NEW_DELAY_SEC = 180;        // 新規の自動通知: 最後の保存から送るまで(この間の保存し直しは 1 回にまとめる)
export const TEAMS_COOLDOWN_SEC = 60;          // 同じイベントへ、ボタンで続けて送れる間隔
const RETRY_DELAYS_SEC = [60, 300, 900];       // 自動送信に失敗したときの再試行の間隔(使い切ったら 'failed')
const CLAIM_SEC = 120;                         // 送信中の行を、ほかの実行が拾わないようにする時間
const MAX_VALUE_CHARS = 120;                   // 変更カードの変更前後の値は、この長さで切る
const DEFAULT_SITE_URL = 'https://scicomi.github.io/portal-site/';

// ミーティングの種類の名前(config.js のカテゴリと同じ)
const MEETING_NAMES = { general: '全体ミーティング', admin: '幹部ミーティング' };

// 通知の対象: 通知の判定に使う項目(eventNotify.js の WATCHED)に、カードに載せる書類担当を足したもの
const DOC_FIELDS = [
  { key: 'kyoka',   cols: ['AdminKyoka', 'KyokaNotRequired'],     label: () => '許可願担当' },
  { key: 'houkoku', cols: ['AdminHoukoku', 'HoukokuNotRequired'], label: () => '報告書担当' }
];
export const TEAMS_FIELDS = WATCHED.concat(DOC_FIELDS);
const SNAPSHOT_COLUMNS = Array.from(new Set(['ID', 'Category', 'MeetingNumber'].concat(TEAMS_FIELDS.flatMap(w => w.cols))));

const s = v => (v === null || v === undefined ? '' : String(v)).trim();
const flag = v => { const t = s(v).toLowerCase(); return t !== '' && t !== '0' && t !== 'false'; };
const clip = (v, n) => (v.length > n ? v.slice(0, n) + '…' : v);

// ---- 文面 ----

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function ymd(d) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s(d));
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], wd: WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] };
}

// 例: 2026年11月3日(火) 10:00 から 15:00 / 2026年11月3日(火) から 11月4日(水)
export function dateTimeText(ev) {
  const a = ymd(ev.Date);
  if (!a) return '';
  let t = a.y + '年' + a.m + '月' + a.d + '日(' + a.wd + ')';
  const b = s(ev.DateEnd) && s(ev.DateEnd) !== s(ev.Date) ? ymd(ev.DateEnd) : null;
  if (b) t += ' から ' + (b.y === a.y ? '' : b.y + '年') + b.m + '月' + b.d + '日(' + b.wd + ')';
  const from = s(ev.TimeStart), to = s(ev.TimeEnd);
  if (from || to) t += ' ' + (from && to ? from + ' から ' + to : from ? from + ' から' : to + ' まで');
  return t;
}

// 実験内容・発表者: 「スライム作り(山田、佐藤)」を ' / ' でつなぐ
function partsText(ev) {
  return parseJsonList(ev.PartsList).map(p => {
    const name = s(p && p.name);
    const presenters = Array.isArray(p && p.presenters) ? p.presenters.map(s).filter(Boolean) : [];
    if (!name) return '';
    return presenters.length ? name + '(' + presenters.join('、') + ')' : name;
  }).filter(Boolean).join(' / ');
}

function docText(notRequired, person) {
  return flag(notRequired) ? '不要' : s(person);
}

// 項目の見せ方(空は呼び出し側で「ー」にする)
function display(w, ev) {
  switch (w.key) {
    case 'date': return dateTimeText(Object.assign({}, ev, { TimeStart: '', TimeEnd: '' }));
    case 'parts': return partsText(ev);
    case 'kyoka': return docText(ev.KyokaNotRequired, ev.AdminKyoka);
    case 'houkoku': return docText(ev.HoukokuNotRequired, ev.AdminHoukoku);
    default: return fieldValue(w, ev).split('\u0000').map(s).filter(Boolean).join(' / ');
  }
}

// 空の値は「ー」で表す
const dash = v => s(v) || 'ー';

// カードに並べる項目。keys: その項目が変わったと判断する WATCHED / DOC_FIELDS の key(変更のカードで印を付ける)
function cardRows(ev) {
  if (isMeeting(ev)) {
    return [
      { label: 'ミーティング名', keys: ['title'], value: eventDisplayName(ev) },
      { label: '場所', keys: ['location'], value: s(ev.Location) },
      { label: '日時', keys: ['date', 'time'], value: dateTimeText(ev) },
      { label: '議題', keys: ['remarks'], value: s(ev.Remarks) }
    ];
  }
  return [
    { label: 'イベント名', keys: ['title'], value: eventDisplayName(ev) },
    { label: '企画担当者', keys: ['leader'], value: s(ev.PlanLeader) },
    { label: '場所', keys: ['location'], value: s(ev.Location) },
    { label: 'イベント日時', keys: ['date', 'time'], value: dateTimeText(ev) },
    { label: '実験内容・発表者', keys: ['parts'], value: partsText(ev) },
    { label: '許可願担当', keys: ['kyoka'], value: docText(ev.KyokaNotRequired, ev.AdminKyoka) },
    { label: '報告書担当', keys: ['houkoku'], value: docText(ev.HoukokuNotRequired, ev.AdminHoukoku) }
  ];
}

// ボタンのリンク。`id=イベントのID~` は、変更のときにフローが元の投稿を探す目印(~ は id=12 と id=123 を取り違えない区切り。
// ポータルは event だけを読み、id は無視する)
export function eventLinks(site, ev) {
  const base = (s(site) || DEFAULT_SITE_URL).replace(/\/?$/, '/');
  const id = encodeURIComponent(s(ev.ID));
  const url = base + 'events.html?event=' + id + '&id=' + id + '~';
  return [
    { type: 'Action.OpenUrl', title: 'ポータルで詳細を見る', url },
    { type: 'Action.OpenUrl', title: '出欠を入力', url, style: 'positive' }
  ];
}

function cardShell(body, actions) {
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, actions };
}

function header(style, color, lead, name, size) {
  return { type: 'Container', style, bleed: true, items: [
    { type: 'TextBlock', text: lead, weight: 'Bolder', color, wrap: true },
    { type: 'TextBlock', text: name, weight: 'Bolder', size: size || 'ExtraLarge', wrap: true, spacing: 'Small' }
  ] };
}

const factSet = pairs => ({ type: 'FactSet', spacing: 'Medium', facts: pairs.map(p => ({ title: p[0], value: p[1] })) });

// 新規のカード(イベント / ミーティング)
export function buildNewCard(ev, site) {
  const name = eventDisplayName(ev);
  const links = eventLinks(site, ev);
  if (isMeeting(ev)) {
    const kind = MEETING_NAMES[s(ev.Category)] || 'ミーティング';
    return cardShell([
      header('attention', 'Attention', kind + 'が登録されました', name),
      factSet(cardRows(ev).map(r => [r.label, dash(r.value)]))
    ], links);
  }
  return cardShell([
    header('accent', 'Accent', '新しいイベントが登録されました', name),
    factSet(cardRows(ev).map(r => [r.label, dash(r.value)]))
  ], links);
}

// 前回 Teams へ送った内容(before)と今(after)の差。[{ w, label, from, to }]
export function diffTeams(before, after) {
  const out = [];
  TEAMS_FIELDS.forEach(w => {
    if (fieldValue(w, before || {}) === fieldValue(w, after || {})) return;
    out.push({ w, label: w.label(after), from: display(w, before || {}), to: display(w, after) });
  });
  return out;
}

// 変更のカード。新規と同じ項目を全部並べ、変わった項目だけ、項目名に「(変更)」を付けて、
// 前の値があれば「前 から 後」、前が空なら新しい値だけを出す。
// before: 前回 Teams へ送った内容。changes: diffTeams(before, ev) の結果
export function buildUpdateCard(ev, before, changes, site) {
  const lead = isMeeting(ev) ? 'ミーティングの内容が変更されました' : 'イベントの内容が変更されました';
  const changedKeys = new Set(changes.map(c => c.w.key));
  const prev = cardRows(Object.assign({}, before, { Category: ev.Category, MeetingNumber: ev.MeetingNumber }));
  const arrow = (from, to) => (s(from) ? clip(s(from), MAX_VALUE_CHARS) + ' から ' + clip(dash(to), MAX_VALUE_CHARS) : dash(to));
  const pairs = cardRows(ev).map((r, i) => (r.keys.some(k => changedKeys.has(k))
    ? [r.label + '(変更)', arrow(prev[i].value, r.value)]
    : [r.label, dash(r.value)]));
  // カードの項目にない変更(備考・対象・運搬方法など)は、末尾に足す
  const shown = new Set(cardRows(ev).flatMap(r => r.keys));
  changes.filter(c => !shown.has(c.w.key)).forEach(c => pairs.push([c.label + '(変更)', arrow(c.from, c.to)]));
  return cardShell([
    header('warning', 'Warning', lead, eventDisplayName(ev), 'ExtraLarge'),
    factSet(pairs),
    { type: 'TextBlock', text: '「(変更)」の付いた項目が変わりました。', isSubtle: true, wrap: true }
  ], eventLinks(site, ev));
}

// フローへ送る本文。eventKey と kind は Teams には表示されず、フローが読む
export function webhookBody(kind, ev, card) {
  return {
    type: 'message', eventKey: s(ev.ID), kind,
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }]
  };
}

// ---- 送信 ----

// 失敗の理由は、URL を含まない短い文字列にする(ログや画面に送信先を出さない)
export async function postToTeams(env, body) {
  if (!teamsConfigured(env)) throw new Error('teams_disabled');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch(String(env.TEAMS_WEBHOOK_URL).trim(), {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: ctrl.signal
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'teams_timeout' : 'teams_network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('teams_http_' + res.status);
}

// ---- 状態(D1 の teams_notify) ----

const nowSec = () => Math.floor(Date.now() / 1000);

export async function loadEventForTeams(env, id) {
  if (!id || typeof id !== 'string') return null;
  return env.DB.prepare('SELECT ' + SNAPSHOT_COLUMNS.map(c => '"' + c + '"').join(', ') + ' FROM events WHERE ID = ?').bind(id).first();
}

const snapshotOf = ev => JSON.stringify(Object.fromEntries(SNAPSHOT_COLUMNS.map(c => [c, s(ev[c])])));

async function getRow(env, id) {
  return env.DB.prepare('SELECT * FROM teams_notify WHERE EventID = ?').bind(id).first();
}

async function markSent(env, id, ev) {
  const t = nowSec();
  await env.DB.prepare(
    "INSERT INTO teams_notify (EventID, State, DueAt, Attempts, Snapshot, SentAt, SentAtSec) VALUES (?, 'sent', 0, 0, ?, ?, ?) "
    + "ON CONFLICT(EventID) DO UPDATE SET State = 'sent', DueAt = 0, Attempts = 0, Snapshot = excluded.Snapshot, SentAt = excluded.SentAt, SentAtSec = excluded.SentAtSec"
  ).bind(id, snapshotOf(ev), jstIso(), t).run();
}

// 新規作成の保存のあとに呼ぶ: 送信待ちに積む。保存し直すたびに送る時刻を後ろにずらす(編集を 1 回にまとめる)。
// 送信済み・失敗済みの行は触らない
export async function enqueueTeamsNew(env, id, delaySec) {
  if (!teamsConfigured(env) || !id) return false;
  const due = nowSec() + (delaySec >= 0 ? delaySec : TEAMS_NEW_DELAY_SEC);
  await env.DB.prepare(
    "INSERT INTO teams_notify (EventID, State, DueAt, Attempts) VALUES (?, 'pending', ?, 0) "
    + "ON CONFLICT(EventID) DO UPDATE SET DueAt = excluded.DueAt, Attempts = 0 WHERE teams_notify.State = 'pending'"
  ).bind(id, due).run();
  return true;
}

// ボタンで続けて送れる間隔。ローカルの結合テストだけ TEAMS_COOLDOWN_SEC で縮める(本番では設定しない)
function cooldownSec(env) {
  const n = parseInt(env.TEAMS_COOLDOWN_SEC, 10);
  return n >= 0 ? n : TEAMS_COOLDOWN_SEC;
}

export function teamsNewDelaySec(env) {
  const n = parseInt(env.TEAMS_NEW_DELAY_SEC, 10);   // ローカルの結合テストだけ待ち時間を縮める(本番では設定しない)
  return n >= 0 ? n : TEAMS_NEW_DELAY_SEC;
}

// 1 分ごとの定期実行から: 期限が来た新規の通知を送る。送った件数を返す
export async function drainTeams(env, limit) {
  if (!teamsConfigured(env)) return 0;
  const rows = (await env.DB.prepare("SELECT EventID, Attempts FROM teams_notify WHERE State = 'pending' AND DueAt <= ? ORDER BY DueAt LIMIT ?")
    .bind(nowSec(), limit || 3).all()).results || [];
  let sent = 0;
  for (const row of rows) {
    const id = row.EventID;
    // 重なって動いた実行が同じ行を送らないよう、先に期限を後ろにずらして確保する
    const claim = await env.DB.prepare("UPDATE teams_notify SET DueAt = ? WHERE EventID = ? AND State = 'pending' AND DueAt <= ?")
      .bind(nowSec() + CLAIM_SEC, id, nowSec()).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const ev = await loadEventForTeams(env, id);
    if (!ev) { await env.DB.prepare('DELETE FROM teams_notify WHERE EventID = ?').bind(id).run(); continue; }
    try {
      await postToTeams(env, webhookBody('new', ev, buildNewCard(ev, env.SITE_URL)));
      await markSent(env, id, ev);
      await appendAuditLog(env, 'teams_notify', id + ':new:auto', '', 'system');
      sent++;
    } catch (e) {
      const attempts = (row.Attempts || 0) + 1;
      const msg = String((e && e.message) || e).slice(0, 80);
      if (attempts > RETRY_DELAYS_SEC.length) {
        await env.DB.prepare("UPDATE teams_notify SET State = 'failed', Attempts = ? WHERE EventID = ?").bind(attempts, id).run();
      } else {
        await env.DB.prepare('UPDATE teams_notify SET DueAt = ?, Attempts = ? WHERE EventID = ?').bind(nowSec() + RETRY_DELAYS_SEC[attempts - 1], attempts, id).run();
      }
      await appendAuditLog(env, 'teams_fail', id + ':new:auto: ' + msg + ' (' + attempts + ')', '', 'system');
    }
  }
  return sent;
}

export async function drainTeamsSafe(env, limit) {
  try { return await drainTeams(env, limit); } catch (e) { console.error('drainTeams failed: ' + (e && e.stack || e)); return 0; }
}

// 詳細ページのボタン用の状態。state: 'none' 未送信 / 'pending' 自動の送信待ち / 'sent' 送信済み / 'failed' 自動送信に失敗
// changed: 送信済みのとき、前回から変わった項目の名前
export async function teamsStatus(env, id) {
  if (!teamsConfigured(env)) return { success: true, enabled: false };
  const ev = await loadEventForTeams(env, id);
  if (!ev) return { success: false, error: 'not_found' };
  const row = await getRow(env, id);
  const out = { success: true, enabled: true, state: row ? row.State : 'none', sentAt: row && row.SentAt || '', changed: [] };
  if (row && row.State === 'sent' && row.Snapshot) {
    try { out.changed = diffTeams(JSON.parse(row.Snapshot), ev).map(c => c.label); } catch (_) { out.state = 'none'; }
  }
  return out;
}

// ボタン: 送信済みなら前回からの変更を返信で、そうでなければ新規のカードを、今すぐ送る
export async function notifyTeamsNow(env, id) {
  if (!teamsConfigured(env)) return { success: false, error: 'feature_disabled' };
  const ev = await loadEventForTeams(env, id);
  if (!ev) return { success: false, error: 'not_found' };
  const row = await getRow(env, id);
  const t = nowSec();
  if (row && row.State === 'sent' && t - (row.SentAtSec || 0) < cooldownSec(env)) return { success: false, error: 'too_soon' };

  let kind = 'new', body, changes = [];
  if (row && row.State === 'sent' && row.Snapshot) {
    let before = null;
    try { before = JSON.parse(row.Snapshot); } catch (_) { before = null; }
    if (before) {
      changes = diffTeams(before, ev);
      if (!changes.length) return { success: true, sent: false, changed: 0 };
      kind = 'update';
      body = webhookBody('update', ev, buildUpdateCard(ev, before, changes, env.SITE_URL));
    }
  }
  if (!body) body = webhookBody('new', ev, buildNewCard(ev, env.SITE_URL));

  // 新規のとき: 自動の送信と重ならないよう、送信待ちの行を確保してから送る
  if (kind === 'new') {
    await env.DB.prepare(
      "INSERT INTO teams_notify (EventID, State, DueAt, Attempts) VALUES (?, 'pending', ?, 0) "
      + "ON CONFLICT(EventID) DO UPDATE SET State = 'pending', DueAt = excluded.DueAt"
    ).bind(id, t + CLAIM_SEC).run();
  }
  try {
    await postToTeams(env, body);
  } catch (e) {
    return { success: false, error: 'teams_failed', detail: String((e && e.message) || e).slice(0, 40) };
  }
  await markSent(env, id, ev);
  return { success: true, sent: true, kind, changed: changes.length };
}
