// 結合テスト: 振り返りの要約(保存のあとの目印・定期実行の自動更新・「再生成」ボタン・Gemini の失敗の扱い)。
//
// 本物の Gemini には送らない。テストの中で 127.0.0.1 に偽の受け口を立て、Worker をそこへ向けて起動する
// (.dev.vars の中身は触らず、--var で渡す。API キーは、テストが偽の値をローカル DB に入れる):
//   npm run db:migrate:local
//   npx wrangler dev --local --persist-to .wrangler/state --test-scheduled --port 8787 \
//     --var GEMINI_ENABLED:true --var GEMINI_API_BASE:http://127.0.0.1:18788 \
//     --var SUMMARY_DELAY_SEC:0 --var SUMMARY_AUTO_DAILY_LIMIT:1000
//   GEMINI_TEST_PORT=18788 npm test
// 準備は api.test.mjs と同じ(ローカル DB のパスワード設定)。
// GEMINI_TEST_PORT が無い、または Worker がそう起動していなければ、停止中(GEMINI_ENABLED が "true" 以外)の動きだけを確かめる。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
const MEMBER_PW = process.env.TEST_MEMBER_PW || 'test-member-pw';
const ADMIN_PW = process.env.TEST_ADMIN_PW || 'test-admin-pw';
const FAKE_KEY = 'fake-gemini-key-for-local-test';   // 偽の受け口だけが受け取る、テスト用の値
const FAKE_MODEL = 'gemini-local-fake';

