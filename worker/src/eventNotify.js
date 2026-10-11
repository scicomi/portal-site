// イベント・ミーティングの追加と編集の通知(文面と、変わった項目の判定)。設計は docs/11_pwa_push_plan.md の §5-6。
//
// 送り方: index.js の save が notifyEventSaved を呼ぶ → 送信待ち(push.js)に積む。
// 保存の直後は送らず、NOTIFY_DELAY_SEC だけ待ってから定期実行が送る。まだ送っていない間に同じイベントが保存し直されたら、
// 最初の保存の前の状態と比べ直して 1 件にまとめる(ウィザードで何度か保存しても、通知は 1 回)。
// このファイルの関数のうち、文面と判定(eventPushPayload まで)は D1 を使わないので、Node の単体テストから直接呼べる。

import { enqueuePush, cancelPush, hasPendingPush, pushEnabled } from './push.js';
import { getConfig } from './config.js';
import { parseJsonList } from './data.js';

export const NOTIFY_DELAY_SEC = 180;          // 保存してから送るまで(この間の保存し直しは 1 件にまとめる)
const BASELINE_TTL_SEC = 600;                  // 「最初の保存の前の状態」を覚えておく時間(10 分以内の編集をまとめる)
const MAX_VALUE_CHARS = 20;                    // 変更前後の値は、この長さで切る

const MEETING_CATEGORIES = ['general', 'admin'];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 通知する項目。show: 変更前後の値を文面に出すか(氏名・本文を含む項目は、項目名だけ)
// 列の並びは、イベント詳細の表示順(event-detail.js)に合わせる
export const WATCHED = [
  { key: 'title',     cols: ['Title'],                                   label: ev => isMeeting(ev) ? 'ミーティング名' : 'イベント名', show: true },
  { key: 'plan',      cols: ['PlanName'],                                label: () => '企画名', show: true },
  { key: 'leader',    cols: ['PlanLeader'],                              label: () => '企画担当者' },
  { key: 'location',  cols: ['Location'],                                label: () => '場所', show: true },
  { key: 'audience',  cols: ['Audience'],                                label: () => '対象・人数', show: true },
  { key: 'date',      cols: ['Date', 'DateEnd'],                         label: () => '日程', show: true },
  { key: 'time',      cols: ['TimeStart', 'TimeEnd'],                    label: () => '時間', show: true },
  { key: 'gather',    cols: ['GatherTime', 'DismissTime'],               label: () => '集合・解散', show: true },
  { key: 'transport', cols: ['TransportMethod'],                         label: () => '運搬方法', show: true },
  { key: 'people',    cols: ['TransportDriver', 'TransportPassengers'],  label: () => '運転者・同乗者' },
  { key: 'parts',     cols: ['PartsList'],                               label: () => '実験内容・発表者' },
  { key: 'remarks',   cols: ['Remarks'],                                 label: ev => isMeeting(ev) ? '議題・資料' : '備考' }
];
export const WATCHED_COLUMNS = Array.from(new Set(WATCHED.flatMap(w => w.cols)));

// 変更のときの通知の題名(変わった項目が 1 つだけのとき)
const SINGLE_TITLES = { date: '日程が変わりました', time: '時間が変わりました', location: '場所が変わりました' };

export function isMeeting(ev) {
  return MEETING_CATEGORIES.indexOf(String(ev && ev.Category)) >= 0;
}

const s = v => (v === null || v === undefined ? '' : String(v)).trim();

function clip(v) {
  const t = s(v).replace(/\s+/g, ' ');
  return t.length > MAX_VALUE_CHARS ? t.slice(0, MAX_VALUE_CHARS) + '…' : t;
}

// 一覧などと同じ名前(ミーティングは「第5回 全体ミーティング」)
export function eventDisplayName(ev) {
  const title = s(ev.Title) || '(無題)';
  return isMeeting(ev) && s(ev.MeetingNumber) ? '第' + s(ev.MeetingNumber) + '回 ' + title : title;
}

// 'YYYY-MM-DD' → '11/3(日)'。不正なら空
export function formatDateJP(d) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s(d));
  if (!m) return '';
  const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return (+m[2]) + '/' + (+m[3]) + '(' + WEEKDAYS[wd] + ')';
}

// 日にち(複数日は「11/3(日)〜11/4(月)」)
export function formatDateRange(ev) {
  const start = formatDateJP(ev.Date);
  const end = s(ev.DateEnd) && s(ev.DateEnd) !== s(ev.Date) ? formatDateJP(ev.DateEnd) : '';
  return start ? start + (end ? '〜' + end : '') : '';
}

function formatTimeRange(ev) {
  const a = s(ev.TimeStart), b = s(ev.TimeEnd);
  return a || b ? a + '〜' + b : '';
}

