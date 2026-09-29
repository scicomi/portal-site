// バックアップからの復元: R2 の backups/YYYY-MM-DD.json(毎日の自動バックアップ)を D1 に書き戻す。
//
// 使い方:
//   1. Cloudflare ダッシュボード → R2 → scicomi-portal-files → backups/ から、戻したい日の JSON をダウンロード
//   2. node scripts/restore.mjs <backup.json> --remote            内容を表示するだけ(予行)
//      node scripts/restore.mjs <backup.json> --remote --yes      実際に復元する(現在のデータは消える)
//   --local を付けるとローカル DB に対して行う
//
// 復元されるもの: events / members / experiments / passwords / event_votes / config / audit_log / gemini_usage
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
if (!file || !target) {
  console.error('使い方: node scripts/restore.mjs <backup.json> <--local|--remote> [--yes]');
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
  gemini_usage: ['Date', 'Count']
};

const sql = [];
console.log(`バックアップ作成: ${backup.createdAt}`);
for (const [table, cols] of Object.entries(columnsOf)) {
  const rows = backup.tables[table];
  if (!Array.isArray(rows)) { console.log(`  ${table}: バックアップに無いためスキップ`); continue; }
  console.log(`  ${table}: ${rows.length} 件`);
  sql.push(`DELETE FROM ${table};`);
  for (const r of rows) {
    sql.push(`INSERT INTO ${table} (${cols.map(c => '"' + c + '"').join(', ')}) VALUES (${cols.map(c => q(r[c])).join(', ')});`);
  }
}

if (!yes) {
  console.log('\n予行のため、変更していません。現在のデータを上の内容で置き換えるには --yes を付けて再実行してください。');
  process.exit(0);
}

const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const dir = mkdtempSync(join(tmpdir(), 'restore-'));
const sqlFile = join(dir, 'restore.sql');
writeFileSync(sqlFile, sql.join('\n') + '\n');
try {
  const a = [wrangler, 'd1', 'execute', 'scicomi-portal', target, '--file', sqlFile];
  if (target === '--local') a.push('--persist-to', '.wrangler/state');
  execFileSync(process.execPath, a, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('\n復元しました。パスワードのハッシュ・API キーは変更していません(必要なら設定画面から入れ直してください)。');
