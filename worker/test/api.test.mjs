// 結合テスト: ローカルで起動した Worker(`npm run dev`)に対して、api.js が使う API の契約を検証する。
//
// 事前準備(ローカル DB にテスト用の値を入れる。本番には影響しない):
//   npm run db:migrate:local
//   NEW_PASSWORD=test-member-pw node scripts/set-password.mjs member --local
//   NEW_PASSWORD=test-admin-pw  node scripts/set-password.mjs admin  --local
//   npm run dev        (別ターミナル)
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
const MEMBER_PW = process.env.TEST_MEMBER_PW || 'test-member-pw';
const ADMIN_PW = process.env.TEST_ADMIN_PW || 'test-admin-pw';

async function post(payload) {
  const res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
  return res.json();
}

let member = '', admin = '', adminMember = '';
const evId = 'ev_test_' + Date.now();

test('version は認証なしで取得できる', async () => {
  const r = await post({ action: 'version' });
  assert.equal(r.success, true);
  assert.ok(r.version);
});

test('CORS: 許可オリジンのプリフライトに応答し、未許可オリジンには許可ヘッダーを返さない', async () => {
  let res = await fetch(BASE, { method: 'OPTIONS', headers: { Origin: 'https://scicomi.github.io', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://scicomi.github.io');
  res = await fetch(BASE, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('GET の API は 405(トークンを URL に載せる形式は受け付けない)。不正な % のファイル URL は 400', async () => {
  let res = await fetch(BASE + '/?action=version');
  assert.equal(res.status, 405);
  res = await fetch(BASE + '/?action=listAll&token=x.y');
  assert.equal(res.status, 405);
  // POST でも URL クエリの action / token は読まない
  const r = await fetch(BASE + '/?action=version', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }).then(x => x.json());
  assert.equal(r.error, 'unauthorized');
  assert.equal((await fetch(BASE + '/files/%E0%A4%A')).status, 400);
});

test('未ログインは unauthorized', async () => {
  assert.equal((await post({ action: 'listAll' })).error, 'unauthorized');
  assert.equal((await post({ action: 'list', resource: 'events', token: 'x.y' })).error, 'unauthorized');
});

test('login: 誤パスワードは success:false(error なし)', async () => {
  const r = await post({ action: 'login', password: 'wrong-password' });
  assert.equal(r.success, false);
  assert.equal(r.error, undefined);
});

test('login: 一般パスワードでメンバー、幹部パスワードで管理者トークンも発行', async () => {
  const m = await post({ action: 'login', password: MEMBER_PW });
  assert.equal(m.success, true);
  assert.equal(m.role, 'member');
  assert.equal(m.adminToken, undefined);
  member = m.token;
  const a = await post({ action: 'login', password: ADMIN_PW });
  assert.equal(a.success, true);
  assert.equal(a.role, 'admin');
  assert.ok(a.adminToken);
  adminMember = a.token; admin = a.adminToken;
});

test('メンバートークンでは管理者操作(削除・管理者設定・パスワード一覧)ができない', async () => {
  assert.equal((await post({ action: 'delete', resource: 'events', id: 'x', token: member, adminToken: member })).error, 'admin_required');
  assert.equal((await post({ action: 'adminGetConfig', token: member, adminToken: member })).error, 'admin_required');
  assert.equal((await post({ action: 'list', resource: 'passwords', token: member })).error, 'admin_required');
});

test('save(新規): イベントを保存し、一覧・listAll に反映される', async () => {
  const item = { ID: evId, Title: 'テストイベント', Date: '2026-10-01', Category: 'normal', PartsList: [{ name: '実験', presenters: ['A'] }], Files: [] };
  const r = await post({ action: 'save', resource: 'events', token: member, item });
  assert.equal(r.success, true);
  assert.equal(r.item.ID, evId);
  assert.ok(r.item.CreatedAt);
  assert.ok(r.item.UpdatedAt);
  assert.deepEqual(r.item.PartsList, [{ name: '実験', presenters: ['A'] }]);

  const list = await post({ action: 'list', resource: 'events', token: member });
  const got = list.items.find(e => e.ID === evId);
  assert.equal(got.Title, 'テストイベント');
  assert.deepEqual(got.PartsList, [{ name: '実験', presenters: ['A'] }]);
  assert.deepEqual(got.Files, []);          // 空の JSON 列は [] で返る
  assert.equal(got.Location, '');           // 未指定の列は空文字

  const all = await post({ action: 'listAll', token: member });
  assert.ok(all.events.find(e => e.ID === evId));
  assert.ok(Array.isArray(all.members) && Array.isArray(all.experiments) && Array.isArray(all.votes));
});

test('save(更新): CreatedAt を保持し、_baseUpdatedAt が古ければ conflict', async () => {
  const before = (await post({ action: 'list', resource: 'events', token: member })).items.find(e => e.ID === evId);
  await new Promise(r => setTimeout(r, 5));
  const upd = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: evId, Title: '更新後', Date: '2026-10-01', _baseUpdatedAt: before.UpdatedAt } });
  assert.equal(upd.success, true);
  assert.equal(upd.item.CreatedAt, before.CreatedAt);
  assert.notEqual(upd.item.UpdatedAt, before.UpdatedAt);

  const stale = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: evId, Title: '古い版から', Date: '2026-10-01', _baseUpdatedAt: before.UpdatedAt } });
  assert.equal(stale.success, false);
  assert.equal(stale.error, 'conflict');
  const now = (await post({ action: 'list', resource: 'events', token: member })).items.find(e => e.ID === evId);
  assert.equal(now.Title, '更新後');         // conflict の書き込みは反映されない
});

