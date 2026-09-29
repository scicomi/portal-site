// 差分マージ: GAS のエクスポート JSON のうち、D1 に無い(または D1 より新しい)ものだけを D1 に足す。
//
// 切り替え後に D1 へ書き込みが始まっていて、--replace(丸ごと上書き)ができないときに使う。何も削除しない。
//
// 使い方:
//   node scripts/merge.mjs <export.json> --remote                 予行(変更せず、内容だけ表示)
//   node scripts/merge.mjs <export.json> --remote --apply         実際に反映する
//   --since <ISO 時刻>   前回取り込んだエクスポートの時刻(必須。例: --since 2026-09-29T07:34:06.666Z)
//
// 判定ルール:
//   ・エクスポートにあって D1 に無い行: CreatedAt(投票は updatedAt)が --since 以降なら「その後に GAS で作られた行」として追加。
//     それより前なら「取り込み後に D1 側で削除された行」とみなして追加しない(一覧に表示する)。
//   ・両方にある行: エクスポートの UpdatedAt が D1 より新しければ、エクスポートの内容で更新する。
//   ・D1 にだけある行(新サーバーで作られた行)は、そのまま残す。
//   ・設定(config)は対象外。差異があれば表示だけする。

import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCES } from '../src/tables.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sinceIdx = args.indexOf('--since');
const sinceArg = sinceIdx >= 0 ? (args[sinceIdx + 1] || '') : '';
const file = args.find((a, i) => !a.startsWith('--') && !(sinceIdx >= 0 && i === sinceIdx + 1));
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
const apply = args.includes('--apply');
const since = Date.parse(sinceArg);
if (!file || !target || !sinceArg || isNaN(since)) {
  console.error('使い方: node scripts/merge.mjs <export.json> <--local|--remote> --since <ISO時刻> [--apply]');
  console.error('  --since は必須(前回取り込んだエクスポートの時刻。取り違えると削除済みの行を復活させるため既定値は持たない)');
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, 'utf8'));
const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function d1(extra) {
  const a = [wrangler, 'd1', 'execute', 'scicomi-portal', target, ...extra];
  if (target === '--local') a.push('--persist-to', '.wrangler/state');
  return execFileSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
}
function query(sql) {
  const out = d1(['--json', '--command', sql]);
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const q = v => "'" + String(v).replace(/'/g, "''") + "'";
const cell = v => {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v) && v.length === 0) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const ts = s => { const t = Date.parse(s); return isNaN(t) ? null : t; };
// a が b より新しいか。a が空(更新日時なし)なら、比べようがないので「新しくない」とする。
const newer = (a, b) => {
  if (a === undefined || a === null || a === '') return false;
  if (b === undefined || b === null || b === '') return true;
  const x = ts(a), y = ts(b);
  return (x !== null && y !== null) ? x > y : String(a) > String(b);
};

const plan = { insert: [], update: [], skippedDeleted: [], sql: [] };
const label = (name, row) => `${name}: ${row.Title || row.Name || row.SiteName || row.ID || (row.eventId + '/' + row.memberId)}`;

for (const name of ['events', 'members', 'experiments', 'passwords']) {
  const res = RESOURCES[name];
  const db = new Map(query(`SELECT * FROM ${name}`).map(r => [r.ID, r]));
  for (const it of data[name] || []) {
    const cur = db.get(it.ID);
    const cols = res.columns.map(c => '"' + c + '"').join(', ');
    const vals = res.columns.map(c => q(cell(it[c])));
    if (!cur) {
      const created = ts(it.CreatedAt);
      if (created !== null && created >= since) {
        plan.insert.push(label(name, it));
        plan.sql.push(`INSERT INTO ${name} (${cols}) VALUES (${vals.join(', ')});`);
      } else {
        plan.skippedDeleted.push(label(name, it) + `(作成: ${it.CreatedAt || '不明'})`);
      }
    } else if (newer(it.UpdatedAt, cur.UpdatedAt)) {
      plan.update.push(label(name, it) + `(GAS ${it.UpdatedAt} > D1 ${cur.UpdatedAt})`);
      const sets = res.columns.filter(c => c !== 'ID').map(c => `"${c}" = ${q(cell(it[c]))}`).join(', ');
      plan.sql.push(`UPDATE ${name} SET ${sets} WHERE ID = ${q(it.ID)};`);
    }
  }
}

{
  const db = new Map(query('SELECT * FROM event_votes').map(r => [r.EventID + '\u0000' + r.MemberID, r]));
  for (const v of data.votes || []) {
    const cur = db.get(v.eventId + '\u0000' + v.memberId);
    const row = { eventId: v.eventId, memberId: v.memberId };
    if (!cur) {
      const t = ts(v.updatedAt);
      if (t !== null && t >= since) {
        plan.insert.push(label('votes', row));
        plan.sql.push(`INSERT INTO event_votes (EventID, MemberID, Status, UpdatedAt, Note) VALUES (${q(v.eventId)}, ${q(v.memberId)}, ${q(v.status)}, ${q(v.updatedAt || '')}, ${q(v.note || '')});`);
      } else {
        plan.skippedDeleted.push(label('votes', row));
      }
    } else if (newer(v.updatedAt, cur.UpdatedAt)) {
      plan.update.push(label('votes', row) + ` → ${v.status}(GAS ${v.updatedAt} > D1 ${cur.UpdatedAt})`);
      plan.sql.push(`UPDATE event_votes SET Status = ${q(v.status)}, UpdatedAt = ${q(v.updatedAt || '')}, Note = ${q(v.note || '')} WHERE EventID = ${q(v.eventId)} AND MemberID = ${q(v.memberId)};`);
    }
  }
}

const show = (title, list) => {
  console.log(`\n${title}: ${list.length} 件`);
  list.slice(0, 40).forEach(l => console.log('  ・' + l));
  if (list.length > 40) console.log(`  …ほか ${list.length - 40} 件`);
};
console.log(`基準時刻(--since): ${sinceArg}`);
show('追加する行(その後に GAS で作られたもの)', plan.insert);
show('更新する行(GAS 側の方が新しいもの)', plan.update);
show('追加しない行(取り込み後に D1 側で削除されたとみなしたもの)', plan.skippedDeleted);

if (!plan.sql.length) { console.log('\n反映する変更はありません。'); process.exit(0); }
if (!apply) { console.log('\n予行のため、変更していません。反映するには --apply を付けて再実行してください。'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'merge-'));
const sqlFile = join(dir, 'merge.sql');
writeFileSync(sqlFile, plan.sql.join('\n') + '\n');
try { d1(['--file', sqlFile]); } finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`\n反映しました(追加 ${plan.insert.length} 件、更新 ${plan.update.length} 件)。`);
