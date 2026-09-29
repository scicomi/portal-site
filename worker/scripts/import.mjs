// 移行データの取り込み: GAS の exportAllForMigration が書き出した JSON を D1 に投入する。
//
// 使い方:
//   node scripts/import.mjs <export.json> --local              ローカル DB に取り込む
//   node scripts/import.mjs <export.json> --remote             本番 DB に取り込む
//   オプション: --dry-run(SQL を作るだけで実行しない)、--replace(取り込み先の既存データを消してから取り込む)
//
// 取り込み先のテーブルにデータがある場合は、--replace が無い限り中止する(二重取り込みの防止)。
// 取り込み後、テーブルごとの件数を照合して結果を表示する。内容まで突き合わせるには verify.mjs を使う。

import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCES } from '../src/tables.js';
import { DEFAULT_CONFIG, isSecretKey } from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
const dryRun = args.includes('--dry-run');
const replace = args.includes('--replace');
if (!file || !target) {
  console.error('使い方: node scripts/import.mjs <export.json> <--local|--remote> [--dry-run] [--replace]');
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, 'utf8'));

const q = v => "'" + String(v).replace(/'/g, "''") + "'";

// API の値 → D1 に保存する文字列(src/data.js の cellValue と同じ規則)。
// 空の配列は '' にして、元のシートの「空セル」と同じ状態にする。
function cell(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v) && v.length === 0) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const tables = [];   // { name, rows(件数), sql: [...] }

for (const name of ['events', 'members', 'experiments', 'passwords']) {
  const res = RESOURCES[name];
  const items = data[name] || [];
  const seen = new Set();
  const sql = [];
  for (const it of items) {
    if (!it.ID) throw new Error(name + ': ID の無い行があります');
    if (seen.has(it.ID)) throw new Error(name + ': ID が重複しています: ' + it.ID);
    seen.add(it.ID);
    const unknown = Object.keys(it).filter(k => !res.columns.includes(k));
    if (unknown.length) console.warn(`警告: ${name} に定義されていない列があります(無視します): ${unknown.join(', ')}`);
    sql.push(`INSERT INTO ${name} (${res.columns.map(c => '"' + c + '"').join(', ')}) VALUES (${res.columns.map(c => q(cell(it[c]))).join(', ')});`);
  }
  tables.push({ name, rows: items.length, sql });
}

{
  const votes = data.votes || [];
  const seen = new Set();
  const sql = [];
  for (const v of votes) {
    const k = v.eventId + '\u0000' + v.memberId;
    if (seen.has(k)) { console.warn(`警告: 投票が重複しています(後の行を採用): ${v.eventId} / ${v.memberId}`); }
    seen.add(k);
    sql.push(`INSERT OR REPLACE INTO event_votes (EventID, MemberID, Status, UpdatedAt, Note) VALUES (${q(v.eventId)}, ${q(v.memberId)}, ${q(v.status)}, ${q(v.updatedAt || '')}, ${q(v.note || '')});`);
  }
  tables.push({ name: 'event_votes', rows: seen.size, sql });
}

{
  const sql = [];
  let n = 0;
  for (const [k, v] of Object.entries(data.config || {})) {
    if (!(k in DEFAULT_CONFIG) || isSecretKey(k)) continue;   // 廃止した設定・機密設定は取り込まない
    sql.push(`INSERT OR REPLACE INTO config (Key, Value) VALUES (${q(k)}, ${q(v)});`);
    n++;
  }
  tables.push({ name: 'config', rows: n, sql });
}

const all = [];
if (replace) tables.forEach(t => all.push(`DELETE FROM ${t.name};`));
tables.forEach(t => all.push(...t.sql));

console.log('取り込み予定: ' + tables.map(t => `${t.name}=${t.rows}`).join(' '));
if (dryRun) { console.log('--dry-run のため実行しません。'); process.exit(0); }

const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
function d1(extra) {
  const a = [wrangler, 'd1', 'execute', 'scicomi-portal', target, ...extra];
  if (target === '--local') a.push('--persist-to', '.wrangler/state');
  return execFileSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}
function counts() {
  // D1 は UNION ALL の項数に上限があるため、1 行のスカラーサブクエリで件数を取る
  const sel = 'SELECT ' + tables.map(t => `(SELECT COUNT(*) FROM ${t.name}) AS ${t.name}`).join(', ');
  const out = d1(['--json', '--command', sel]);
  return JSON.parse(out.slice(out.indexOf('[')))[0].results[0];
}

if (!replace) {
  const before = counts();
  const nonEmpty = Object.entries(before).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`);
  if (nonEmpty.length) {
    console.error('取り込み先にすでにデータがあります: ' + nonEmpty.join(' ') + '\n二重取り込みを防ぐため中止しました。上書きするなら --replace を付けてください。');
    process.exit(1);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'import-'));
const sqlFile = join(dir, 'import.sql');
writeFileSync(sqlFile, all.join('\n') + '\n');
try {
  d1(['--file', sqlFile]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const after = counts();
let ok = true;
for (const t of tables) {
  const good = after[t.name] === t.rows;
  if (!good) ok = false;
  console.log(`${good ? 'OK ' : 'NG '} ${t.name}: 期待 ${t.rows} 件 / 実際 ${after[t.name]} 件`);
}
console.log(ok ? '件数の照合: すべて一致しました。' : '件数が一致しません。内容を確認してください。');
process.exit(ok ? 0 : 1);