test('save(部分更新): 送らなかった列は保持し、明示的な空文字・null の列だけ空にする。CreatedAt は書き換えられない', async () => {
  const id = 'ev_test_partial_' + Date.now();
  const created = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: id, Title: '部分', Date: '2026-10-03', Location: '体育館', VisitorCount: '120', PartsList: [{ name: 'A', presenters: ['x'] }] } });
  assert.equal(created.success, true);

  // Title だけ送る → 他の列は残る。応答も行全体を返す
  const upd = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: id, Title: '部分(改)', CreatedAt: '1999-01-01T00:00:00.000Z', _baseUpdatedAt: created.item.UpdatedAt } });
  assert.equal(upd.success, true);
  assert.equal(upd.item.Title, '部分(改)');
  assert.equal(upd.item.Location, '体育館');
  assert.equal(upd.item.VisitorCount, '120');
  assert.deepEqual(upd.item.PartsList, [{ name: 'A', presenters: ['x'] }]);
  assert.equal(upd.item.CreatedAt, created.item.CreatedAt);     // クライアントの CreatedAt は無視
  let got = (await post({ action: 'list', resource: 'events', token: member })).items.find(e => e.ID === id);
  assert.equal(got.Location, '体育館');
  assert.equal(got.Date, '2026-10-03');

  // '' と null を明示した列だけ空になる
  const clr = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: id, Location: '', VisitorCount: null, _baseUpdatedAt: upd.item.UpdatedAt } });
  assert.equal(clr.success, true);
  assert.equal(clr.item.Location, '');
  assert.equal(clr.item.VisitorCount, '');
  assert.equal(clr.item.Title, '部分(改)');

  // 更新する列が無くても UpdatedAt は進む(基準が古ければ conflict)
  await new Promise(r => setTimeout(r, 5));
  const touch = await post({ action: 'save', resource: 'events', token: member, item: { ID: id, _baseUpdatedAt: clr.item.UpdatedAt } });
  assert.equal(touch.success, true);
  assert.notEqual(touch.item.UpdatedAt, clr.item.UpdatedAt);
  assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id, _baseUpdatedAt: clr.item.UpdatedAt } })).error, 'conflict');

  await post({ action: 'delete', resource: 'events', id, token: adminMember, adminToken: admin });
});

test('save: ID の形式を検証する(英数字・_・- の 64 文字以内)', async () => {
  for (const bad of ["x');alert(1);//", 'ev "q"', 'ev<1>', 'a'.repeat(65), 'イベント1', 123, { a: 1 }]) {
    const r = await post({ action: 'save', resource: 'events', token: member, item: { ID: bad, Title: '不正' } });
    assert.equal(r.success, false, 'ID=' + JSON.stringify(bad));
    assert.equal(r.error, 'invalid_id', 'ID=' + JSON.stringify(bad));
  }
  const list = await post({ action: 'list', resource: 'events', token: member });
  assert.ok(!list.items.find(e => e.Title === '不正'));
  // ID 省略時はサーバーが採番する(その形式も検証を通る)
  const auto = await post({ action: 'save', resource: 'events', token: member, item: { Title: '自動採番' } });
  assert.equal(auto.success, true);
  assert.match(auto.item.ID, /^ev_[A-Za-z0-9_-]+$/);
  await post({ action: 'delete', resource: 'events', id: auto.item.ID, token: adminMember, adminToken: admin });
});

