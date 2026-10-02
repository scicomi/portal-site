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

async function post(payload, extraHeaders) {
  const res = await fetch(BASE, { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/plain' }, extraHeaders || {}), body: JSON.stringify(payload) });
  return res.json();
}

// ログイン試行制限のテスト専用の送信元 IP(実行ごとに別の値)。
// ローカルの wrangler dev では CF-Connecting-IP をクライアントが指定でき、この IP のスコープだけがロックされる
// (本番の Cloudflare はこのヘッダーを実際の接続元で上書きするため、偽装はできない)。
const RATE_LIMIT_TEST_IP = '198.51.100.' + (1 + Math.floor(Math.random() * 254)) + '-' + Date.now();

// ローカル DB に前回の作業の設定値が残っていても結果が変わらないよう、テストが前提にするキーの既定値
const CONFIG_DEFAULTS_FOR_TEST = {
  welcome_message: '',
  file_max_mb: '10', deadline_kyoka: '-10', deadline_houkoku: '7',
  trash_keep_days: '7'
};

let member = '', admin = '', adminMember = '';
const evId = 'ev_test_' + Date.now();
// 投票テストは evId を「締切前(未来)」のイベントとして使う。実行日に追い越されないよう遠い未来に固定する
const FUTURE_DATE = '2099-01-01';

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

test('前提: テストが参照する設定をローカル DB で既定値に戻す', async () => {
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS_FOR_TEST)) {
    const r = await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key, value });
    assert.equal(r.success, true, key + ': ' + JSON.stringify(r));
  }
});

test('メンバートークンでは管理者操作(削除・管理者設定・パスワード一覧)ができない', async () => {
  assert.equal((await post({ action: 'delete', resource: 'passwords', id: 'x', token: member, adminToken: member })).error, 'admin_required');
  assert.equal((await post({ action: 'delete', resource: 'guides', id: 'x', token: member, adminToken: member })).error, 'admin_required');
  assert.equal((await post({ action: 'adminGetConfig', token: member, adminToken: member })).error, 'admin_required');
  assert.equal((await post({ action: 'list', resource: 'passwords', token: member })).error, 'admin_required');
});

