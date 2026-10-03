// ゴミ箱。削除したレコード(イベント・メンバー・実験ネタ・パスワード)と、レコードから外した項目
// (添付ファイル・写真・動画・振り返り・セクション。外れた項目の保管は data.js の saveResource が行う)を、
// 一定期間(config の trash_keep_days、既定 7 日)保管する。期限が来たものは完全に削除し、R2 のファイル実体もそのとき消す。
// 一覧には Payload(削除前の中身)を返さない(メンバーの個人情報などを必要以上に流さないため)。
//
// ガイド(guides)は対象外(従来どおり管理者だけが完全に削除する)。
// パスワード(passwords)は、削除・一覧・復元・完全削除のすべてで管理者トークンを必須にする(index.js 側で判定)。

import { getResource, RESOURCES } from './tables.js';
import { str } from './util.js';
import { getConfigInt } from './config.js';
import { deleteFile } from './files.js';
import { rowToObj, genId, ID_PATTERN, parseJsonList, TRASH_ITEM_RULES, TRASH_LABEL_COLUMN } from './data.js';

// ゴミ箱に入れられるリソース
export const TRASHABLE = ['events', 'members', 'experiments', 'passwords'];
// 管理者トークンが無いと扱えないリソース(一覧にも出さない)
export const TRASH_ADMIN_ONLY = ['passwords'];

// 出欠投票は削除時に一緒に消えるため、ゴミ箱に退避して復元で戻す
const VOTE_OWNER_COLUMN = { events: 'EventID', members: 'MemberID' };
const VOTE_COLUMNS = ['EventID', 'MemberID', 'Status', 'UpdatedAt', 'Note'];

const q = c => '"' + c + '"';

async function expiresAt(env, fromIso) {
  const days = await getConfigInt(env, 'trash_keep_days', 7);
  return new Date(Date.parse(fromIso) + days * 86400000).toISOString();
}

// レコードを削除してゴミ箱へ入れる。入れた ID を返す(対象が無ければ '')。
export async function moveRecordToTrash(env, name, id) {
  const res = getResource(name);
  if (!res || TRASHABLE.indexOf(name) < 0 || typeof id !== 'string' || !ID_PATTERN.test(id)) return '';
  const row = await env.DB.prepare('SELECT ' + res.columns.map(q).join(', ') + ' FROM ' + res.table + ' WHERE ID = ?').bind(id).first();
  if (!row) return '';

  const voteCol = VOTE_OWNER_COLUMN[name];
  let votes = [];
  if (voteCol) {
    const r = await env.DB.prepare('SELECT ' + VOTE_COLUMNS.map(q).join(', ') + ' FROM event_votes WHERE ' + voteCol + ' = ?').bind(id).all();
    votes = r.results || [];
  }

  const now = new Date().toISOString();
  const trashId = genId('tr_');
  const payload = {};
  res.columns.forEach(c => { payload[c] = str(row[c]); });
  const stmts = [
    // 対象がまだ存在するときだけ入れる(同時に別の人が削除していたら二重に入れない)
    env.DB.prepare(
      'INSERT INTO trash (ID, Kind, Resource, RecordID, Field, Label, RecordLabel, Payload, Votes, DeletedAt, ExpiresAt) ' +
      "SELECT ?, 'record', ?, ?, '', ?, '', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM " + res.table + ' WHERE ID = ?)'
    ).bind(trashId, name, id, str(row[TRASH_LABEL_COLUMN[name]]), JSON.stringify(payload), JSON.stringify(votes), now, await expiresAt(env, now), id),
    env.DB.prepare('DELETE FROM ' + res.table + ' WHERE ID = ?').bind(id)
  ];
  if (voteCol) stmts.push(env.DB.prepare('DELETE FROM event_votes WHERE ' + voteCol + ' = ?').bind(id));
  const out = await env.DB.batch(stmts);
  return out[1].meta && out[1].meta.changes > 0 ? trashId : '';
}