test('save: 同じ新規 ID を同時に保存しても内部エラーにならない(片方は作成、もう片方は更新か conflict)', async () => {
  const id = 'ev_test_race_' + Date.now();
  const rs = await Promise.all([1, 2, 3].map(n => post({ action: 'save', resource: 'events', token: member, item: { ID: id, Title: '同時' + n } })));
  rs.forEach(r => assert.ok(r.success === true || r.error === 'conflict', JSON.stringify(r)));
  assert.ok(rs.some(r => r.success));
  const list = await post({ action: 'list', resource: 'events', token: member });
  assert.equal(list.items.filter(e => e.ID === id).length, 1);
  await post({ action: 'delete', resource: 'events', id, token: adminMember, adminToken: admin });
});

test('delete: イベント・メンバーを削除すると、その出欠投票も同時に消える(他の投票は残る)', async () => {
  const t = Date.now();
  const evA = 'ev_test_vote_a_' + t, evB = 'ev_test_vote_b_' + t;
  const mbA = 'mb_test_vote_a_' + t, mbB = 'mb_test_vote_b_' + t;
  for (const id of [evA, evB]) {
    assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id, Title: '投票', Date: '2099-01-01' } })).success, true);
  }
  for (const id of [mbA, mbB]) {
    assert.equal((await post({ action: 'save', resource: 'members', token: member, item: { ID: id, Name: '投票者' + id } })).success, true);
  }
  const vote = (eventId, memberId) => post({ action: 'submitVote', token: member, vote: { eventId, memberId, status: 'attend' } });
  for (const [e, m] of [[evA, mbA], [evA, mbB], [evB, mbA], [evB, mbB]]) assert.equal((await vote(e, m)).success, true);
  const votesOf = async () => (await post({ action: 'listVotes', token: member })).votes.filter(v => [evA, evB].includes(v.eventId));

  assert.equal((await votesOf()).length, 4);

  // イベントを消すと、そのイベントの投票だけが消える
  assert.equal((await post({ action: 'delete', resource: 'events', id: evA, token: adminMember, adminToken: admin })).success, true);
  let left = await votesOf();
  assert.deepEqual(left.map(v => v.eventId).sort(), [evB, evB]);

  // メンバーを消すと、そのメンバーの投票だけが消える
  assert.equal((await post({ action: 'delete', resource: 'members', id: mbA, token: adminMember, adminToken: admin })).success, true);
  left = await votesOf();
  assert.deepEqual(left.map(v => v.memberId), [mbB]);

  await post({ action: 'delete', resource: 'events', id: evB, token: adminMember, adminToken: admin });
  await post({ action: 'delete', resource: 'members', id: mbB, token: adminMember, adminToken: admin });
  assert.equal((await votesOf()).length, 0);
});

test('save: 削除済み ID に _baseUpdatedAt 付きで保存すると conflict(復活させない)。基準なしの再作成(Undo)は通る', async () => {
  const id = 'ev_test_deleted_' + Date.now();
  const created = await post({ action: 'save', resource: 'events', token: member, item: { ID: id, Title: '消す予定', Date: '2026-10-02' } });
  assert.equal(created.success, true);
  assert.equal((await post({ action: 'delete', resource: 'events', id, token: adminMember, adminToken: admin })).success, true);

  const stale = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: id, Title: '編集中だった', Date: '2026-10-02', _baseUpdatedAt: created.item.UpdatedAt } });
  assert.equal(stale.success, false);
  assert.equal(stale.error, 'conflict');
  const list = await post({ action: 'list', resource: 'events', token: member });
  assert.ok(!list.items.find(e => e.ID === id));   // 復活していない

  // 削除の Undo は _baseUpdatedAt なし(ID と CreatedAt 付き)で再保存する
  const undo = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: id, Title: '消す予定', Date: '2026-10-02', CreatedAt: created.item.CreatedAt } });
  assert.equal(undo.success, true);
  assert.equal(undo.item.CreatedAt, created.item.CreatedAt);
  await post({ action: 'delete', resource: 'events', id, token: adminMember, adminToken: admin });
});