test('save(新規): イベントを保存し、一覧・listAll に反映される', async () => {
  const item = { ID: evId, Title: 'テストイベント', Date: FUTURE_DATE, Category: 'normal', PartsList: [{ name: '実験', presenters: ['A'] }], Files: [] };
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

test('save: 企画担当者・荷物運搬方法・書類ファイル・関連資料が保存され、ファイルは配列で返る', async () => {
  const id = 'ev_test_fields_' + Date.now();
  const doc = { name: '許可願.pdf', url: 'https://example.com/files/abc.pdf', driveId: 'abc.pdf', size: 10 };
  const item = {
    ID: id, Title: '新項目テスト', Date: '2026-10-02', Category: 'normal',
    PlanLeader: 'A, B', TransportMethod: '学用車', TransportDriver: '先生', TransportPassengers: 'A, B',
    RequestDoc: [doc], KyokaDoc: [doc], HoukokuDoc: [], MeetingDocs: [doc, doc], Minutes: [doc]
  };
  const r = await post({ action: 'save', resource: 'events', token: member, item });
  assert.equal(r.success, true);
  const got = (await post({ action: 'list', resource: 'events', token: member })).items.find(e => e.ID === id);
  assert.equal(got.PlanLeader, 'A, B');
  assert.equal(got.TransportMethod, '学用車');
  assert.equal(got.TransportDriver, '先生');
  assert.equal(got.TransportPassengers, 'A, B');
  assert.deepEqual(got.RequestDoc, [doc]);
  assert.deepEqual(got.KyokaDoc, [doc]);
  assert.deepEqual(got.HoukokuDoc, []);
  assert.deepEqual(got.MeetingDocs, [doc, doc]);
  assert.deepEqual(got.Minutes, [doc]);
  // 後始末
  const d = await post({ action: 'delete', resource: 'events', id, token: adminMember, adminToken: admin });
  assert.equal(d.success, true);
});

test('save(更新): CreatedAt を保持し、_baseUpdatedAt が古ければ conflict', async () => {
  const before = (await post({ action: 'list', resource: 'events', token: member })).items.find(e => e.ID === evId);
  await new Promise(r => setTimeout(r, 5));
  const upd = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: evId, Title: '更新後', Date: FUTURE_DATE, _baseUpdatedAt: before.UpdatedAt } });
  assert.equal(upd.success, true);
  assert.equal(upd.item.CreatedAt, before.CreatedAt);
  assert.notEqual(upd.item.UpdatedAt, before.UpdatedAt);

  const stale = await post({ action: 'save', resource: 'events', token: member,
    item: { ID: evId, Title: '古い版から', Date: FUTURE_DATE, _baseUpdatedAt: before.UpdatedAt } });
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

  const pub = await post({ action: 'getPublicConfig', token: member });
  assert.equal(pub.config.password, undefined);
  assert.equal(pub.config.line_channel_access_token, undefined);

  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'nope', value: 'x' })).error, 'forbidden_key');
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'password', value: ADMIN_PW })).error, 'invalid_value'); // 一般=幹部は拒否
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'password', value: 'short1234' })).error, 'invalid_value'); // 10 文字未満は拒否
  assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'admin_password', value: '123456789' })).error, 'invalid_value');
  // 書類期限は 1〜90 日(許可願は負の値で保存)。file_max_mb は 1 以上
  const setCfg = (key, value) => post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key, value });
  for (const [key, value] of [['deadline_kyoka', '0'], ['deadline_kyoka', '-91'], ['deadline_houkoku', '91'], ['deadline_houkoku', '7.5'], ['file_max_mb', '0'], ['file_max_mb', '-1']]) {
    assert.equal((await setCfg(key, value)).error, 'invalid_value', key + '=' + value);
  }
  assert.equal((await setCfg('deadline_kyoka', '-90')).success, true);
  assert.equal((await setCfg('deadline_houkoku', '1')).success, true);
  await setCfg('deadline_kyoka', '-10');
  await setCfg('deadline_houkoku', '7');
  assert.equal(String(pub.config.file_max_mb), '10');   // アップロード上限はメンバーにも公開(フロントの事前チェック用)
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

