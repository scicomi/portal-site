// プッシュ通知(Web Push)の鍵(VAPID)を作るスクリプト
//
// 使い方:
//   node scripts/gen-vapid.mjs --remote   本番: 秘密鍵を Secret(VAPID_PRIVATE_KEY)に直接登録し、公開鍵だけを表示する
//   node scripts/gen-vapid.mjs --local    ローカル: .dev.vars に VAPID_PUBLIC_KEY と VAPID_PRIVATE_KEY を書く(本番とは別の鍵)
//
// 秘密鍵は画面・チャット・ログに出さない。--remote は wrangler login 済みの PC で、人が実行する。
// 表示された公開鍵を wrangler.toml の VAPID_PUBLIC_KEY に書いて、npm run deploy する(公開鍵は秘密ではない)。
// 鍵を作り直すと、全端末の登録が無効になる(端末が次に画面を開いたとき、自動で登録し直す)。

import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!['--local', '--remote'].includes(target)) {
  console.error('使い方: node scripts/gen-vapid.mjs <--local|--remote>');
  process.exit(1);
}

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64u(await webcrypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = (await webcrypto.subtle.exportKey('jwk', pair.privateKey)).d;

if (target === '--local') {
  // 既存の VAPID_* の行だけを置き換える(ほかの行には触れない。中身は表示しない)
  const file = join(ROOT, '.dev.vars');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l && !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(l)) : [];
  lines.push('VAPID_PUBLIC_KEY=' + publicKey, 'VAPID_PRIVATE_KEY=' + privateKey);
  writeFileSync(file, lines.join('\n') + '\n');
  console.log('ローカル用の鍵を .dev.vars に書きました。npm run dev を起動し直してください。');
} else {
  // 秘密鍵は標準入力で wrangler に渡す(コマンドの引数や画面に出さない)
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'secret', 'put', 'VAPID_PRIVATE_KEY'],
    { cwd: ROOT, input: privateKey, stdio: ['pipe', 'inherit', 'inherit'] });
  console.log('\n秘密鍵を本番の Secret(VAPID_PRIVATE_KEY)に登録しました。');
  console.log('次の公開鍵を wrangler.toml の VAPID_PUBLIC_KEY に書いて、npm run deploy してください(公開鍵は秘密ではありません):\n');
  console.log(publicKey);
}
