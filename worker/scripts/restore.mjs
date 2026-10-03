// バックアップからの復元: R2 の backups/YYYY-MM-DD.json(毎日の自動バックアップ)を D1 に書き戻す。
//
// 使い方:
//   1. Cloudflare ダッシュボード → R2 → scicomi-portal-files → backups/ から、戻したい日の JSON をダウンロード
//   2. node scripts/restore.mjs <backup.json> --remote            内容を表示するだけ(予行)
//      node scripts/restore.mjs <backup.json> --remote --yes      実際に復元する(現在のデータは消える)
//   --local を付けるとローカル DB に対して行う(保存先は既定で .wrangler/state。--persist-to=<フォルダ> で変えられる)
//
// D1 は 1 文の長さに上限(約 100KB)がある。値が長い行(ガイド本文・ゴミ箱の中身など)は、長い値を空で INSERT してから
// UPDATE で少しずつ継ぎ足す(1 文が上限を超えて、復元全体が失敗しないように)。
//
// 復元されるもの: tables.js の全リソース(events / members / experiments / passwords / guides) と event_votes / config / audit_log / gemini_usage / trash
// 復元されないもの: パスワードのハッシュ・API キー(バックアップに含めない)。復元後に設定画面から入れ直す。
//                    R2 のファイル本体(バックアップの対象外。R2 側に残っていればそのまま使える)。
// 復元後、そのロールのログインは変わらない(パスワードのハッシュは D1 に残るため)。

import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCES } from '../src/tables.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
const yes = args.includes('--yes');
const persistArg = args.find(a => a.startsWith('--persist-to='));
const persistTo = persistArg ? persistArg.slice('--persist-to='.length) : '.wrangler/state';
if (!file || !target || (persistArg && (target !== '--local' || !persistTo))) {
  console.error('使い方: node scripts/restore.mjs <backup.json> <--local|--remote> [--persist-to=<フォルダ>(--local のみ)] [--yes]');
  process.exit(1);
}

const backup = JSON.parse(readFileSync(file, 'utf8'));
if (!backup.tables) { console.error('バックアップ形式ではありません(tables がありません)。'); process.exit(1); }

const q = v => v === null || v === undefined ? "''" : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";

// テーブルごとの列(バックアップの行のキーをそのまま使う。ただし定義済みの列だけ)
const columnsOf = {
  ...Object.fromEntries(Object.keys(RESOURCES).map(n => [n, RESOURCES[n].columns])),
  event_votes: ['EventID', 'MemberID', 'Status', 'UpdatedAt', 'Note'],
  config: ['Key', 'Value'],
  audit_log: ['Timestamp', 'Action', 'Detail', 'TokenHash', 'Role'],
  gemini_usage: ['Date', 'Count'],
  trash: ['ID', 'Kind', 'Resource', 'RecordID', 'Field', 'Label', 'RecordLabel', 'Payload', 'Votes', 'DeletedAt', 'ExpiresAt']
};

// 長い値を継ぎ足すときに行を特定する列(audit_log は特定できる列が無いが、詳細は短いので分割は要らない)
const keyOf = { event_votes: ['EventID', 'MemberID'], config: ['Key'], gemini_usage: ['Date'] };
const keyColumns = table => keyOf[table] || (columnsOf[table].indexOf('ID') >= 0 ? ['ID'] : null);

// 1 文の長さの上限(D1 は約 100KB)に余裕を持たせた値。継ぎ足す 1 回分は、これより小さくする
const MAX_STATEMENT_BYTES = 90000;
const CHUNK_BYTES = 80000;
const bytes = s => Buffer.byteLength(s, 'utf8');

// 文字列を、SQL の文字列リテラルにしたときに maxBytes を超えない長さに分ける(文字の途中では切らない)
function splitLiteral(text, maxBytes) {
  const parts = [];
  let cur = '', size = 2;   // 前後の '
  for (const ch of String(text)) {
    const n = ch === "'" ? 2 : bytes(ch);
    if (size + n > maxBytes && cur) { parts.push(cur); cur = ''; size = 2; }
    cur += ch; size += n;
  }
  if (cur) parts.push(cur);
  return parts;
}