test('ゴミ箱: 外した項目(添付・写真・動画・振り返り・セクション)はゴミ箱に入り、メンバーも戻せる', async () => {
  const f1 = { name: 'a.pdf', url: 'https://example.com/files/a.pdf', driveId: 'a.pdf', size: 1 };
  const f2 = { name: 'b.pdf', url: 'https://example.com/files/b.pdf', driveId: 'b.pdf', size: 1 };
  const id = 'ev_test_rm_' + Date.now();
  assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id, Title: '外し', Date: '2026-10-05', Category: 'normal', Files: [f1, f2], KyokaDoc: [f1] } })).success, true);
  const trashOf = async () => (await post({ action: 'listTrash', token: member })).items.filter(t => t.recordId === id);

  // メンバーが 1 つ外す → 保存でき、ゴミ箱に入る(中身は一覧に出ない)
  assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id, Files: [f2] } })).success, true);
  let t = await trashOf();
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].kind, t[0].resource, t[0].field, t[0].label, t[0].recordLabel], ['item', 'events', 'Files', 'a.pdf', '外し']);
  assert.equal(t[0].payload, undefined);
  let cur = (await post({ action: 'list', resource: 'events', token: member })).items.find(e => e.ID === id);
  assert.deepEqual(cur.Files.map(f => f.driveId), ['b.pdf']);

  // 戻す → 元の列に戻り、ゴミ箱から消える
  assert.equal((await post({ action: 'restoreTrash', token: member, id: t[0].id })).success, true);
  cur = (await post({ action: 'list', resource: 'events', token: member })).items.find(e => e.ID === id);
  assert.deepEqual(cur.Files.map(f => f.driveId).sort(), ['a.pdf', 'b.pdf']);
  assert.equal((await trashOf()).length, 0);

  // 1 ファイルの枠(許可願)の差し替え: 古いほうがゴミ箱へ。枠が埋まっている間は戻せない
  assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id, KyokaDoc: [f2] } })).success, true);
  t = await trashOf();
  assert.equal(t.length, 1);
  assert.equal((await post({ action: 'restoreTrash', token: member, id: t[0].id })).error, 'slot_occupied');
  // 他の列の編集・追加ではゴミ箱に入らない
  assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id, Title: '改題', Files: [f1, f2] } })).success, true);
  assert.equal((await trashOf()).length, 1);
  // 完全に削除(メンバーも可)
  assert.equal((await post({ action: 'purgeTrash', token: member, id: t[0].id })).success, true);
  assert.equal((await trashOf()).length, 0);

  // 実験: 写真・動画・振り返り・セクション
  const xid = 'ex_test_rm_' + Date.now();
  const p1 = { name: 'p1.png', url: 'https://example.com/files/p1.png', driveId: 'p1.png' };
  const p2 = { name: 'p2.png', url: 'https://example.com/files/p2.png', driveId: 'p2.png' };
  const fb = [{ id: 'fb1', text: 'a' }, { id: 'fb2', text: 'b' }];
  const secs = [{ title: 's1', content: 'x' }, { title: 's2', content: 'y' }];
  const xtrash = async () => (await post({ action: 'listTrash', token: member })).items.filter(t => t.recordId === xid);
  assert.equal((await post({ action: 'save', resource: 'experiments', token: member, item: { ID: xid, Name: '実験', Photos: JSON.stringify([p1, p2]), Reflections: JSON.stringify(fb), Sections: JSON.stringify(secs), Videos: JSON.stringify([{ id: 'v1', title: '動画1' }]) } })).success, true);
  // 追加と、振り返りの文面の編集(id が同じ)ではゴミ箱に入らない
  assert.equal((await post({ action: 'save', resource: 'experiments', token: member, item: { ID: xid, Reflections: JSON.stringify([{ id: 'fb1', text: '直した' }, fb[1]]), Videos: JSON.stringify([{ id: 'v2' }, { id: 'v1', title: '動画1' }]) } })).success, true);
  assert.equal((await xtrash()).length, 0);
  assert.equal((await post({ action: 'save', resource: 'experiments', token: member, item: { ID: xid, Photos: JSON.stringify([p2]), Reflections: JSON.stringify([fb[0]]), Videos: JSON.stringify([{ id: 'v2' }]), Sections: JSON.stringify([secs[0]]) } })).success, true);
  const xt = await xtrash();
  assert.deepEqual(xt.map(t => t.field).sort(), ['Photos', 'Reflections', 'Sections', 'Videos']);
  assert.equal(xt.find(t => t.field === 'Sections').label, 's2');
  assert.equal(xt.find(t => t.field === 'Videos').label, '動画1');
  for (const e of xt) assert.equal((await post({ action: 'restoreTrash', token: member, id: e.id })).success, true, e.field);
  const x = (await post({ action: 'list', resource: 'experiments', token: member })).items.find(e => e.ID === xid);
  assert.equal(JSON.parse(x.Photos).length, 2);
  assert.equal(JSON.parse(x.Sections).length, 2);
  assert.equal(JSON.parse(x.Videos).length, 2);
  assert.equal(JSON.parse(x.Reflections).length, 2);
  assert.equal((await xtrash()).length, 0);

  // 同じ見出しのセクションが 2 つあるとき、片方を外して戻すと 2 つに戻る(「すでに戻っている」と誤判定しない)
  const dup = [{ title: '注意', content: '一つ目' }, { title: '注意', content: '二つ目' }];
  assert.equal((await post({ action: 'save', resource: 'experiments', token: member, item: { ID: xid, Sections: JSON.stringify(dup) } })).success, true);
  assert.equal((await post({ action: 'save', resource: 'experiments', token: member, item: { ID: xid, Sections: JSON.stringify([dup[0]]) } })).success, true);
  const dt = (await xtrash()).filter(t => t.field === 'Sections');
  assert.equal(dt.length, 1);
  assert.equal((await post({ action: 'restoreTrash', token: member, id: dt[0].id })).success, true);
  const xs = (await post({ action: 'list', resource: 'experiments', token: member })).items.find(e => e.ID === xid);
  assert.deepEqual(JSON.parse(xs.Sections).map(s => s.content).sort(), ['一つ目', '二つ目']);
  assert.equal((await xtrash()).length, 0);

  // 競合した保存(古い版)ではゴミ箱に入れない
  const stale = x.UpdatedAt;
  assert.equal((await post({ action: 'save', resource: 'experiments', token: member, item: { ID: xid, Name: '先に更新' } })).success, true);
  assert.equal((await post({ action: 'save', resource: 'experiments', token: member, item: { ID: xid, Photos: JSON.stringify([p2]), _baseUpdatedAt: stale } })).error, 'conflict');
  assert.equal((await xtrash()).length, 0);

  assert.equal((await post({ action: 'delete', resource: 'events', id, token: member })).success, true);
  assert.equal((await post({ action: 'delete', resource: 'experiments', id: xid, token: member })).success, true);
  for (const t of [...await trashOf(), ...await xtrash()]) await post({ action: 'purgeTrash', token: member, id: t.id });
});

