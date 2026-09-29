// データ層: リソースの CRUD、出欠投票、監査ログ(D1)

import { getResource, RESOURCES } from './tables.js';
import { str, sha256Hex, jstIso, endOfDayJst, ApiError } from './util.js';

const q = c => '"' + c + '"';

// ---- 行 → API 用オブジェクト ----

function rowToObj(res, row) {
  const obj = {};
  res.columns.forEach(c => { obj[c] = str(row[c]); });
  res.jsonFields.forEach(f => {
    if (obj[f]) {
      try { obj[f] = JSON.parse(obj[f]); } catch (_) { obj[f] = []; }
    } else {
      obj[f] = [];
    }
  });
  return obj;
}

function selectAllSql(res) {
  return 'SELECT ' + res.columns.map(q).join(', ') + ' FROM ' + res.table + ' ORDER BY rowid';
}

export async function listResource(env, name) {
  const res = getResource(name);
  if (!res) return [];
  const { results } = await env.DB.prepare(selectAllSql(res)).all();
  return (results || []).map(r => rowToObj(res, r));
}

// events / members / experiments / votes を 1 回の往復で取得する
export async function listAllData(env) {
  const names = ['events', 'members', 'experiments'];
  const stmts = names.map(n => env.DB.prepare(selectAllSql(RESOURCES[n])));
  stmts.push(env.DB.prepare(VOTES_SELECT));
  const out = await env.DB.batch(stmts);
  const data = {};
  names.forEach((n, i) => { data[n] = (out[i].results || []).map(r => rowToObj(RESOURCES[n], r)); });
  data.votes = (out[3].results || []).map(voteRowToObj);
  return data;
}

// ---- 保存・削除 ----

function genId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function cellValue(res, col, val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object') return JSON.stringify(val);      // 配列・オブジェクトは JSON 文字列で保存
  return String(val);                                            // 数値・真偽値も文字列(一覧の返却形式と揃える)
}

export class ConflictError extends Error {
  constructor() { super('conflict'); this.name = 'ConflictError'; }
}

// ID に使える文字。genId(フロントの app.js / この worker / 旧 GAS)は「接頭辞 + epoch + '_' + 英数字」なので収まる。
// onclick 属性などに ID を埋め込むフロントがあるため、引用符などの記号を含む ID は受け付けない。
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// 1 行を保存(upsert)し、{ item: 保存後の行, created: 新規作成か } を返す。
// 更新は「item にキーがある列だけ」を書き換える(キーが無い列は既存値を保持。'' や null が来た列は空にする)。
// 競合検知: クライアントが編集開始時に読んだ版(_baseUpdatedAt)と、現在の UpdatedAt が食い違えば
// 別の人が先に更新したとみなして ConflictError。UPDATE 文の条件で判定するため原子的に行われる。
export async function saveResource(env, name, item) {
  const res = getResource(name);
  if (!res) throw new Error('unknown resource: ' + name);
  item = Object.assign({}, item);
  const now = new Date().toISOString();

  const hasId = item.ID !== undefined && item.ID !== null && item.ID !== '';
  if (hasId && (typeof item.ID !== 'string' || !ID_PATTERN.test(item.ID))) throw new ApiError('invalid_id');

  let existing = null;
  if (hasId) {
    existing = await env.DB.prepare('SELECT ID, CreatedAt, UpdatedAt FROM ' + res.table + ' WHERE ID = ?').bind(item.ID).first();
  }
  const isNewRow = !existing;
  if (!hasId) item.ID = genId(res.idPrefix);

  const hasBase = item._baseUpdatedAt !== undefined && item._baseUpdatedAt !== null && item._baseUpdatedAt !== '';
  if (existing && hasBase && str(existing.UpdatedAt) !== String(item._baseUpdatedAt)) throw new ConflictError();
  // 編集の基準(_baseUpdatedAt)があるのに行が無い = 編集中に別の人が削除した。復活させず競合として返す(削除の Undo は基準を付けずに再作成する)
  if (!existing && hasBase) throw new ConflictError();

  const hasCreatedAt = res.columns.indexOf('CreatedAt') >= 0;
  const hasUpdatedAt = res.columns.indexOf('UpdatedAt') >= 0;
  if (hasUpdatedAt) item.UpdatedAt = now;

  if (isNewRow) {
    // 新規は全列を書く(無い列は '')。削除 UNDO の再作成など、元の作成日時が来ていればそれを尊重する
    if (hasCreatedAt && (item.CreatedAt === undefined || item.CreatedAt === null || item.CreatedAt === '')) item.CreatedAt = now;
    const values = res.columns.map(c => cellValue(res, c, item[c]));
    // SELECT から INSERT までの間に同じ ID が作られていたら、PK 違反の例外ではなく競合として返す
    const sql = 'INSERT INTO ' + res.table + ' (' + res.columns.map(q).join(', ') + ') VALUES (' +
      res.columns.map(() => '?').join(', ') + ') ON CONFLICT(ID) DO NOTHING';
    const r = await env.DB.prepare(sql).bind(...values).run();
    if (!(r.meta && r.meta.changes > 0)) throw new ConflictError();
  } else {
    // 更新は item にキーがある列だけ。ID・CreatedAt はクライアントの値で書き換えさせない。UpdatedAt は必ず更新する
    const cols = res.columns.filter(c => c !== 'ID' && c !== 'CreatedAt' && (c === 'UpdatedAt' || item[c] !== undefined));
    if (cols.length > 0) {
      const binds = cols.map(c => cellValue(res, c, item[c]));
      let sql = 'UPDATE ' + res.table + ' SET ' + cols.map(c => q(c) + ' = ?').join(', ') + ' WHERE ID = ?';
      binds.push(item.ID);
      if (hasBase) { sql += ' AND UpdatedAt = ?'; binds.push(String(item._baseUpdatedAt)); }
      const r = await env.DB.prepare(sql).bind(...binds).run();
      if (!(r.meta && r.meta.changes > 0)) throw new ConflictError();   // 判定後に別の更新・削除が入った
    }
  }

  // 返すのは保存後の行全体(送らなかった列も既存値で返し、フロントのキャッシュを欠けさせない)
  const row = await env.DB.prepare('SELECT ' + res.columns.map(q).join(', ') + ' FROM ' + res.table + ' WHERE ID = ?').bind(item.ID).first();
  if (!row) throw new ConflictError();                                     // 保存直後に別の人が削除した
  return { item: rowToObj(res, row), created: isNewRow };
}

