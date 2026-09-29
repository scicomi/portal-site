// 移行データの突き合わせ: GAS のエクスポート JSON と、Worker の API が返す内容を全件比較する。
//
// 使い方:
//   node scripts/verify.mjs <export.json> <API の URL>
//   例) node scripts/verify.mjs scicomi_export.json https://scicomi-portal.scicomi.workers.dev
//
// ログインが必要なため、一般パスワードと幹部パスワードを聞かれる(入力は伏せ字)。
// 幹部パスワードを空のまま Enter すると、passwords(パスワード一覧)の比較は省略する。
// 自動テスト用に環境変数 VERIFY_MEMBER_PW / VERIFY_ADMIN_PW でも渡せる。

import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { RESOURCES } from '../src/tables.js';

const [file, base] = process.argv.slice(2);
if (!file || !base) { console.error('使い方: node scripts/verify.mjs <export.json> <API の URL>'); process.exit(1); }

function promptHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); else process.stdout.write('*'); };
    rl.question(question, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function post(payload) {
  const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
  return res.json();
}

const memberPw = process.env.VERIFY_MEMBER_PW ?? await promptHidden('一般パスワード: ');
const adminPw = process.env.VERIFY_ADMIN_PW ?? await promptHidden('幹部パスワード(パスワード一覧も比較する場合。不要なら空 Enter): ');

const exp = JSON.parse(readFileSync(file, 'utf8'));
let token = '', adminToken = '';
if (adminPw) {
  const a = await post({ action: 'login', password: adminPw });
  if (!a.success) { console.error('幹部パスワードでログインできません。'); process.exit(1); }
  token = a.token; adminToken = a.adminToken;
} else {
  const m = await post({ action: 'login', password: memberPw });
  if (!m.success) { console.error('一般パスワードでログインできません。'); process.exit(1); }
  token = m.token;
}

// API の値を D1 保存時と同じ規則に揃える(空配列 = 空セル)
const norm = v => (Array.isArray(v) && v.length === 0) ? '' : (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
const rowKey = (res, row) => res.columns.map(c => norm(row[c])).join('\u0001');

let ok = true;
const report = (label, exp, got, diffs) => {
  const good = exp === got && diffs.length === 0;
  if (!good) ok = false;
  console.log(`${good ? 'OK ' : 'NG '} ${label}: 期待 ${exp} 件 / 実際 ${got} 件` + (diffs.length ? `(差異 ${diffs.length} 件)` : ''));
  diffs.slice(0, 5).forEach(d => console.log('     ' + d));
};

const all = await post({ action: 'listAll', token });
if (!all.success) { console.error('listAll に失敗: ' + all.error); process.exit(1); }

const targets = [['events', all.events], ['members', all.members], ['experiments', all.experiments]];
if (adminPw) {
  const pw = await post({ action: 'list', resource: 'passwords', token, adminToken });
  targets.push(['passwords', pw.items || []]);
}

for (const [name, got] of targets) {
  const res = RESOURCES[name];
  const want = exp[name] || [];
  const byId = new Map(got.map(r => [r.ID, r]));
  const diffs = [];
  for (const w of want) {
    const g = byId.get(w.ID);
    if (!g) { diffs.push(`${w.ID}: D1 に存在しません`); continue; }
    for (const c of res.columns) {
      if (norm(w[c]) !== norm(g[c])) diffs.push(`${w.ID}.${c}: 「${norm(w[c]).slice(0, 40)}」→「${norm(g[c]).slice(0, 40)}」`);
    }
  }
  report(name, want.length, got.length, diffs);
}

{
  const key = v => v.eventId + '\u0000' + v.memberId;
  const got = new Map(all.votes.map(v => [key(v), v]));
  const want = new Map((exp.votes || []).map(v => [key(v), v]));
  const diffs = [];
  for (const [k, w] of want) {
    const g = got.get(k);
    if (!g) { diffs.push(`${w.eventId}/${w.memberId}: 存在しません`); continue; }
    for (const f of ['status', 'updatedAt', 'note']) if (String(w[f] ?? '') !== String(g[f] ?? '')) diffs.push(`${w.eventId}/${w.memberId}.${f}`);
  }
  report('votes', want.size, got.size, diffs);
}

if (adminToken) {
  const cfg = (await post({ action: 'adminGetConfig', token, adminToken })).config || {};
  const diffs = [];
  for (const [k, v] of Object.entries(exp.config || {})) {
    if (k in cfg && String(cfg[k]) !== String(v)) diffs.push(`config.${k}: 「${String(v).slice(0, 40)}」→「${String(cfg[k]).slice(0, 40)}」`);
  }
  report('config', Object.keys(exp.config || {}).length, Object.keys(exp.config || {}).length, diffs);
}

console.log(ok ? '\n突き合わせ: すべて一致しました。' : '\n突き合わせ: 差異があります。上の NG を確認してください。');
process.exit(ok ? 0 : 1);