test('ゴミ箱: 削除したレコードは(出欠投票ごと)ゴミ箱に入り、メンバーも戻せる。パスワードは管理者だけ', async () => {
  const t0 = Date.now();
  const evId2 = 'ev_test_trash_' + t0, mbId = 'mb_test_trash_' + t0, pwId2 = 'pw_test_trash_' + t0;
  assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: evId2, Title: 'ゴミ箱テスト', Date: '2099-01-01', Category: 'normal' } })).success, true);
  assert.equal((await post({ action: 'save', resource: 'members', token: member, item: { ID: mbId, Name: 'ゴミ箱 太郎', FiscalYear: '2099', Active: 'true' } })).success, true);
  assert.equal((await post({ action: 'submitVote', token: member, vote: { eventId: evId2, memberId: mbId, status: 'attend' } })).success, true);
  assert.equal((await post({ action: 'save', resource: 'passwords', token: adminMember, adminToken: admin, item: { ID: pwId2, SiteName: 'テストサイト', Password: 'secret-pass' } })).success, true);

  // メンバーが削除できる(ゴミ箱へ)。一覧から消え、出欠投票も消える
  const d = await post({ action: 'delete', resource: 'events', id: evId2, token: member });
  assert.equal(d.success, true);
  assert.ok(d.trashId);
  assert.equal((await post({ action: 'list', resource: 'events', token: member })).items.some(e => e.ID === evId2), false);
  assert.equal((await post({ action: 'listVotes', token: member })).votes.some(v => v.eventId === evId2), false);
  assert.equal((await post({ action: 'delete', resource: 'events', id: evId2, token: member })).success, false);   // 二重削除

  const list = (await post({ action: 'listTrash', token: member })).items;
  const rec = list.find(t => t.id === d.trashId);
  assert.deepEqual([rec.kind, rec.resource, rec.recordId, rec.label], ['record', 'events', evId2, 'ゴミ箱テスト']);
  assert.ok(rec.expiresAt > rec.deletedAt);
  assert.equal(rec.payload, undefined);   // 中身(個人情報など)は一覧に出さない

  // 戻す → 一覧に再び現れ、出欠投票も戻る
  const r = await post({ action: 'restoreTrash', token: member, id: d.trashId });
  assert.equal(r.success, true);
  assert.equal(r.item.Title, 'ゴミ箱テスト');
  assert.equal((await post({ action: 'list', resource: 'events', token: member })).items.some(e => e.ID === evId2), true);
  assert.equal((await post({ action: 'listVotes', token: member })).votes.some(v => v.eventId === evId2 && v.memberId === mbId), true);
  assert.equal((await post({ action: 'restoreTrash', token: member, id: d.trashId })).error, 'not_found');

  // 同じ ID が既にあれば戻せない(already_exists)
  const dm = await post({ action: 'delete', resource: 'members', id: mbId, token: member });
  assert.equal((await post({ action: 'save', resource: 'members', token: member, item: { ID: mbId, Name: '同じ ID の別人' } })).success, true);
  assert.equal((await post({ action: 'restoreTrash', token: member, id: dm.trashId })).error, 'already_exists');
  // 完全に削除
  assert.equal((await post({ action: 'purgeTrash', token: member, id: dm.trashId })).success, true);
  assert.equal((await post({ action: 'purgeTrash', token: member, id: dm.trashId })).success, false);

  // パスワード: メンバーは削除できず、ゴミ箱の一覧にも出ない。管理者の削除はゴミ箱に入り、管理者だけが扱える
  assert.equal((await post({ action: 'delete', resource: 'passwords', id: pwId2, token: member })).error, 'admin_required');
  const dp = await post({ action: 'delete', resource: 'passwords', id: pwId2, token: adminMember, adminToken: admin });
  assert.equal(dp.success, true);
  assert.equal((await post({ action: 'listTrash', token: member })).items.some(t => t.id === dp.trashId), false);
  assert.equal((await post({ action: 'listTrash', token: adminMember, adminToken: admin })).items.some(t => t.id === dp.trashId), true);
  assert.equal((await post({ action: 'restoreTrash', token: member, id: dp.trashId })).error, 'admin_required');
  assert.equal((await post({ action: 'purgeTrash', token: member, id: dp.trashId })).error, 'admin_required');
  assert.equal((await post({ action: 'purgeTrash', token: adminMember, adminToken: admin, id: dp.trashId })).success, true);

  // 後始末
  assert.equal((await post({ action: 'delete', resource: 'events', id: evId2, token: member })).success, true);
  assert.equal((await post({ action: 'delete', resource: 'members', id: mbId, token: member })).success, true);
  for (const t of (await post({ action: 'listTrash', token: member })).items.filter(t => [evId2, mbId].includes(t.recordId))) await post({ action: 'purgeTrash', token: member, id: t.id });
  // 未ログインは使えない
  assert.equal((await post({ action: 'listTrash' })).error, 'unauthorized');
});