// 出欠投票(event_votes)が参照する resource。削除時に同じ batch(=1 トランザクション)で該当行を消し、孤児を残さない。
const VOTE_OWNER_COLUMN = { events: 'EventID', members: 'MemberID' };

export async function deleteResource(env, name, id) {
  const res = getResource(name);
  if (!res || !id) return false;
  const stmts = [env.DB.prepare('DELETE FROM ' + res.table + ' WHERE ID = ?').bind(String(id))];
  const voteCol = VOTE_OWNER_COLUMN[name];
  if (voteCol) stmts.push(env.DB.prepare('DELETE FROM event_votes WHERE ' + voteCol + ' = ?').bind(String(id)));
  const out = await env.DB.batch(stmts);
  return !!(out[0].meta && out[0].meta.changes > 0);
}

// ---- 出欠投票 ----

const VOTES_SELECT = 'SELECT EventID, MemberID, Status, UpdatedAt, Note FROM event_votes ORDER BY rowid';

function voteRowToObj(r) {
  return { eventId: str(r.EventID), memberId: str(r.MemberID), status: str(r.Status), updatedAt: str(r.UpdatedAt), note: str(r.Note) };
}

export async function listAllVotes(env) {
  const { results } = await env.DB.prepare(VOTES_SELECT).all();
  return (results || []).map(voteRowToObj);
}

export async function listEventVotes(env, eventId) {
  const { results } = await env.DB.prepare(
    'SELECT EventID, MemberID, Status, UpdatedAt, Note FROM event_votes WHERE EventID = ? ORDER BY rowid'
  ).bind(String(eventId)).all();
  return (results || []).map(voteRowToObj);
}

// 出欠締切(VoteDeadline → DateEnd → Date の順。未設定ならイベントの日付)を過ぎているか。
// イベントが無ければ null を返す。
export async function voteDeadlinePassed(env, eventId) {
  const ev = await env.DB.prepare('SELECT VoteDeadline, DateEnd, Date FROM events WHERE ID = ?').bind(String(eventId)).first();
  if (!ev) return null;
  const dl = ev.VoteDeadline || ev.DateEnd || ev.Date;
  const end = endOfDayJst(dl);
  return end !== null && end < Date.now();
}

// 投票の upsert。note 未指定(旧クライアント・ホームの一括回答)なら既存メモを保持する。
export async function upsertVote(env, v) {
  const now = new Date().toISOString();
  const note = (v.note === undefined || v.note === null) ? null : String(v.note).slice(0, 100);
  const eventId = String(v.eventId), memberId = String(v.memberId);
  await env.DB.prepare(
    'INSERT INTO event_votes (EventID, MemberID, Status, UpdatedAt, Note) VALUES (?1, ?2, ?3, ?4, COALESCE(?5, \'\')) ' +
    'ON CONFLICT(EventID, MemberID) DO UPDATE SET Status = excluded.Status, UpdatedAt = excluded.UpdatedAt, ' +
    'Note = CASE WHEN ?5 IS NULL THEN Note ELSE excluded.Note END'
  ).bind(eventId, memberId, String(v.status), now, note).run();
  const row = await env.DB.prepare('SELECT Note FROM event_votes WHERE EventID = ? AND MemberID = ?').bind(eventId, memberId).first();
  return { eventId, memberId, status: String(v.status), updatedAt: now, note: row ? str(row.Note) : '' };
}

// ---- 監査ログ ----
// 共通パスワード運用のため個人特定はできないが、操作種別・対象・ロール・トークン識別子を残す。

export async function appendAuditLog(env, action, detail, token, role) {
  try {
    const tokenHash = token ? (await sha256Hex(token)).slice(0, 12) : '';
    await env.DB.prepare('INSERT INTO audit_log (Timestamp, Action, Detail, TokenHash, Role) VALUES (?, ?, ?, ?, ?)')
      .bind(jstIso(), action, str(detail), tokenHash, role || '').run();
  } catch (e) {
    console.error('AuditLog write failed: ' + e);
  }
}

export async function trimAuditLog(env, keepDays) {
  const cutoff = jstIso(new Date(Date.now() - (keepDays || 365) * 86400 * 1000));
  await env.DB.prepare('DELETE FROM audit_log WHERE Timestamp < ?').bind(cutoff).run();
}