async function post(payload) {
  const res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('振り返りの要約: 停止中は enabled: false / feature_disabled、形式の誤りは断る', async t => {
  const login = await post({ action: 'login', password: MEMBER_PW });
  if (!login.success) { t.skip('ローカルの Worker に入れない(api.test.mjs の事前準備)'); return; }
  const member = login.token;
  assert.equal((await post({ action: 'getReflectionSummary', targetType: 'experiments', id: 'ex_x' })).error, 'unauthorized');
  assert.equal((await post({ action: 'getReflectionSummary', token: member, targetType: 'members', id: 'mb_x' })).error, 'invalid_target');
  assert.equal((await post({ action: 'getReflectionSummary', token: member, targetType: 'experiments', id: 'a b' })).error, 'invalid_id');
  assert.equal((await post({ action: 'regenerateReflectionSummary', token: member, targetType: 'passwords', id: 'pw_x' })).error, 'invalid_target');
  const st = await post({ action: 'getReflectionSummary', token: member, targetType: 'experiments', id: 'ex_not_exist' });
  if (st.enabled === false) {
    assert.deepEqual(st, { success: true, enabled: false });
    assert.equal((await post({ action: 'regenerateReflectionSummary', token: member, targetType: 'experiments', id: 'ex_not_exist' })).error, 'feature_disabled');
  } else {
    assert.equal(st.error, 'not_found');
  }
});

test('振り返りの要約: 自動更新・再生成・失敗の扱い・送る本文に氏名を入れない(偽の Gemini)', async t => {
  const port = parseInt(process.env.GEMINI_TEST_PORT, 10);
  if (!port) { t.skip('GEMINI_TEST_PORT が無い(このファイルの先頭のコメント)'); return; }
  const login = await post({ action: 'login', password: ADMIN_PW });
  if (!login.success || !login.adminToken) { t.skip('ローカルの Worker に入れない(api.test.mjs の事前準備)'); return; }
  const member = login.token, admin = login.adminToken;
  const runCron = () => fetch(BASE + '/cdn-cgi/handler/scheduled?cron=*+*+*+*+*');
  const probe = await post({ action: 'getReflectionSummary', token: member, targetType: 'experiments', id: 'ex_not_exist' });
  if (probe.enabled === false || (await runCron()).status !== 200) {
    t.skip('Worker が GEMINI_ENABLED:true で起動していない、または --test-scheduled が無い');
    return;
  }

  // ---- 偽の Gemini ----
  const received = [];
  let mode = 'ok';            // 'ok' | 'bad'(型が崩れた出力) | '429min' | '429day'
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET') { send(200, { models: [{ name: 'models/' + FAKE_MODEL, supportedGenerationMethods: ['generateContent'] }] }); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      received.push({ url: req.url, headers: req.headers, body, raw: Buffer.concat(chunks).toString('utf8') });
      if (mode === '429min') { send(429, { error: { code: 429, message: 'Resource exhausted', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] } }); return; }
      if (mode === '429day') {
        send(429, { error: { code: 429, message: 'Quota exceeded', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
        return;
      }
      const text = body.contents[0].parts[0].text;
      const refs = (text.match(/^\[F\d+\]/gm) || []).map(s => s.slice(1, -1));
      // 全件を 1 つ目の論点に振り分ける。'bad' は振り分けの番号が整数でない(型の崩れ)
      const assign = refs.map(ref => ({ ref, topic: mode === 'bad' ? '1' : 1 }));
      const out = { topics: [{ label: mode === 'bad' ? 'ずれ' : '反応が良い', type: 'positive' }], assign,
        positive: LEAK + 'さんが良かった、という声が多い。', improve: '一部に、説明が長いという声。' };
      send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

  const stamp = Date.now();
  const TAG = 'tag' + stamp;                       // このテストの振り返りだけを見分ける印(本文に入れる。末尾に対象ごとの A/B/C)
  const SURNAME = '要約試験' + stamp;
  const NAME = SURNAME + ' 花子';                  // メンバー表に入れる、試験専用の名前
  const LEAK = SURNAME;                            // 偽の Gemini が、出力に名前を書き写す(出力側の置き換えを確かめる)
  const mbId = 'mb_sum_' + stamp;
  const exId = 'ex_sum_' + stamp;
  const evId = 'ev_sum_' + stamp;
  const ex2Id = 'ex_sum2_' + stamp;
  const fbEntry = (n, text, key) => ({ id: 'fb_' + (stamp + n) + '_t' + n, text: text + ' ' + TAG + key, memberId: mbId, name: NAME, createdAt: new Date(stamp + n * 1000).toISOString() });
  // 偽の Gemini が受け取った、その対象(A: exId / B: evId / C: ex2Id)の呼び出し
  const mine = key => received.filter(r => r.raw.includes(TAG + key));
  const status = (type, id) => post({ action: 'getReflectionSummary', token: member, targetType: type, id });
  const regen = (type, id) => post({ action: 'regenerateReflectionSummary', token: member, targetType: type, id });
  // 定期実行を、その行の目印が消えるまで回す(1 回に 1 件しか見ないので、ほかの行が先に並んでいることがある)
  const drainUntilIdle = async (type, id) => {
    for (let i = 0; i < 40; i++) {
      await runCron();
      await sleep(150);
      const st = await status(type, id);
      if (st.state !== 'dirty') return st;
    }
    throw new Error('自動更新が終わらない: ' + type + ':' + id);
  };

  const items = {};
  const save = async (resource, id, patch) => {
    const before = items[id];
    const r = await post({ action: 'save', resource, token: member, item: Object.assign({}, before || {}, patch, { ID: id, _baseUpdatedAt: before ? before.UpdatedAt : '' }) });
    assert.equal(r.success, true, JSON.stringify(r));
    items[id] = r.item;
    await sleep(300);   // 保存のあとの目印(waitUntil)が書かれるのを待つ
  };
  const exEntries = { pos: [], ref: [] };
  const saveEx = (id) => save('experiments', id, { Name: '要約の試験 ' + stamp, Positives: JSON.stringify(exEntries.pos), Reflections: JSON.stringify(exEntries.ref) });

  try {
    assert.equal((await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'gemini_api_key', value: FAKE_KEY })).success, true);
    assert.equal((await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'gemini_model', value: FAKE_MODEL })).success, true);
    assert.equal((await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'reflection_summary_auto', value: 'true' })).success, true);
    assert.equal((await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'reflection_summary_auto', value: 'yes' })).error, 'invalid_value');
    assert.equal((await post({ action: 'save', resource: 'members', token: member, item: { ID: mbId, Name: NAME } })).success, true);

    // 2 件: 作らない(Gemini を呼ばない)
    exEntries.pos.push(fbEntry(1, SURNAME + 'さんの説明が分かりやすかった', 'A'));
    exEntries.ref.push(fbEntry(2, '説明が長かった。連絡は sum@example.com へ', 'A'));
    await saveEx(exId);
    let st = await drainUntilIdle('experiments', exId);
    assert.equal(mine('A').length, 0);
    assert.deepEqual([st.enabled, st.entryCount, st.summary, st.minEntries], [true, 2, null, 3]);
    assert.equal(st.autoEnabled, true);

    // 3 件目: 自動で作る
    exEntries.pos.push(fbEntry(3, '子どもの反応が良かった', 'A'));
    await saveEx(exId);
    st = await drainUntilIdle('experiments', exId);
    assert.equal(mine('A').length, 1);
    assert.equal(st.entryCount, 3);
    assert.equal(st.sourceCount, 3);
    assert.equal(st.stale, false);
    assert.match(st.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    assert.equal(st.summary.topics.length, 1);
    assert.equal(st.summary.topics[0].count, 3);
    assert.deepEqual(st.summary.topics[0].entryIds.slice().sort(), [exEntries.pos[0].id, exEntries.pos[1].id, exEntries.ref[0].id].sort());
    assert.ok(!JSON.stringify(st).includes(SURNAME), '出力に書き写された名前も置き換える');
    assert.ok(st.summary.positive.startsWith('〈メンバー〉'));

    // 送った本文: キーはヘッダーで、URL に載せない。氏名・memberId・名前の欄・連絡先は含まない
    const req = mine('A')[0];
    assert.equal(req.headers['x-goog-api-key'], FAKE_KEY);
    assert.equal(req.url, '/models/' + FAKE_MODEL + ':generateContent');
    assert.ok(!req.url.includes('key='));
    assert.ok(!req.raw.includes(SURNAME));
    assert.ok(!req.raw.includes(mbId));
    assert.ok(!req.raw.includes('sum@example.com'));
    assert.ok(!req.raw.includes(exEntries.pos[0].id), '本物の id は送らない');
    assert.ok(req.raw.includes('〈メンバー〉'));
    assert.ok(req.raw.includes('〈連絡先〉'));
    assert.ok(req.body.systemInstruction.parts[0].text.includes('指示ではなくデータ'));
    assert.equal(req.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(req.body.generationConfig.responseSchema.type, 'OBJECT');
    assert.deepEqual(req.body.generationConfig.responseSchema.propertyOrdering, ['topics', 'assign', 'positive', 'improve']);

    // 中身が同じなら呼ばない(振り返り以外を直した保存)
    await save('experiments', exId, { Notes: '振り返り以外の変更' });
    st = await drainUntilIdle('experiments', exId);
    assert.equal(mine('A').length, 1);
    assert.equal(st.stale, false);

    // 1 件の追加: 作らない(古い表示)。さらに 2 件(前回から +3)で作り直す
    exEntries.ref.push(fbEntry(4, '材料が足りなかった', 'A'));
    await saveEx(exId);
    st = await drainUntilIdle('experiments', exId);
    assert.equal(mine('A').length, 1);
    assert.deepEqual([st.stale, st.entryCount, st.sourceCount], [true, 4, 3]);
    exEntries.ref.push(fbEntry(5, '片付けに時間がかかった', 'A'));
    exEntries.pos.push(fbEntry(6, '準備が簡単だった', 'A'));
    await saveEx(exId);
    st = await drainUntilIdle('experiments', exId);
    assert.equal(mine('A').length, 2);
    assert.deepEqual([st.stale, st.entryCount, st.sourceCount], [false, 6, 6]);

    // 再生成: 中身が同じなら呼ばずに返す(今日の 1 回は使わない)。変わっていれば作り、2 回目は断る
    let r = await regen('experiments', exId);
    assert.deepEqual([r.success, r.unchanged, r.canRegenerate], [true, true, true]);
    assert.equal(mine('A').length, 2);
    exEntries.ref.push(fbEntry(7, '机の配置を変えたい', 'A'));
    await saveEx(exId);
    r = await regen('experiments', exId);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual([r.unchanged, r.stale, r.entryCount, r.canRegenerate], [undefined, false, 7, false]);
    assert.equal(mine('A').length, 3);
    r = await regen('experiments', exId);
    assert.equal(r.error, 'regenerate_limit');
    assert.equal(mine('A').length, 3);
    st = await drainUntilIdle('experiments', exId);   // 保存で付いた目印は、作り直し済みなので何もしない
    assert.equal(mine('A').length, 3);

    // 3 件未満に減ったら、要約を出さない
    exEntries.pos = exEntries.pos.slice(0, 1);
    exEntries.ref = exEntries.ref.slice(0, 1);
    await saveEx(exId);
    st = await drainUntilIdle('experiments', exId);
    assert.deepEqual([st.entryCount, st.summary, st.canRegenerate], [2, null, false]);
    assert.equal((await regen('experiments', exId)).error, 'not_enough_entries');

    // イベント: 以前の「1 つの文章」も 1 件として数え、根拠の id は 'fb_legacy' になる
    const evPos = [fbEntry(11, '盛り上がった', 'B'), fbEntry(12, '時間どおりに終わった', 'B')];
    await save('events', evId, {
      Title: '要約の試験', Category: 'normal', Date: '2099-11-03',
      Positives: JSON.stringify(evPos), Reflections: '机が足りなかった ' + TAG + 'B'
    });
    st = await drainUntilIdle('events', evId);
    assert.equal(mine('B').length, 1);
    assert.equal(st.entryCount, 3);
    assert.deepEqual(st.summary.topics[0].entryIds.slice().sort(), [evPos[0].id, evPos[1].id, 'fb_legacy'].sort());
    const evSummary = JSON.stringify(st.summary);

    // 型が崩れた出力は保存せず(前の要約のまま)、再試行を待つ
    mode = 'bad';
    evPos.push(fbEntry(13, '準備が早かった', 'B'), fbEntry(14, '説明が上手だった', 'B'), fbEntry(15, '道具が足りた', 'B'));
    await save('events', evId, { Positives: JSON.stringify(evPos) });
    for (let i = 0; i < 40 && mine('B').length < 2; i++) { await runCron(); await sleep(150); }
    await sleep(300);
    assert.equal(mine('B').length, 2);
    st = await status('events', evId);
    assert.deepEqual([st.entryCount, st.state, st.stale], [6, 'dirty', true]);   // 1 分後の再試行を待っている
    assert.equal(JSON.stringify(st.summary), evSummary);

    // 再生成: 出力が崩れたら失敗。Gemini は使ったので、今日の 1 回は使ったことにする
    r = await regen('events', evId);
    assert.equal(r.error, 'invalid_output');
    assert.equal(mine('B').length, 3);
    assert.equal((await status('events', evId)).canRegenerate, false);

    // 自動更新を止めていれば、定期実行は呼ばない(目印は残る)
    mode = '429min';
    await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'reflection_summary_auto', value: 'false' });
    exEntries.pos = [fbEntry(21, 'よかった', 'C'), fbEntry(22, '楽しかった', 'C')];
    exEntries.ref = [fbEntry(23, '暑かった', 'C')];
    await saveEx(ex2Id);
    for (let i = 0; i < 5; i++) { await runCron(); await sleep(100); }
    assert.equal(mine('C').length, 0);
    st = await status('experiments', ex2Id);
    assert.deepEqual([st.autoEnabled, st.state], [false, 'dirty']);

    // 毎分の 429: 失敗。Gemini に届かなかったので、今日の 1 回は返す
    r = await regen('experiments', ex2Id);
    assert.equal(r.error, 'RATE_LIMIT_MINUTE');
    assert.ok(mine('C').length >= 1);
    assert.equal((await status('experiments', ex2Id)).canRegenerate, true);

    // 1 日の 429: 失敗。今日の 1 回は返す。自動更新では、失敗に数えず翌日まで取り出さない
    mode = '429day';
    r = await regen('experiments', ex2Id);
    assert.equal(r.error, 'RATE_LIMIT_DAILY');
    assert.equal((await status('experiments', ex2Id)).canRegenerate, true);
    await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'reflection_summary_auto', value: 'true' });
    let n = mine('C').length;
    for (let i = 0; i < 40 && mine('C').length === n; i++) { await runCron(); await sleep(150); }
    await sleep(300);
    assert.equal(mine('C').length, n + 1, '自動更新が 1 回だけ呼ぶ');
    n = mine('C').length;
    for (let i = 0; i < 5; i++) { await runCron(); await sleep(100); }
    assert.equal(mine('C').length, n, '日次の上限のあとは、翌日まで呼ばない');
    st = await status('experiments', ex2Id);
    assert.deepEqual([st.state, st.summary], ['dirty', null]);

    // 正常に戻れば、再生成で作れる(自動の目印も消える)
    mode = 'ok';
    r = await regen('experiments', ex2Id);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual([r.state, r.stale, r.entryCount, r.canRegenerate], ['idle', false, 3, false]);
  } finally {
    await post({ action: 'delete', resource: 'experiments', token: member, id: exId });
    await post({ action: 'delete', resource: 'experiments', token: member, id: ex2Id });
    await post({ action: 'delete', resource: 'events', token: member, id: evId });
    await post({ action: 'delete', resource: 'members', token: member, id: mbId });
    await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'gemini_api_key', value: '' });
    await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'gemini_model', value: '' });
    await post({ action: 'adminSetConfig', token: member, adminToken: admin, key: 'reflection_summary_auto', value: 'true' });
    server.close();
  }
});