test('ゴミ箱: 期限が来たものは完全に削除され、R2 のファイル実体も消える', async () => {
  const up = await post({ action: 'uploadFile', token: member, file: { name: 'ごみ.txt', mimeType: 'text/plain', base64: Buffer.from('trash me').toString('base64') } });
  const fileUrl = up.file.url.replace(/^https?:\/\/[^/]+/, BASE);
  const id = 'ev_test_expire_' + Date.now();
  assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id, Title: '期限切れ', Date: '2099-01-02', Category: 'normal', Files: [up.file] } })).success, true);

  // ゴミ箱にある間はファイルが残る
  assert.equal((await post({ action: 'delete', resource: 'events', id, token: member })).success, true);
  assert.equal((await fetch(fileUrl)).status, 200);

  // 保管日数を 0 にしてもう 1 つ削除 → 一覧を開くと(定期実行を待たずに)期限切れが完全に削除される。
  // 途中で失敗しても 0 のまま残さない(残ると以後の実行でゴミ箱のテストが連鎖して失敗する)
  let left;
  try {
    assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'trash_keep_days', value: '0' })).success, true);
    const id2 = 'ev_test_expire2_' + Date.now();
    assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: id2, Title: '期限切れ2', Date: '2099-01-03', Category: 'normal' } })).success, true);
    assert.equal((await post({ action: 'delete', resource: 'events', id: id2, token: member })).success, true);
    await new Promise(r => setTimeout(r, 20));
    left = (await post({ action: 'listTrash', token: member })).items;
    assert.equal(left.some(t => t.recordId === id2), false);   // 期限切れは消えた
    assert.equal(left.some(t => t.recordId === id), true);     // 7 日(既定)のほうは残る
  } finally {
    assert.equal((await post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key: 'trash_keep_days', value: '7' })).success, true);
  }

  // 完全に削除すると、ファイル実体も消える
  const mine = left.find(t => t.recordId === id);
  assert.equal((await post({ action: 'purgeTrash', token: member, id: mine.id })).success, true);
  assert.equal((await fetch(fileUrl)).status, 404);
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