test('投票: upsert、note の保持、締切後は管理者のみ', async () => {
  // 未来の日付のイベントで投票
  let r = await post({ action: 'submitVote', token: member, vote: { eventId: evId, memberId: 'mb_1', status: 'attend', note: '遅れます' } });
  assert.equal(r.success, true);
  assert.equal(r.vote.note, '遅れます');
  r = await post({ action: 'submitVote', token: member, vote: { eventId: evId, memberId: 'mb_1', status: 'absent' } });
  assert.equal(r.vote.status, 'absent');
  assert.equal(r.vote.note, '遅れます');     // note 未指定なら既存メモを保持

  const ev = await post({ action: 'getEventVotes', token: member, eventId: evId });
  assert.equal(ev.votes.length, 1);
  const all = await post({ action: 'listVotes', token: member });
  assert.ok(all.votes.find(v => v.eventId === evId && v.memberId === 'mb_1'));

  assert.equal((await post({ action: 'submitVote', token: member, vote: { eventId: evId, memberId: 'mb_1', status: 'bogus' } })).error, 'invalid status');
  assert.equal((await post({ action: 'submitVote', token: member, vote: { eventId: 'nope', memberId: 'mb_1', status: 'attend' } })).error, 'event not found');

  // 過去のイベントは締切後
  const pastId = 'ev_past_' + Date.now();
  await post({ action: 'save', resource: 'events', token: member, item: { ID: pastId, Title: '過去', Date: '2020-01-01' } });
  assert.equal((await post({ action: 'submitVote', token: member, vote: { eventId: pastId, memberId: 'mb_1', status: 'attend' } })).error, 'vote_closed');
  const adm = await post({ action: 'submitVote', token: adminMember, adminToken: admin, vote: { eventId: pastId, memberId: 'mb_1', status: 'attend' } });
  assert.equal(adm.success, true);
  await post({ action: 'delete', resource: 'events', token: adminMember, adminToken: admin, id: pastId });
});

test('管理者: パスワード一覧の保存・取得、設定の取得(機密値は返さない)・更新', async () => {
  const pwId = 'pw_test_' + Date.now();
  let r = await post({ action: 'save', resource: 'passwords', token: adminMember, adminToken: admin, item: { ID: pwId, SiteName: 'テスト', Password: 'secret' } });
  assert.equal(r.success, true);
  r = await post({ action: 'list', resource: 'passwords', token: adminMember, adminToken: admin });
  assert.ok(r.items.find(p => p.ID === pwId));
  assert.equal((await post({ action: 'delete', resource: 'passwords', token: adminMember, adminToken: admin, id: pwId })).success, true);

  const cfg = await post({ action: 'adminGetConfig', token: adminMember, adminToken: admin });
  assert.equal(cfg.success, true);
  assert.equal(cfg.config.password_set, true);
  assert.equal(cfg.config.admin_password_set, true);
  assert.equal(cfg.config.password, undefined);
  assert.equal(cfg.config.gemini_api_key, undefined);
  assert.equal(cfg.config.brand_name, 'SciComi Portal');   // 既定値へフォールバック

  const pub = await post({ action: 'getPublicConfig', token: member });
  assert.equal(pub.config.brand_name, 'SciComi Portal');
  assert.equal(pub.config.password, undefined);
  assert.equal(pub.config.line_channel_access_token, undefined);

  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'nope', value: 'x' })).error, 'forbidden_key');
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'brand_icon', value: '12345' })).error, 'invalid_value');
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'password', value: ADMIN_PW })).error, 'invalid_value'); // 一般=幹部は拒否
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'password', value: 'short1234' })).error, 'invalid_value'); // 10 文字未満は拒否
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'admin_password', value: '123456789' })).error, 'invalid_value');
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'welcome_message', value: 'こんにちは' })).success, true);
  assert.equal((await post({ action: 'getPublicConfig', token: member })).config.welcome_message, 'こんにちは');
  await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'welcome_message', value: '' });
});

test('パスワード変更でそのロールの既存トークンが失効する', async () => {
  const NEW = 'changed-member-pw';
  try {
    assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'password', value: NEW })).success, true);
    assert.equal((await post({ action: 'listAll', token: member })).error, 'unauthorized');            // 旧トークンは失効
    assert.equal((await post({ action: 'login', password: MEMBER_PW })).success, false);              // 旧パスワードは不可
    const fresh = await post({ action: 'login', password: NEW });
    assert.equal(fresh.success, true);
    assert.equal((await post({ action: 'listAll', token: fresh.token })).success, true);
  } finally {
    // 元に戻す(管理者のメンバートークンも一般トークンなので、世代更新で失効している。ログインし直す)
    const a = await post({ action: 'login', password: ADMIN_PW });
    adminMember = a.token; admin = a.adminToken;
    await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'password', value: MEMBER_PW });
    member = (await post({ action: 'login', password: MEMBER_PW })).token;
    const a2 = await post({ action: 'login', password: ADMIN_PW });
    adminMember = a2.token; admin = a2.adminToken;
  }
});

