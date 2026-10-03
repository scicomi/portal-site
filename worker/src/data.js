// データ層: リソースの CRUD、出欠投票、監査ログ(D1)

import { getResource, RESOURCES } from './tables.js';
import { str, sha256Hex, jstIso, endOfDayJst, ApiError } from './util.js';
import { getConfigInt } from './config.js';

const q = c => '"' + c + '"';

// ---- 行 → API 用オブジェクト ----

export function rowToObj(res, row) {
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

export function genId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function cellValue(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object') return JSON.stringify(val);      // 配列・オブジェクトは JSON 文字列で保存
  return String(val);                                            // 数値・真偽値も文字列(一覧の返却形式と揃える)
}

// 1 列・1 行の大きさの上限(UTF-8 のバイト数)。D1 は 1 行 2MB が上限で、超えると保存が internal_error になる。
// また、全員が初回表示で一覧(listAll)を読み込むので、異常に長い値が 1 件あるだけでサイト全体が重くなる。
const SHORT_COLUMNS = ['Title', 'Name', 'Furigana', 'SiteName', 'StudentID', 'Category', 'Role'];   // 題名・氏名など
const LONG_COLUMNS = ['Body', 'Sections', 'Remarks', 'Reflections', 'Positives'];                   // ガイド本文・セクション・備考・振り返り
const SHORT_MAX_BYTES = 2000;      // 日本語で約 660 字
const LONG_MAX_BYTES = 500000;     // 日本語で約 16 万字
const CELL_MAX_BYTES = 100000;     // その他の列(添付・写真などの JSON の列を含む)
const ROW_MAX_BYTES = 1500000;     // 1 回の保存で送る列の合計

// 大きすぎる値は保存しない(detail は超えた列名。合計の超過は '')
function checkCellSizes(item, cols) {
  const enc = new TextEncoder();
  let total = 0;
  for (const c of cols) {
    const n = enc.encode(cellValue(item[c])).length;
    const max = SHORT_COLUMNS.indexOf(c) >= 0 ? SHORT_MAX_BYTES : LONG_COLUMNS.indexOf(c) >= 0 ? LONG_MAX_BYTES : CELL_MAX_BYTES;
    if (n > max) throw new ApiError('too_large', c);
    total += n;
  }
  if (total > ROW_MAX_BYTES) throw new ApiError('too_large', '');
}

export class ConflictError extends Error {
  constructor() { super('conflict'); this.name = 'ConflictError'; }
}

// ID に使える文字。genId(フロントの app.js / この worker / 旧 GAS)は「接頭辞 + epoch + '_' + 英数字」なので収まる。
// onclick 属性などに ID を埋め込むフロントがあるため、引用符などの記号を含む ID は受け付けない。
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// 保存でレコードから外された項目(添付ファイル・写真・動画・振り返り・セクション)は、消さずにゴミ箱へ移す。
// 対象は JSON 配列の列で、要素を一意に識別するキーを返す関数を持つ(キーが空の要素は比較から除外する)。
// Sections は要素の識別子が無いため、見出しで照合する(件数が減ったときだけ外れた分を拾う)。
// single: 1 ファイルだけ持つ列(復元時に枠が埋まっていれば戻せない)。 label: 一覧に出す名前。
const fileKey = f => str(f && (f.driveId || f.url));
const idKey = e => str(e && e.id);
const sectionKey = s => str(s && s.title);
const fileLabel = f => str(f && f.name) || 'ファイル';
const snippet = (t, n) => { const s = str(t).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
export const TRASH_ITEM_RULES = {
  events: {
    Files:       { key: fileKey, label: fileLabel },
    RequestDoc:  { key: fileKey, label: fileLabel, single: true },
    KyokaDoc:    { key: fileKey, label: fileLabel, single: true },
    HoukokuDoc:  { key: fileKey, label: fileLabel, single: true },
    MeetingDocs: { key: fileKey, label: fileLabel },
    Minutes:     { key: fileKey, label: fileLabel, single: true },
  },
  experiments: {
    Photos:      { key: fileKey, label: fileLabel },
    Videos:      { key: idKey, label: v => str(v && (v.title || v.url)) || '動画' },
    Reflections: { key: idKey, label: e => snippet(e && e.text, 30) || '振り返り' },
    Positives:   { key: idKey, label: e => snippet(e && e.text, 30) || '良かった点' },
    Sections:    { key: sectionKey, label: s => str(s && s.title) || 'セクション', countOnly: true },
  },
  passwords: {
    Photos: { key: fileKey, label: fileLabel },
  },
};
// レコードの表示名の列(ゴミ箱の一覧用)
export const TRASH_LABEL_COLUMN = { events: 'Title', members: 'Name', experiments: 'Name', passwords: 'SiteName' };

export function parseJsonList(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

// 保存で外れた項目を、ゴミ箱へ入れる INSERT 文にする。
// 更新(UPDATE)が成功したとき(changes() > 0)だけ入るよう条件を付け、競合で更新されなかった場合は入れない。
// item にキーが無い列は更新されないので対象外。
async function removedItemStatements(env, name, res, item, now) {
  const rules = TRASH_ITEM_RULES[name];
  if (!rules) return [];
  const cols = Object.keys(rules).filter(c => item[c] !== undefined);
  if (cols.length === 0) return [];
  const labelCol = TRASH_LABEL_COLUMN[name];
  const row = await env.DB.prepare('SELECT ' + cols.concat(labelCol).map(q).join(', ') + ' FROM ' + res.table + ' WHERE ID = ?').bind(item.ID).first();
  if (!row) return [];
  const keepDays = await getConfigInt(env, 'trash_keep_days', 7);
  const expires = new Date(Date.parse(now) + keepDays * 86400000).toISOString();
  const stmts = [];
  for (const c of cols) {
    const rule = rules[c];
    const before = parseJsonList(row[c]);
    const after = parseJsonList(item[c]);
    let removed;
    if (rule.countOnly) {
      // 件数が減ったときだけ。外れたのは、残った見出しの数を差し引いても余る分
      if (after.length >= before.length) continue;
      const left = new Map();
      after.map(rule.key).forEach(k => left.set(k, (left.get(k) || 0) + 1));
      removed = before.filter(it => {
        const k = rule.key(it);
        if (left.get(k) > 0) { left.set(k, left.get(k) - 1); return false; }
        return true;
      });
    } else {
      const kept = new Set(after.map(rule.key).filter(Boolean));
      removed = before.filter(it => { const k = rule.key(it); return k && !kept.has(k); });
    }
    for (const it of removed) {
      stmts.push(env.DB.prepare(
        'INSERT INTO trash (ID, Kind, Resource, RecordID, Field, Label, RecordLabel, Payload, Votes, DeletedAt, ExpiresAt) ' +
        "SELECT ?, 'item', ?, ?, ?, ?, ?, ?, '', ?, ? WHERE changes() > 0"
      ).bind(genId('tr_'), name, item.ID, c, rule.label(it), str(row[labelCol]), JSON.stringify(it), now, expires));
    }
  }
  return stmts;
}

// 1 行を保存(upsert)し、{ item: 保存後の行, created: 新規作成か } を返す。
// 更新は「item にキーがある列だけ」を書き換える(キーが無い列は既存値を保持。'' や null が来た列は空にする)。
// 競合検知: クライアントが編集開始時に読んだ版(_baseUpdatedAt)と、現在の UpdatedAt が食い違えば
// 別の人が先に更新したとみなして ConflictError。UPDATE 文の条件で判定するため原子的に行われる。
// 既存の添付・写真・動画・振り返り・セクションが減る更新は、外れた項目をゴミ箱へ入れる(removedItemStatements)。
export async function saveResource(env, name, item) {
  const res = getResource(name);
  if (!res) throw new Error('unknown resource: ' + name);
  item = Object.assign({}, item);
  const now = new Date().toISOString();

  const hasId = item.ID !== undefined && item.ID !== null && item.ID !== '';
  if (hasId && (typeof item.ID !== 'string' || !ID_PATTERN.test(item.ID))) throw new ApiError('invalid_id');
  checkCellSizes(item, res.columns.filter(c => item[c] !== undefined));

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
    const values = res.columns.map(c => cellValue(item[c]));
    // SELECT から INSERT までの間に同じ ID が作られていたら、PK 違反の例外ではなく競合として返す
    const sql = 'INSERT INTO ' + res.table + ' (' + res.columns.map(q).join(', ') + ') VALUES (' +
      res.columns.map(() => '?').join(', ') + ') ON CONFLICT(ID) DO NOTHING';
    const r = await env.DB.prepare(sql).bind(...values).run();
    if (!(r.meta && r.meta.changes > 0)) throw new ConflictError();
  } else {
    // 更新は item にキーがある列だけ。ID・CreatedAt はクライアントの値で書き換えさせない。UpdatedAt は必ず更新する
    const cols = res.columns.filter(c => c !== 'ID' && c !== 'CreatedAt' && (c === 'UpdatedAt' || item[c] !== undefined));
    if (cols.length > 0) {
      const binds = cols.map(c => cellValue(item[c]));
      let sql = 'UPDATE ' + res.table + ' SET ' + cols.map(c => q(c) + ' = ?').join(', ') + ' WHERE ID = ?';
      binds.push(item.ID);
      if (hasBase) { sql += ' AND UpdatedAt = ?'; binds.push(String(item._baseUpdatedAt)); }
      // 外れた項目のゴミ箱への INSERT は、UPDATE と同じ batch(=1 トランザクション)で行う
      const trashStmts = await removedItemStatements(env, name, res, item, now);
      const out = await env.DB.batch([env.DB.prepare(sql).bind(...binds), ...trashStmts]);
      const r = out[0];
      if (!(r.meta && r.meta.changes > 0)) throw new ConflictError();   // 判定後に別の更新・削除が入った
    }
  }

  // 返すのは保存後の行全体(送らなかった列も既存値で返し、フロントのキャッシュを欠けさせない)
  const row = await env.DB.prepare('SELECT ' + res.columns.map(q).join(', ') + ' FROM ' + res.table + ' WHERE ID = ?').bind(item.ID).first();
  if (!row) throw new ConflictError();                                     // 保存直後に別の人が削除した
  return { item: rowToObj(res, row), created: isNewRow };
}

// 完全に削除する(ゴミ箱を通さない)。使うのは、ゴミ箱の対象外のガイドだけ。
// イベント・メンバーの削除は、出欠投票の連鎖削除を含めて trash.js の moveRecordToTrash が行う。
export async function deleteResource(env, name, id) {
  const res = getResource(name);
  if (name !== 'guides' || !res || !id) return false;
  const out = await env.DB.prepare('DELETE FROM ' + res.table + ' WHERE ID = ?').bind(String(id)).run();
  return !!(out.meta && out.meta.changes > 0);
}

// ---- 出欠投票 ----

const VOTES_SELECT = 'SELECT EventID, MemberID, Status, UpdatedAt, Note FROM event_votes ORDER BY rowid';

function voteRowToObj(r) {
  return { eventId: str(r.EventID), memberId: str(r.MemberID), status: str(r.Status), updatedAt: str(r.UpdatedAt), note: str(r.Note) };
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
// メンバーとイベントが実在するときだけ書く(無ければ null)。実在しない ID の行は、削除の連鎖でも消えずに残るため。
// 判定と書き込みを 1 文で行うので、判定の直後に削除されても孤児の行はできない。
export async function upsertVote(env, v) {
  const now = new Date().toISOString();
  const note = (v.note === undefined || v.note === null) ? null : String(v.note).slice(0, 100);
  const eventId = String(v.eventId), memberId = String(v.memberId);
  const out = await env.DB.prepare(
    'INSERT INTO event_votes (EventID, MemberID, Status, UpdatedAt, Note) SELECT ?1, ?2, ?3, ?4, COALESCE(?5, \'\') ' +
    'WHERE EXISTS (SELECT 1 FROM events WHERE ID = ?1) AND EXISTS (SELECT 1 FROM members WHERE ID = ?2) ' +
    'ON CONFLICT(EventID, MemberID) DO UPDATE SET Status = excluded.Status, UpdatedAt = excluded.UpdatedAt, ' +
    'Note = CASE WHEN ?5 IS NULL THEN Note ELSE excluded.Note END'
  ).bind(eventId, memberId, String(v.status), now, note).run();
  if (!(out.meta && out.meta.changes > 0)) return null;
  const row = await env.DB.prepare('SELECT Note FROM event_votes WHERE EventID = ? AND MemberID = ?').bind(eventId, memberId).first();
  return { eventId, memberId, status: String(v.status), updatedAt: now, note: row ? str(row.Note) : '' };
}

// ---- 監査ログ ----
// 共通パスワード運用のため個人特定はできないが、操作種別・対象・ロール・トークン識別子を残す。

// 監査ログの詳細(リソース名と ID、ファイル名など)は、この長さで切る(クライアントが送る値をそのまま溜めないため)
const AUDIT_DETAIL_MAX = 200;

export async function appendAuditLog(env, action, detail, token, role) {
  try {
    const tokenHash = token ? (await sha256Hex(token)).slice(0, 12) : '';
    await env.DB.prepare('INSERT INTO audit_log (Timestamp, Action, Detail, TokenHash, Role) VALUES (?, ?, ?, ?, ?)')
      .bind(jstIso(), action, str(detail).slice(0, AUDIT_DETAIL_MAX), tokenHash, role || '').run();
  } catch (e) {
    console.error('AuditLog write failed: ' + e);
  }
}

export async function trimAuditLog(env, keepDays) {
  const cutoff = jstIso(new Date(Date.now() - (keepDays || 365) * 86400 * 1000));
  await env.DB.prepare('DELETE FROM audit_log WHERE Timestamp < ?').bind(cutoff).run();
}