// 一覧(新しい順)。Payload は返さない。includeAdminOnly が偽なら、管理者専用リソース(パスワード)は除く。
export async function listTrash(env, includeAdminOnly) {
  const { results } = await env.DB.prepare(
    'SELECT ID, Kind, Resource, RecordID, Field, Label, RecordLabel, DeletedAt, ExpiresAt FROM trash ORDER BY DeletedAt DESC'
  ).all();
  return (results || [])
    .filter(r => includeAdminOnly || TRASH_ADMIN_ONLY.indexOf(r.Resource) < 0)
    .map(r => ({
      id: str(r.ID), kind: str(r.Kind), resource: str(r.Resource), recordId: str(r.RecordID), field: str(r.Field),
      label: str(r.Label), recordLabel: str(r.RecordLabel), deletedAt: str(r.DeletedAt), expiresAt: str(r.ExpiresAt)
    }));
}

async function getTrashRow(env, id) {
  if (typeof id !== 'string' || !id) return null;
  return env.DB.prepare('SELECT * FROM trash WHERE ID = ?').bind(id).first();
}

// 戻す。{ success, item?, resource?, error? } を返す。
//   record: 同じ ID が既にあれば already_exists。出欠投票も戻す。
//   item  : 元のレコードが無ければ parent_missing、1 ファイルの枠が埋まっていれば slot_occupied、
//           すでに戻っていれば何もせず成功。
export async function restoreTrash(env, id) {
  const row = await getTrashRow(env, id);
  if (!row) return { success: false, error: 'not_found' };
  const res = getResource(row.Resource);
  if (!res) return { success: false, error: 'not_found' };
  let payload;
  try { payload = JSON.parse(row.Payload); } catch (_) { return { success: false, error: 'broken_entry' }; }
  const now = new Date().toISOString();

  if (row.Kind === 'record') {
    const exists = await env.DB.prepare('SELECT ID FROM ' + res.table + ' WHERE ID = ?').bind(row.RecordID).first();
    if (exists) return { success: false, error: 'already_exists' };
    if (res.columns.indexOf('UpdatedAt') >= 0) payload.UpdatedAt = now;
    const stmts = [
      env.DB.prepare(
        'INSERT INTO ' + res.table + ' (' + res.columns.map(q).join(', ') + ') VALUES (' + res.columns.map(() => '?').join(', ') + ') ON CONFLICT(ID) DO NOTHING'
      ).bind(...res.columns.map(c => str(payload[c]))),
      // 戻せたとき(直前の INSERT が成功したとき)だけゴミ箱から外す
      env.DB.prepare('DELETE FROM trash WHERE ID = ? AND changes() > 0').bind(row.ID)
    ];
    let votes = [];
    try { votes = JSON.parse(row.Votes || '[]'); } catch (_) { votes = []; }
    votes.forEach(v => {
      stmts.push(env.DB.prepare(
        'INSERT OR IGNORE INTO event_votes (' + VOTE_COLUMNS.map(q).join(', ') + ') VALUES (' + VOTE_COLUMNS.map(() => '?').join(', ') + ')'
      ).bind(...VOTE_COLUMNS.map(c => str(v[c]))));
    });
    const out = await env.DB.batch(stmts);
    if (!(out[0].meta && out[0].meta.changes > 0)) return { success: false, error: 'already_exists' };
    const restored = await env.DB.prepare('SELECT ' + res.columns.map(q).join(', ') + ' FROM ' + res.table + ' WHERE ID = ?').bind(row.RecordID).first();
    return { success: true, resource: row.Resource, item: restored ? rowToObj(res, restored) : null };
  }

  // item
  const rule = (TRASH_ITEM_RULES[row.Resource] || {})[row.Field];
  if (!rule) return { success: false, error: 'broken_entry' };
  const parent = await env.DB.prepare('SELECT ' + [row.Field, 'UpdatedAt'].map(q).join(', ') + ' FROM ' + res.table + ' WHERE ID = ?').bind(row.RecordID).first();
  if (!parent) return { success: false, error: 'parent_missing' };
  const list = parseJsonList(parent[row.Field]);
  const key = rule.key(payload);
  // 同じキーの要素が親にあれば「すでに戻っている」とみなす。ただし見出しで照合する列(Sections, countOnly)は
  // 同じ見出しの別の要素がありうるので、この判定をせず常に戻す(判定すると、ゴミ箱の行だけ消えて中身が失われる)
  if (key && !rule.countOnly && list.some(it => rule.key(it) === key)) {
    await env.DB.prepare('DELETE FROM trash WHERE ID = ?').bind(row.ID).run();   // すでに戻っている
  } else {
    if (rule.single && list.length > 0) return { success: false, error: 'slot_occupied' };
    list.push(payload);
    const out = await env.DB.batch([
      env.DB.prepare('UPDATE ' + res.table + ' SET ' + q(row.Field) + ' = ?, "UpdatedAt" = ? WHERE ID = ? AND "UpdatedAt" = ?')
        .bind(JSON.stringify(list), now, row.RecordID, str(parent.UpdatedAt)),
      env.DB.prepare('DELETE FROM trash WHERE ID = ? AND changes() > 0').bind(row.ID)
    ]);
    if (!(out[0].meta && out[0].meta.changes > 0)) return { success: false, error: 'conflict' };
  }
  const updated = await env.DB.prepare('SELECT ' + res.columns.map(q).join(', ') + ' FROM ' + res.table + ' WHERE ID = ?').bind(row.RecordID).first();
  return { success: true, resource: row.Resource, item: updated ? rowToObj(res, updated) : null };
}

