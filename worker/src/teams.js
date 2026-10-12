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
const NBSP = ' ';   // 名前と学番の間の半角の空き(先頭の通常の空白は、表示で消えるため)
const NL = '\n';   // カードの値の中の改行(実験内容・発表者や、運転者・同乗者を 1 件ごとに分ける)
const flag = v => { const t = s(v).toLowerCase(); return t !== '' && t !== '0' && t !== 'false'; };

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

// 実験内容: 実験名だけ(発表者は出さない)
function partNames(ev) {
  return parseJsonList(ev.PartsList).map(p => s(p && p.name)).filter(Boolean);
}

// 人名の並び(カンマ区切りで保存されている)
export function splitNames(v) {
  return s(v).split(/[,、，]/).map(s).filter(Boolean);
}

function docText(notRequired, person) {
  return flag(notRequired) ? '不要' : s(person);
}

// 項目の見せ方(変更のカードの「そのほか」に出す値。空は呼び出し側で「ー」にする)
function display(w, ev) {
  switch (w.key) {
    case 'date': return dateTimeText(Object.assign({}, ev, { TimeStart: '', TimeEnd: '' }));
    case 'parts': return partNames(ev).join(NL);
    case 'kyoka': return docText(ev.KyokaNotRequired, ev.AdminKyoka);
    case 'houkoku': return docText(ev.HoukokuNotRequired, ev.AdminHoukoku);
    case 'people': return [s(ev.TransportDriver) && '運転者: ' + s(ev.TransportDriver), s(ev.TransportPassengers) && '同乗者: ' + s(ev.TransportPassengers)].filter(Boolean).join(NL);
    default: return fieldValue(w, ev).split('\u0000').map(s).filter(Boolean).join(' / ');
  }
}

// 比べるための値。実験は、実験名だけで比べる(発表者だけが変わっても「変更」にしない。カードに出さないため)
function valueFor(w, ev) {
  return w.key === 'parts' ? partNames(ev).join(NL) : fieldValue(w, ev);
}

// 空の値は「ー」で表す
const dash = v => s(v) || 'ー';

