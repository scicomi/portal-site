// パスワード設定スクリプト(共有パスワードのハッシュを D1 に保存する)
//
// 使い方:
//   node scripts/set-password.mjs member --remote     一般(メンバー)パスワードを設定
//   node scripts/set-password.mjs admin  --remote     幹部(管理者)パスワードを設定
//   --local を付けるとローカル開発用の DB に設定する
//
// パスワードは画面に表示されず、チャットやログにも出ない(入力は伏せ字)。
// 設定すると、そのロールの既存トークンはすべて失効する(全員が再ログインになる)。
// 一般と幹部は別の値にすること(同じだとログインした全員が管理者になる。同じ値は拒否する)。
//
// ハッシュ形式: pbkdf2$反復回数$ソルト(hex)$ハッシュ(hex) — src/auth.js の verifyPassword と同一。

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = 100000;
const MIN_LENGTH = 10;   // worker/src/config.js の PASSWORD_MIN_LENGTH と一致させる

const [role, target] = process.argv.slice(2);
if (!['member', 'admin'].includes(role) || !['--local', '--remote'].includes(target)) {
  console.error('使い方: node scripts/set-password.mjs <member|admin> <--local|--remote>');
  process.exit(1);
}
const key = role === 'member' ? 'password' : 'admin_password';

function promptHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); else process.stdout.write('*'); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

let password = process.env.NEW_PASSWORD;   // 自動テスト用。通常は対話入力
if (password === undefined) {
  password = await promptHidden(`${role === 'member' ? '一般' : '幹部'}パスワードを入力: `);
  const again = await promptHidden('もう一度入力: ');
  if (again !== password) { console.error('一致しません。中止しました。'); process.exit(1); }
}
password = password.trim();
if (password.length < MIN_LENGTH) { console.error(`パスワードは${MIN_LENGTH}文字以上にしてください。`); process.exit(1); }

function wranglerArgs(extra) {
  const args = [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'd1', 'execute', 'scicomi-portal', target, ...extra];
  if (target === '--local') args.push('--persist-to', '.wrangler/state');
  return args;
}

// 一般と幹部が同じ値だと、login は幹部の判定を先に行うので、ログインした全員が管理者になる。
// 設定画面(src/config.js の adminSetConfig)と同じく拒否する。反対側のハッシュは照合にだけ使い、表示しない
function sameAsOtherRole(pw) {
  const otherKey = role === 'member' ? 'admin_password' : 'password';
  let out;
  try {
    out = execFileSync(process.execPath, wranglerArgs(['--json', '--command', `SELECT Value FROM secrets WHERE Key = 'pwhash_${otherKey}'`]),
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return null;   // 確認できない
  }
  let rows;
  try { rows = JSON.parse(out.slice(out.indexOf('['))); } catch (_) { return null; }
  const value = rows && rows[0] && rows[0].results && rows[0].results[0] && rows[0].results[0].Value;
  if (!value) return false;   // 反対側が未設定
  const p = String(value).split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return null;
  return pbkdf2Sync(pw, Buffer.from(p[2], 'hex'), parseInt(p[1], 10), 32, 'sha256').toString('hex') === p[3];
}
const same = sameAsOtherRole(password);
if (same === null) { console.error('もう一方のパスワードと同じでないかを確認できなかったため、中止しました(wrangler login の状態などを確認してください)。'); process.exit(1); }
if (same) { console.error('一般パスワードと幹部パスワードは別の値にしてください。中止しました。'); process.exit(1); }

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('hex');
const stored = `pbkdf2$${ITERATIONS}$${salt.toString('hex')}$${hash}`;

const sql = `
INSERT INTO secrets (Key, Value) VALUES ('pwhash_${key}', '${stored}')
  ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value;
INSERT INTO secrets (Key, Value) VALUES ('token_epoch_${role}', '2')
  ON CONFLICT(Key) DO UPDATE SET Value = CAST(Value AS INTEGER) + 1;
`;

const dir = mkdtempSync(join(tmpdir(), 'setpw-'));
const file = join(dir, 'set.sql');
writeFileSync(file, sql);
try {
  execFileSync(process.execPath, wranglerArgs(['--file', file]), { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`${role === 'member' ? '一般' : '幹部'}パスワードを設定しました(${target === '--local' ? 'ローカル' : '本番'})。既存のログインは失効しました。`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