function formatGather(ev) {
  return [s(ev.GatherTime) && '集合 ' + s(ev.GatherTime), s(ev.DismissTime) && '解散 ' + s(ev.DismissTime)].filter(Boolean).join(' ');
}

// 項目の値(比べる用・表示用)。teams.js も使う
export function fieldValue(w, ev) {
  if (w.key === 'date') return formatDateRange(ev) || s(ev.Date);
  if (w.key === 'time') return formatTimeRange(ev);
  if (w.key === 'gather') return formatGather(ev);
  if (w.key === 'parts') return JSON.stringify(parseJsonList(ev.PartsList));   // 空白や書き方の違いを無視して比べる
  return w.cols.map(c => s(ev[c])).join('\u0000');
}

// 前後で変わった項目(WATCHED の要素の配列)
export function changedFields(before, after) {
  return WATCHED.filter(w => fieldValue(w, before || {}) !== fieldValue(w, after || {}));
}

// 通知の中身 { title, body, url, tag }。changes を省略すると「追加」の通知
export function eventPushPayload(ev, changes) {
  const name = eventDisplayName(ev);
  const url = 'events.html?event=' + encodeURIComponent(s(ev.ID));
  const tag = s(ev.ID);
  if (!changes) {
    const date = formatDateRange(ev);
    return {
      title: isMeeting(ev) ? '新しいミーティング' : '新しいイベント',
      body: name + (date ? ' / ' + date : '') + ' 出欠を記入して下さい',
      url, tag
    };
  }
  const before = changes.before || {};
  const fields = changes.fields || [];
  if (fields.length === 1 && fields[0].show) {
    const w = fields[0];
    const from = clip(fieldValue(w, before)) || '未定';
    const to = clip(fieldValue(w, ev)) || '未定';
    return { title: SINGLE_TITLES[w.key] || w.label(ev) + 'が変わりました', body: name + ' / ' + from + ' → ' + to, url, tag };
  }
  return { title: '内容が変わりました', body: name + ' / ' + fields.map(w => w.label(ev)).join('・'), url, tag };
}

// ---- 保存のあとに呼ぶ ----

// ローカルの結合テストだけ、.dev.vars の PUSH_NOTIFY_DELAY_SEC で待ち時間を縮める(本番では設定しない)
function notifyDelaySec(env) {
  const n = parseInt(env.PUSH_NOTIFY_DELAY_SEC, 10);
  return n >= 0 ? n : NOTIFY_DELAY_SEC;
}

async function getBaseline(env, key) {
  const row = await env.DB.prepare('SELECT V FROM kv_cache WHERE K = ? AND Exp > ?').bind(key, Math.floor(Date.now() / 1000)).first();
  if (!row) return null;
  try { return JSON.parse(row.V); } catch (_) { return null; }
}

async function putBaseline(env, key, value) {
  await env.DB.prepare('INSERT INTO kv_cache (K, V, Exp) VALUES (?, ?, ?) ON CONFLICT(K) DO UPDATE SET V = excluded.V, Exp = excluded.Exp')
    .bind(key, JSON.stringify(value), Math.floor(Date.now() / 1000) + BASELINE_TTL_SEC).run();
}

// 保存前の行(通知の判定に使う列だけ)。新規なら null
export async function loadEventBefore(env, id) {
  if (!id || typeof id !== 'string') return null;
  const cols = ['ID', 'Category', 'MeetingNumber'].concat(WATCHED_COLUMNS);
  return env.DB.prepare('SELECT ' + cols.map(c => '"' + c + '"').join(', ') + ' FROM events WHERE ID = ?').bind(id).first();
}

// created: 新規作成か。before: 保存前の行(loadEventBefore)。saved: 保存後の行。積んだ件数を返す
export async function notifyEventSaved(env, created, before, saved) {
  if (!pushEnabled(env)) return 0;
  if ((await getConfig(env, 'push_events_enabled')) === 'false') return 0;
  const id = s(saved.ID);
  const key = 'push_ev:' + id;
  const enqueue = payload => enqueuePush(env, 'events', payload, id, notifyDelaySec(env));

  if (created) {
    await putBaseline(env, key, { created: true });
    return enqueue(eventPushPayload(saved));
  }
  // まだ送っていない通知があるときだけ、その最初の保存の前の状態と比べてまとめる。送った後の編集は、新しく比べ直す
  const base = (await hasPendingPush(env, id)) ? await getBaseline(env, key) : null;
  // 追加の通知をまだ送っていない間の編集: 最新の内容で「追加」の通知を出し直す
  if (base && base.created) return enqueue(eventPushPayload(saved));
  const origin = base ? base.before : before;
  if (!base) await putBaseline(env, key, { created: false, before });
  const fields = changedFields(origin, saved);
  if (!fields.length) {
    await cancelPush(env, id);   // 元に戻した: まだ送っていない通知を取り消す
    return 0;
  }
  return enqueue(eventPushPayload(saved, { before: origin, fields }));
}