test('ファイル: アップロード → 公開 URL で取得(ログイン不要) → 管理者が削除', async () => {
  const bytes = Buffer.from('hello r2');
  const up = await post({ action: 'uploadFile', token: member, file: { name: 'メモ.txt', mimeType: 'text/plain', base64: bytes.toString('base64') } });
  assert.equal(up.success, true);
  assert.equal(up.file.size, bytes.length);
  assert.ok(up.file.driveId && up.file.url.includes('/files/'));
  const got = await fetch(up.file.url.replace(/^https?:\/\/[^/]+/, BASE));
  assert.equal(got.status, 200);
  assert.equal(await got.text(), 'hello r2');
  assert.match(got.headers.get('content-disposition'), /^inline/);

  // HTML はブラウザ内で実行されないよう、ダウンロード扱いになる
  const html = await post({ action: 'uploadFile', token: member, file: { name: 'x.html', mimeType: 'text/html', base64: Buffer.from('<script>1</script>').toString('base64') } });
  const hr = await fetch(html.file.url.replace(/^https?:\/\/[^/]+/, BASE));
  assert.match(hr.headers.get('content-disposition'), /^attachment/);
  assert.equal(hr.headers.get('content-type'), 'application/octet-stream');

  assert.equal((await post({ action: 'deleteFile', token: member, adminToken: member, driveId: up.file.driveId })).error, 'admin_required');
  assert.equal((await post({ action: 'deleteFile', token: adminMember, adminToken: admin, driveId: up.file.driveId })).success, true);
  assert.equal((await post({ action: 'deleteFile', token: adminMember, adminToken: admin, driveId: html.file.driveId })).success, true);
  assert.equal((await fetch(up.file.url.replace(/^https?:\/\/[^/]+/, BASE))).status, 404);
  assert.equal((await fetch(BASE + '/files/..%2Fsecret')).status, 404);
});

test('Gemini: キー未設定ならエラーコードを返し、使用量は取得できる', async () => {
  assert.equal((await post({ action: 'geminiProxy', token: member, message: 'こんにちは' })).error, 'gemini_key_not_configured');
  assert.equal((await post({ action: 'geminiGenerate', token: member, instruction: 'x', context: 'y' })).error, 'gemini_key_not_configured');
  const u = await post({ action: 'geminiUsage', token: member });
  assert.equal(u.success, true);
  assert.equal(u.usage, 0);
  assert.equal(u.limit, 1500);
});

test('後始末: 作成したテストデータを削除できる', async () => {
  assert.equal((await post({ action: 'delete', resource: 'events', token: adminMember, adminToken: admin, id: evId })).success, true);
  assert.equal((await post({ action: 'delete', resource: 'events', token: adminMember, adminToken: admin, id: evId })).success, false);
});

test('不明な action / resource', async () => {
  assert.match((await post({ action: 'bogus', token: member })).error, /unknown action/);
  assert.match((await post({ action: 'list', resource: 'bogus', token: member })).error, /unknown resource/);
});

// 最後に実行する: ローカルの同じ IP の admin スコープが 10 分間ロックされる(member スコープのログインには影響しない)
test('ログイン試行制限: 並列に大量の誤パスワードを送っても、検証まで進めるのは上限(30 回)まで', async () => {
  const rs = await Promise.all(Array.from({ length: 45 }, () => post({ action: 'adminAuth', admin_password: 'wrong-password-x' })));
  const limited = rs.filter(r => r.error === 'rate_limited').length;
  rs.forEach(r => assert.equal(r.success, false));
  assert.ok(45 - limited <= 30, 'rate_limited 以外が ' + (45 - limited) + ' 件');
  assert.ok(limited >= 15);
  // 上限中は正しいパスワードでも通らない
  assert.equal((await post({ action: 'adminAuth', admin_password: ADMIN_PW })).error, 'rate_limited');
  // 別スコープ(一般ログイン)は影響を受けない
  assert.equal((await post({ action: 'login', password: MEMBER_PW })).success, true);
});