// カードに並べる項目。keys: その項目が変わったと判断する WATCHED / DOC_FIELDS の key(変更のカードで印を付ける)
// group: 同じ番号の項目を 1 つのかたまりにして、かたまりの間に区切り線を入れる(題名は見出しに出すので、ここには入れない)
// type: 'text' = 文章 / 'list' = 箇条書き(1 行 1 件) / 'people' = 人名(カンマ区切り。学番を添える)
function cardRows(ev) {
  if (isMeeting(ev)) {
    return [
      { label: '日時', group: 1, keys: ['date', 'time'], type: 'text', value: dateTimeText(ev) },
      { label: '場所', group: 1, keys: ['location'], type: 'text', value: s(ev.Location) },
      { label: '議題', group: 2, keys: ['remarks'], type: 'text', value: s(ev.Remarks) }
    ];
  }
  return [
    { label: 'イベント日時', group: 1, keys: ['date', 'time'], type: 'text', value: dateTimeText(ev) },
    { label: '場所', group: 1, keys: ['location'], type: 'text', value: s(ev.Location) },
    { label: '企画担当者', group: 1, keys: ['leader'], type: 'people', value: s(ev.PlanLeader) },
    { label: '実験内容', group: 2, keys: ['parts'], type: 'list', value: partNames(ev).join(NL) },
    { label: '許可願担当', group: 3, keys: ['kyoka'], type: 'people', value: docText(ev.KyokaNotRequired, ev.AdminKyoka) },
    { label: '報告書担当', group: 3, keys: ['houkoku'], type: 'people', value: docText(ev.HoukokuNotRequired, ev.AdminHoukoku) }
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
  // msteams.width: 'Full' で、Teams のカードを横幅いっぱいに広げる
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', msteams: { width: 'Full' }, body, actions };
}

// 見出し: 種類の文言(小) → 題名(大)
function header(style, color, lead, name) {
  return { type: 'Container', style, bleed: true, items: [
    { type: 'TextBlock', text: lead, weight: 'Bolder', color, wrap: true },
    { type: 'TextBlock', text: name, weight: 'Bolder', size: 'ExtraLarge', wrap: true, spacing: 'Small' }
  ] };
}

// 長い文章(3 行を超える、または 90 文字を超える)は、先頭だけを出して、「続きを表示」で全文を開く
const FOLD_LINES = 3;
const FOLD_CHARS = 90;

// 折りたたむなら、先頭だけの文を返す。折りたたまないなら ''
export function foldShort(v) {
  const t = s(v);
  const lines = t.split(NL);
  if (lines.length <= FOLD_LINES && t.length <= FOLD_CHARS) return '';
  const head = lines.slice(0, FOLD_LINES).join(NL);
  return (head.length > FOLD_CHARS ? head.slice(0, FOLD_CHARS) : head) + '…';
}

// 折りたたみの部品: 先頭だけ / 全文(最初は隠す) / 「続きを表示」「閉じる」のボタン
function foldBlocks(n, value, short) {
  const ids = ['fs' + n, 'ff' + n, 'fo' + n, 'fc' + n];
  return [
    { type: 'TextBlock', id: ids[0], text: short, size: 'Medium', wrap: true, spacing: 'None' },
    { type: 'TextBlock', id: ids[1], text: value, size: 'Medium', wrap: true, spacing: 'None', isVisible: false },
    { type: 'ActionSet', spacing: 'Small', actions: [
      { type: 'Action.ToggleVisibility', id: ids[2], title: '続きを表示', targetElements: ids },
      { type: 'Action.ToggleVisibility', id: ids[3], title: '閉じる', isVisible: false, targetElements: ids }
    ] }
  ];
}

// 値の部品。項目名は小さく薄い文字、値は大きめの文字にして、スマホでも項目名と値を取り違えにくくする
function valueBlocks(r, ids, counter) {
  if (r.type === 'list') {
    const lines = s(r.value).split(NL).filter(Boolean);
    return [{ type: 'TextBlock', text: lines.length ? lines.map(l => '・' + l).join(NL) : 'ー', size: 'Medium', wrap: true, spacing: 'None' }];
  }
  if (r.type === 'people') {
    const names = splitNames(r.value);
    if (!names.length) return [{ type: 'TextBlock', text: 'ー', size: 'Medium', wrap: true, spacing: 'None' }];
    // 名前の横に、学番を小さく薄い文字で添える(メンバー表で 1 人に決まるときだけ)
    return names.map((n, i) => {
      const sid = (ids && ids[n]) || '';
      const name = { type: 'TextBlock', text: n, size: 'Medium', wrap: true };
      if (!sid) return Object.assign(name, { spacing: i ? 'Small' : 'None' });
      return { type: 'ColumnSet', spacing: i ? 'Small' : 'None', columns: [
        { type: 'Column', width: 'auto', items: [name] },
        { type: 'Column', width: 'auto', spacing: 'None', verticalContentAlignment: 'Center', items: [{ type: 'TextBlock', text: NBSP + sid, size: 'Small', isSubtle: true, wrap: false }] }
      ] };
    });
  }
  const short = foldShort(r.value);
  if (short) { counter.n += 1; return foldBlocks(counter.n, s(r.value), short); }
  return [{ type: 'TextBlock', text: dash(r.value), size: 'Medium', wrap: true, spacing: 'None' }];
}

// 1 項目: 項目名(小さく薄い。変更の印があれば、横に小さく薄く) の下に、値
function rowContainer(r, kind, ids, counter) {
  // 項目名は、小さい青い文字(Accent は、ライト・ダークのどちらのテーマでも読める色)。
  // 追記・変更の印は、色なしの小さい薄い文字を、括弧つきで、項目名のすぐ横に出す(列の間隔をなくして詰める)
  const label = { type: 'TextBlock', text: r.label, size: 'Small', color: 'Accent', wrap: false };
  const head = kind
    ? { type: 'ColumnSet', columns: [
        { type: 'Column', width: 'auto', items: [label] },
        { type: 'Column', width: 'auto', spacing: 'None', items: [{ type: 'TextBlock', text: '(' + kind + ')', size: 'Small', isSubtle: true, wrap: false }] }
      ] }
    : Object.assign(label, { wrap: true });
  return { type: 'Container', spacing: 'Small', items: [head].concat(valueBlocks(r, ids, counter)) };
}

// カード全体。marks: { 項目の番号: '追記' | '変更' | '削除' }(変更のカードだけ)、extras: カードの項目にない変更 [{ label, type, value, kind }]
function renderCard(ev, links, opts) {
  const rows = cardRows(ev);
  const marks = opts.marks || {};
  const ids = opts.ids || {};
  const counter = { n: 0 };
  const groups = [];
  rows.forEach((r, i) => {
    let g = groups.find(x => x.no === r.group);
    if (!g) { g = { no: r.group, items: [] }; groups.push(g); }
    g.items.push(rowContainer(r, marks[i] || '', ids, counter));
  });
  const extras = opts.extras || [];
  if (extras.length) groups.push({ no: 'extra', items: extras.map(x => rowContainer(x, x.kind, ids, counter)) });
  const body = [header(opts.style, opts.color, opts.lead, eventDisplayName(ev))]
    .concat(groups.map(g => ({ type: 'Container', separator: true, spacing: 'Medium', items: g.items })));
  if (opts.note) body.push({ type: 'TextBlock', text: opts.note, size: 'Small', isSubtle: true, wrap: true, spacing: 'Medium' });
  return cardShell(body, links);
}

// 新規のカード(イベント / ミーティング)。ids: 名前 → 学番
export function buildNewCard(ev, site, ids) {
  const links = eventLinks(site, ev);
  if (isMeeting(ev)) {
    const kind = MEETING_NAMES[s(ev.Category)] || 'ミーティング';
    return renderCard(ev, links, { style: 'attention', color: 'Attention', lead: kind + 'が登録されました', ids });
  }
  return renderCard(ev, links, { style: 'accent', color: 'Accent', lead: '新しいイベントが登録されました', ids });
}

// 前回 Teams へ送った内容(before)と今(after)の差。[{ w, label, from, to }]
export function diffTeams(before, after) {
  const out = [];
  TEAMS_FIELDS.forEach(w => {
    if (valueFor(w, before || {}) === valueFor(w, after || {})) return;
    out.push({ w, label: w.key === 'parts' ? '実験内容' : w.label(after), from: display(w, before || {}), to: display(w, after) });
  });
  return out;
}

// 追記(前が空で、今は入っている) / 削除(前は入っていて、今は空) / 変更(それ以外)
export function changeKind(from, to) {
  const a = s(from), b = s(to);
  if (!a && b) return '追記';
  if (a && !b) return '削除';
  return '変更';
}

// 変更のカード。新規と同じ項目を全部並べ、変わった項目の名前の横に「追記」「変更」「削除」を、小さく薄い文字で付ける。
// 値は、変更後のものだけを出す(変更前は出さない)。before: 前回 Teams へ送った内容、changes: diffTeams(before, ev) の結果
export function buildUpdateCard(ev, before, changes, site, ids) {
  const rows = cardRows(ev);
  const prev = cardRows(Object.assign({}, before, { Category: ev.Category, MeetingNumber: ev.MeetingNumber }));
  const changedKeys = new Set(changes.map(c => c.w.key));
  const marks = {};
  const kinds = [];
  rows.forEach((r, i) => {
    if (!r.keys.some(k => changedKeys.has(k))) return;
    marks[i] = changeKind(prev[i].value, r.value);
    kinds.push(marks[i]);
  });
  // カードの項目にない変更は、末尾のかたまりにまとめる(題名・運転者と同乗者・備考・対象・運搬方法など)
  const extras = [];
  const shown = new Set(rows.flatMap(r => r.keys));
  changes.filter(c => !shown.has(c.w.key)).forEach(c => {
    if (c.w.key === 'people') {
      const kind = changeKind(c.from, c.to);
      kinds.push(kind);
      const filled = [['運転者', ev.TransportDriver], ['同乗者', ev.TransportPassengers]].filter(p => s(p[1]));
      if (filled.length) filled.forEach(p => extras.push({ label: p[0], type: 'people', value: s(p[1]), kind }));
      else extras.push({ label: '運転者・同乗者', type: 'text', value: '', kind });   // 両方とも空になった(削除)
      return;
    }
    const kind = changeKind(c.from, c.to);
    kinds.push(kind);
    extras.push({ label: c.label, type: 'text', value: c.to, kind });
  });
  const what = isMeeting(ev) ? 'ミーティング' : 'イベント';
  const verb = kinds.length && kinds.every(k => k === '追記') ? '追記' : kinds.length && kinds.every(k => k === '変更') ? '変更' : '更新';
  return renderCard(ev, eventLinks(site, ev), {
    style: 'warning', color: 'Warning', lead: what + 'の内容が' + verb + 'されました',
    marks, extras, ids
  });
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

// カードの名前の横に添える学番。イベントに出てくる名前を、メンバー表で引く。
// 同じ名前でも学番が 1 つに決まるときだけ使う(同姓同名・未登録は添えない)。引けなくても、通知は送る
export async function loadStudentIds(env, ev) {
  try {
    const names = Array.from(new Set([ev.PlanLeader, ev.AdminKyoka, ev.AdminHoukoku, ev.TransportDriver, ev.TransportPassengers].flatMap(splitNames))).slice(0, 50);
    if (!names.length) return {};
    const rows = (await env.DB.prepare('SELECT Name, StudentID FROM members WHERE Name IN (' + names.map(() => '?').join(',') + ')').bind(...names).all()).results || [];
    const byName = {};
    rows.forEach(r => {
      const sid = s(r.StudentID);
      if (sid) (byName[r.Name] = byName[r.Name] || new Set()).add(sid);
    });
    const out = {};
    Object.keys(byName).forEach(n => { if (byName[n].size === 1) out[n] = Array.from(byName[n])[0]; });
    return out;
  } catch (e) {
    console.error('loadStudentIds failed: ' + (e && e.message || e));
    return {};
  }
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
      await postToTeams(env, webhookBody('new', ev, buildNewCard(ev, env.SITE_URL, await loadStudentIds(env, ev))));
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
      body = webhookBody('update', ev, buildUpdateCard(ev, before, changes, env.SITE_URL, await loadStudentIds(env, ev)));
    }
  }
  if (!body) body = webhookBody('new', ev, buildNewCard(ev, env.SITE_URL, await loadStudentIds(env, ev)));

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