// AI検索は停止中(wrangler.toml の GEMINI_ENABLED = "false")。キーの有無にかかわらず Gemini へ送らないことを確認する。
// 再開するときは GEMINI_ENABLED を "true" にし、このテストを「キー未設定なら gemini_key_not_configured」に戻す(docs/09_aibot_suspended.md)。
test('Gemini: 停止中は feature_disabled を返し、認証なしは拒否される', async () => {
  assert.equal((await post({ action: 'geminiProxy', message: 'こんにちは' })).error, 'unauthorized');
  assert.equal((await post({ action: 'geminiProxy', token: member, message: 'こんにちは' })).error, 'feature_disabled');
  assert.equal((await post({ action: 'geminiGenerate', token: member, instruction: 'x', context: 'y' })).error, 'feature_disabled');
  assert.equal((await post({ action: 'geminiUsage', token: member })).error, 'feature_disabled');
});

test('後始末: 作成したテストデータを削除できる', async () => {
  assert.equal((await post({ action: 'delete', resource: 'events', token: adminMember, adminToken: admin, id: evId })).success, true);
  assert.equal((await post({ action: 'delete', resource: 'events', token: adminMember, adminToken: admin, id: evId })).success, false);
});

test('guides: 閲覧はメンバーも可、作成・編集・削除は管理者のみ。古い版での上書きは conflict', async () => {
  const body = JSON.stringify({ blocks: [{ type: 'paragraph', data: { text: 'テスト' } }] });
  // メンバー(管理者トークンなし)は書き込めない
  assert.equal((await post({ action: 'save', resource: 'guides', token: member, item: { Title: '拒否されるはず', Body: body } })).error, 'admin_required');
  assert.equal((await post({ action: 'save', resource: 'guides', token: member, adminToken: member, item: { Title: '拒否されるはず' } })).error, 'admin_required');
  const r = await post({ action: 'save', resource: 'guides', token: adminMember, adminToken: admin, item: { Title: 'テストガイド', Icon: 'blue', Body: body } });
  assert.equal(r.success, true);
  assert.match(r.item.ID, /^gd_/);
  const id = r.item.ID;
  // 一覧はメンバーも読める
  const list = await post({ action: 'list', resource: 'guides', token: member });
  assert.equal(list.items.find(g => g.ID === id).Body, body);
  const upd = await post({ action: 'save', resource: 'guides', token: adminMember, adminToken: admin, item: { ID: id, Title: '更新後', _baseUpdatedAt: r.item.UpdatedAt } });
  assert.equal(upd.success, true);
  assert.equal(upd.item.Body, body);   // 送らなかった列は保持される
  const stale = await post({ action: 'save', resource: 'guides', token: adminMember, adminToken: admin, item: { ID: id, Title: '古い版', _baseUpdatedAt: r.item.UpdatedAt } });
  assert.equal(stale.error, 'conflict');
  assert.equal((await post({ action: 'delete', resource: 'guides', id, token: member, adminToken: member })).error, 'admin_required');
  assert.equal((await post({ action: 'delete', resource: 'guides', id, token: adminMember, adminToken: admin })).success, true);
});