// 行が持つ R2 のファイルキー(driveId)を集める
function driveIdsOf(row) {
  let payload;
  try { payload = JSON.parse(row.Payload); } catch (_) { return []; }
  const rules = TRASH_ITEM_RULES[row.Resource] || {};
  const ids = [];
  if (row.Kind === 'item') {
    if (payload && payload.driveId) ids.push(String(payload.driveId));
    return ids;
  }
  Object.keys(rules).forEach(field => {
    parseJsonList(payload[field]).forEach(it => { if (it && it.driveId) ids.push(String(it.driveId)); });
  });
  return ids;
}

// R2 のファイルが、まだどこかから参照されているか(全リソースの列と、ゴミ箱の他の行)。
// キーは推測されにくいランダムな値なので、文字列に含まれるかで判定する(ガイド本文の画像 URL なども拾える)。
// 完全削除で、他のレコードが使っているファイルを消さないため(イベントを複製して同じファイルを持つ場合や、
// 他人のファイルのキーを書き込んだレコードを作って完全削除する場合。deleteFile は管理者専用だが、完全削除はメンバーもできる)。
async function isFileReferenced(env, key, exceptTrashId) {
  for (const res of Object.values(RESOURCES)) {
    // ?1 で同じ値を全列に使う(列ごとに値を渡すと、列が増えたとき D1 の 1 文あたりの上限 100 個に近づくため)
    const where = res.columns.map(c => 'instr(' + q(c) + ', ?1) > 0').join(' OR ');
    const hit = await env.DB.prepare('SELECT 1 FROM ' + res.table + ' WHERE ' + where + ' LIMIT 1').bind(key).first();
    if (hit) return true;
  }
  return !!(await env.DB.prepare('SELECT 1 FROM trash WHERE ID <> ? AND instr(Payload, ?) > 0 LIMIT 1').bind(exceptTrashId, key).first());
}

async function purgeRow(env, row) {
  for (const key of driveIdsOf(row)) {
    try {
      if (await isFileReferenced(env, key, row.ID)) continue;
      await deleteFile(env, key);
    } catch (e) { console.error('trash purge: file delete failed ' + key + ': ' + e); }
  }
  await env.DB.prepare('DELETE FROM trash WHERE ID = ?').bind(row.ID).run();
}

// 完全に削除する(ファイル実体も消える)。
export async function purgeTrash(env, id) {
  const row = await getTrashRow(env, id);
  if (!row) return false;
  await purgeRow(env, row);
  return true;
}

// 期限切れを完全に削除する(定期実行。ゴミ箱の一覧を開いたときにも念のため行う)
export async function purgeExpiredTrash(env, limit = 100) {
  const { results } = await env.DB.prepare('SELECT * FROM trash WHERE ExpiresAt <> \'\' AND ExpiresAt <= ? ORDER BY ExpiresAt LIMIT ?')
    .bind(new Date().toISOString(), limit).all();
  for (const row of (results || [])) await purgeRow(env, row);
  return (results || []).length;
}

export { getTrashRow };