// 1 行を、上限を超えない 1 つ以上の文にする
function rowStatements(table, cols, r) {
  const colList = cols.map(c => '"' + c + '"').join(', ');
  const insert = vals => `INSERT INTO ${table} (${colList}) VALUES (${vals.join(', ')});`;
  const whole = insert(cols.map(c => q(r[c])));
  if (bytes(whole) <= MAX_STATEMENT_BYTES) return [whole];
  // 長い値は空で入れて、あとから UPDATE で継ぎ足す
  const keys = keyColumns(table);
  if (!keys) throw new Error(`${table} の行が長すぎて分割できません(行を特定する列がありません)`);
  // 長い値から順に後回しにして、INSERT が上限に収まるまで減らす(1 つずつは短くても、合計で超える行がある)
  const longCols = [];
  const firstInsert = () => insert(cols.map(c => longCols.indexOf(c) >= 0 ? "''" : q(r[c])));
  const bySize = cols.filter(c => keys.indexOf(c) < 0 && typeof r[c] === 'string').sort((a, b) => bytes(r[b]) - bytes(r[a]));
  for (const c of bySize) {
    if (bytes(firstInsert()) <= MAX_STATEMENT_BYTES) break;
    longCols.push(c);
  }
  const out = [firstInsert()];
  if (bytes(out[0]) > MAX_STATEMENT_BYTES) throw new Error(`${table} の行が長すぎて分割できません`);
  const where = keys.map(k => '"' + k + '" = ' + q(r[k])).join(' AND ');
  for (const c of longCols) {
    for (const part of splitLiteral(r[c], CHUNK_BYTES)) out.push(`UPDATE ${table} SET "${c}" = "${c}" || ${q(part)} WHERE ${where};`);
  }
  return out;
}

const sql = [];
console.log(`バックアップ作成: ${backup.createdAt}`);
for (const [table, cols] of Object.entries(columnsOf)) {
  const rows = backup.tables[table];
  if (!Array.isArray(rows)) { console.log(`  ${table}: バックアップに無いためスキップ`); continue; }
  console.log(`  ${table}: ${rows.length} 件`);
  sql.push(`DELETE FROM ${table};`);
  let split = 0;
  for (const r of rows) {
    const stmts = rowStatements(table, cols, r);
    if (stmts.length > 1) split++;
    sql.push(...stmts);
  }
  if (split) console.log(`    (うち ${split} 件は値が長いため、分けて書き込みます)`);
}

// 復元は現在のデータを消して置き換えるため、予行・本実行のどちらでも、先に現状を退避したかを確認させる
const backupHint = target === '--remote'
  ? '  npx wrangler d1 export scicomi-portal --remote --output=../backup-YYYYMMDD.sql'
  : `  (ローカルなら ${persistTo} をフォルダごとコピー)`;
console.log('\n★ 復元前に、現在のデータのバックアップを取りましたか? 復元すると上のテーブルは今の内容が消えます。');
console.log('  まだなら先に次を実行してください(出力は個人情報を含むので Git に入れない):');
console.log(backupHint);

if (!yes) {
  console.log('\n予行のため、変更していません。バックアップを取った後、現在のデータを上の内容で置き換えるには --yes を付けて再実行してください。');
  process.exit(0);
}

const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const dir = mkdtempSync(join(tmpdir(), 'restore-'));
const sqlFile = join(dir, 'restore.sql');
writeFileSync(sqlFile, sql.join('\n') + '\n');
try {
  const a = [wrangler, 'd1', 'execute', 'scicomi-portal', target, '--file', sqlFile];
  if (target === '--local') a.push('--persist-to', persistTo);
  execFileSync(process.execPath, a, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('\n復元しました。パスワードのハッシュ・API キーは変更していません(必要なら設定画面から入れ直してください)。');