test('不明な action / resource', async () => {
  assert.match((await post({ action: 'bogus', token: member })).error, /unknown action/);
  assert.match((await post({ action: 'list', resource: 'bogus', token: member })).error, /unknown resource/);
});

// テスト専用の IP(RATE_LIMIT_TEST_IP)だけをロックする。実際の接続元(127.0.0.1)の admin スコープはロックしないので、
// 続けて npm test を再実行したり、画面から幹部ログインしたりできる。
test('ログイン試行制限: 並列に大量の誤パスワードを送っても、検証まで進めるのは上限(30 回)まで', async () => {
  const asTestIp = { 'CF-Connecting-IP': RATE_LIMIT_TEST_IP };
  const rs = await Promise.all(Array.from({ length: 45 }, () => post({ action: 'adminAuth', admin_password: 'wrong-password-x' }, asTestIp)));
  const limited = rs.filter(r => r.error === 'rate_limited').length;
  rs.forEach(r => assert.equal(r.success, false));
  assert.ok(45 - limited <= 30, 'rate_limited 以外が ' + (45 - limited) + ' 件');
  assert.ok(limited >= 15);
  // 上限中は正しいパスワードでも通らない
  assert.equal((await post({ action: 'adminAuth', admin_password: ADMIN_PW }, asTestIp)).error, 'rate_limited');
  // 別スコープ(一般ログイン)は影響を受けない
  assert.equal((await post({ action: 'login', password: MEMBER_PW }, asTestIp)).success, true);
  // 実際の接続元(ヘッダーなし)の admin スコープはロックされていない
  const real = await post({ action: 'adminAuth', admin_password: ADMIN_PW });
  assert.equal(real.success, true, 'テスト用 IP 以外がロックされた: ' + JSON.stringify(real));
});

// login は幹部と一般を同じ 'member' スコープで数える。一般パスワードでの成功を挟んでも、
// それまでの失敗が消えず、幹部パスワードの推測を上限なしに続けられないこと。
test('ログイン試行制限: 一般パスワードでの成功を挟んでも、失敗の記録は消えない(幹部パスワードの推測を続けられない)', async () => {
  const asIp = { 'CF-Connecting-IP': '203.0.113.' + (1 + Math.floor(Math.random() * 254)) + '-' + Date.now() };
  const wrong = () => post({ action: 'login', password: 'wrong-admin-guess-x' }, asIp);
  const first = await Promise.all(Array.from({ length: 20 }, wrong));
  first.forEach(r => assert.equal(r.success, false));
  assert.equal((await post({ action: 'login', password: MEMBER_PW }, asIp)).success, true);
  const second = await Promise.all(Array.from({ length: 20 }, wrong));
  const limited = second.filter(r => r.error === 'rate_limited').length;
  assert.ok(limited >= 10, '成功を挟んだあとも上限(30 回)で止まること。rate_limited = ' + limited);
  assert.equal((await post({ action: 'login', password: ADMIN_PW }, asIp)).error, 'rate_limited');
});

test('設定: 日数・件数の設定は範囲外を拒否する(巨大な値で日付の計算が例外にならないように)', async () => {
  const set = (key, value) => post({ action: 'adminSetConfig', token: adminMember, adminToken: admin, key, value });
  for (const [key, value] of [['trash_keep_days', '366'], ['trash_keep_days', '999999999999'], ['trash_keep_days', '-1'], ['audit_keep_days', '0'], ['backup_keep_count', '0'], ['deadline_alert_danger', 'abc']]) {
    const r = await set(key, value);
    assert.equal(r.error, 'invalid_value', key + '=' + value);
  }
  assert.equal((await set('trash_keep_days', '365')).success, true);
  assert.equal((await set('trash_keep_days', '7')).success, true);
});
