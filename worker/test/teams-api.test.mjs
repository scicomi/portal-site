// 結合テスト: Teams への通知(新規は定期実行が自動で送り、変更は画面のボタンで差分だけを送る)。
//
// 送信先(Power Automate のフロー)の代わりに、テストの中で 127.0.0.1 に受け口を立てる。Worker を、受け口の場所を向けて起動する
// (本物の Teams には送らない。.dev.vars の中身は触らず、--var で渡す):
//   npm run db:migrate:local
//   npx wrangler dev --local --persist-to .wrangler/state --test-scheduled --port 8787 \
//     --var TEAMS_WEBHOOK_URL:http://127.0.0.1:18787/hook --var TEAMS_ALLOW_LOCAL_URL:true \
//     --var TEAMS_NEW_DELAY_SEC:0 --var TEAMS_COOLDOWN_SEC:0
//   TEAMS_TEST_PORT=18787 npm test
// 準備は api.test.mjs と同じ(ローカル DB のパスワード設定)。TEAMS_TEST_PORT が無い、または Worker がそう起動していなければ飛ばす。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
const MEMBER_PW = process.env.TEST_MEMBER_PW || 'test-member-pw';

async function post(payload) {
  const res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
  return res.json();
}

test('Teams への通知: 新規は自動、変更はボタンで差分だけ(失敗・復元・ミーティング・連続送信)', async t => {
  const port = parseInt(process.env.TEAMS_TEST_PORT, 10);
  if (!port) { t.skip('TEAMS_TEST_PORT が無い(このファイルの先頭のコメント)'); return; }
  const login = await post({ action: 'login', password: MEMBER_PW });
  if (!login.success) { t.skip('ローカルの Worker に入れない(api.test.mjs の事前準備)'); return; }
  const member = login.token;
  const runCron = () => fetch(BASE + '/cdn-cgi/handler/scheduled?cron=*+*+*+*+*');
  if ((await post({ action: 'getPublicConfig', token: member })).config.teams_enabled !== 'true' || (await runCron()).status !== 200) {
    t.skip('Worker が Teams の受け口を向いていない、または --test-scheduled が無い');
    return;
  }

  const received = [];
  let failNext = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (failNext > 0) { failNext--; res.writeHead(500); res.end(); return; }
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(202); res.end();
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

  // 定期実行を動かし、届いた本文を返す
  const drain = async () => {
    const before = received.length;
    await runCron();
    for (let i = 0; i < 30 && received.length === before; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 150));
    return received.slice(before).map(x => x.body);
  };
  // カードの項目を { '項目名(印)': '値' } にする。名前の横の学番は、空白でつなぐ。折りたたまれた文は先頭だけ
  const rows = body => Object.fromEntries(body.attachments[0].content.body.slice(1).filter(b => b.type === 'Container').flatMap(g => g.items).map(c => {
    const h = c.items[0];
    const label = h.type === 'ColumnSet' ? h.columns[0].items[0].text + h.columns[1].items[0].text : h.text;
    const value = c.items.slice(1).filter(b => b.type !== 'ActionSet' && b.isVisible !== false)
      .map(b => (b.type === 'ColumnSet' ? b.columns.map(col => col.items[0].text).join('').replace(/ /g, ' ') : b.text)).join('\n');
    return [label, value];
  }));
  const status = id => post({ action: 'teamsStatus', token: member, eventId: id });
  const notify = id => post({ action: 'teamsNotify', token: member, eventId: id });
  const id = 'ev_teams_' + Date.now();
  const mid = 'ev_teams_m_' + Date.now();
  const mbId = 'mb_teams_' + Date.now();
  // 名前は、ローカル DB の既存のメンバーと重ならない、試験専用のもの。企画担当者だけメンバー表に登録して、学番が付くことを確かめる
  const LEADER = 'Teams試験担当' + Date.now();
  const SABURO = 'Teams試験三郎' + Date.now();
  let ev;
  const save = async patch => {
    const r = await post({ action: 'save', resource: 'events', token: member, item: Object.assign({}, ev || {}, patch, { _baseUpdatedAt: ev ? ev.UpdatedAt : '' }) });
    assert.equal(r.success, true, JSON.stringify(r));
    ev = r.item;
  };

  try {
    // 認証と形式
    assert.equal((await post({ action: 'teamsStatus', eventId: id })).error, 'unauthorized');
    assert.equal((await post({ action: 'teamsNotify', token: member, eventId: 'a b' })).error, 'invalid_id');
    assert.equal((await notify('ev_not_exist')).error, 'not_found');

    // 新規: 保存すると、定期実行が 1 件だけ送る(まだ送っていない間の保存し直しは 1 件にまとまる)
    assert.equal((await post({ action: 'save', resource: 'members', token: member, item: { ID: mbId, Name: LEADER, StudentID: '9ZZT0001' } })).success, true);
    await save({ ID: id, Title: 'Teams 通知テスト', Category: 'normal', Date: '2099-11-03', DateEnd: '', TimeStart: '10:00', TimeEnd: '15:00', Location: '体育館', PlanLeader: LEADER });
    await save({ Remarks: '保存し直し' });
    const first = await drain();
    assert.equal(first.length, 1, JSON.stringify(first.map(b => b.kind)));
    assert.equal(first[0].kind, 'new');
    assert.equal(first[0].eventKey, id);
    assert.equal(first[0].type, 'message');
    assert.equal(received[0].headers['content-type'], 'application/json; charset=utf-8');
    const card = first[0].attachments[0].content;
    assert.equal(card.msteams.width, 'Full');
    assert.deepEqual(card.body[0].items.map(i => i.text), ['新しいイベントが登録されました', 'Teams 通知テスト']);
    assert.deepEqual(rows(first[0]), {
      'イベント日時': '2099年11月3日(火) 10:00 から 15:00', '場所': '体育館', '企画担当者': LEADER + ' 9ZZT0001',
      '実験内容': 'ー', '許可願担当': 'ー', '報告書担当': 'ー'
    });
    assert.deepEqual(card.actions.map(a => a.url), Array(2).fill('https://scicomi.github.io/portal-site/events.html?event=' + id + '&id=' + id + '~'));
    assert.equal((await drain()).length, 0, '送った後に、もう一度は送らない');

    // 状態: 送信済みで、変更なし。変更がないのにボタンを押しても送らない
    let st = await status(id);
    assert.equal(st.enabled, true);
    assert.equal(st.state, 'sent');
    assert.deepEqual(st.changed, []);
    assert.match(st.sentAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    let r = await notify(id);
    assert.deepEqual([r.success, r.sent, r.changed], [true, false, 0]);
    assert.equal(received.length, 1);

    // 変更: 保存しただけでは送らない。ボタンで、前回からの差分だけを kind: update で送る(何度直しても 1 件)
    await save({ Location: '講堂' });
    await save({ Location: '大講堂', AdminHoukoku: SABURO });
    assert.equal((await drain()).length, 0);
    st = await status(id);
    assert.deepEqual(st.changed, ['場所', '報告書担当']);
    r = await notify(id);
    assert.deepEqual([r.success, r.sent, r.kind, r.changed], [true, true, 'update', 2]);
    const upd = received[received.length - 1].body;
    assert.equal(upd.kind, 'update');
    assert.equal(upd.eventKey, id);
    assert.equal(upd.attachments[0].content.body[0].items[0].text, 'イベントの内容が更新されました');   // 変更(場所)と追記(報告書担当)が混ざる
    assert.deepEqual(rows(upd), {
      'イベント日時': '2099年11月3日(火) 10:00 から 15:00', '場所(変更)': '大講堂', '企画担当者': LEADER + ' 9ZZT0001',
      '実験内容': 'ー', '許可願担当': 'ー', '報告書担当(追記)': SABURO
    });
    assert.ok(!JSON.stringify(upd).includes('体育館'), '変更前の値は出さない');
    assert.deepEqual((await status(id)).changed, []);
    assert.equal(received.length, 2);

    // 失敗: 送れなかったら、状態は進まない(前回の内容のまま)。理由に送信先の URL を含めない
    await save({ Location: '中庭' });
    failNext = 1;
    r = await notify(id);
    assert.equal(r.success, false);
    assert.equal(r.error, 'teams_failed');
    assert.equal(r.detail, 'teams_http_500');
    assert.ok(!JSON.stringify(r).includes('127.0.0.1'));
    assert.deepEqual((await status(id)).changed, ['場所']);
    r = await notify(id);
    assert.equal(r.sent, true);
    const f3 = rows(received[received.length - 1].body);
    assert.equal(f3['場所(変更)'], '中庭');
    assert.equal(f3['報告書担当'], SABURO);   // 前回の送信で反映済みなので、変更の印は付かない
    assert.equal(Object.keys(f3).filter(k => /\((追記|変更|削除)\)$/.test(k)).length, 1);
    assert.equal(received[received.length - 1].body.attachments[0].content.body[0].items[0].text, 'イベントの内容が変更されました');

    // 削除の取り消し(元の CreatedAt を持った再作成)は、新規として送らない
    const restoredId = 'ev_teams_r_' + Date.now();
    assert.equal((await post({ action: 'save', resource: 'events', token: member, item: { ID: restoredId, Title: '復元', Category: 'normal', Date: '2099-12-01', CreatedAt: '2026-01-01T00:00:00.000Z' } })).success, true);
    assert.equal((await drain()).length, 0);
    assert.equal((await status(restoredId)).state, 'none');
    await post({ action: 'delete', resource: 'events', token: member, id: restoredId });

    // ミーティング: 4 項目のカード。未送信のものをボタンで今すぐ送ると、新規として送る
    ev = null;
    await save({ ID: mid, Title: '全体会', Category: 'general', MeetingNumber: '4', Date: '2099-11-05', TimeStart: '18:00', TimeEnd: '19:30', Location: '大教室', Remarks: '議題1、議題2' });
    assert.equal((await status(mid)).state, 'pending');
    r = await notify(mid);
    assert.deepEqual([r.success, r.sent, r.kind], [true, true, 'new']);
    const mtg = received[received.length - 1].body;
    assert.equal(mtg.attachments[0].content.body[0].style, 'attention');
    assert.deepEqual(mtg.attachments[0].content.body[0].items.map(i => i.text), ['全体ミーティングが登録されました', '第4回 全体会']);
    assert.deepEqual(rows(mtg), { '日時': '2099年11月5日(木) 18:00 から 19:30', '場所': '大教室', '議題': '議題1、議題2' });
    assert.equal((await status(mid)).state, 'sent');
    assert.equal((await drain()).length, 0, '送信待ちが残っていて、二重に送らない');
  } finally {
    await post({ action: 'delete', resource: 'events', token: member, id });
    await post({ action: 'delete', resource: 'events', token: member, id: mid });
    await post({ action: 'delete', resource: 'members', token: member, id: mbId });
    server.close();
  }
});
