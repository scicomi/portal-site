// 単体テスト: src/teams.js のカードの組み立てと、前回との差分。Worker を起動しなくても動く。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNewCard, buildUpdateCard, diffTeams, dateTimeText, eventLinks, webhookBody, postToTeams } from '../src/teams.js';
import { teamsConfigured } from '../src/config.js';

const SITE = 'https://scicomi.github.io/portal-site/';
const ev = {
  ID: 'ev_abc', Title: 'サイエンスショー', Category: 'normal', Date: '2026-11-03', DateEnd: '',
  Location: '○○小学校', TimeStart: '10:00', TimeEnd: '15:00', Remarks: '駐車場は裏門', PlanLeader: '山田',
  PartsList: '[{"name":"スライム作り","presenters":["花子","太郎"]}]',
  AdminKyoka: '次郎', KyokaNotRequired: '', AdminHoukoku: '', HoukokuNotRequired: ''
};
const facts = card => Object.fromEntries(card.body.find(b => b.type === 'FactSet').facts.map(f => [f.title, f.value]));

test('日時の書き方: 年つき・曜日つき・複数日・時間だけ片方', () => {
  assert.equal(dateTimeText(ev), '2026年11月3日(火) 10:00 から 15:00');
  assert.equal(dateTimeText(Object.assign({}, ev, { DateEnd: '2026-11-04', TimeStart: '', TimeEnd: '' })), '2026年11月3日(火) から 11月4日(水)');
  assert.equal(dateTimeText(Object.assign({}, ev, { Date: '2026-12-31', DateEnd: '2027-01-01', TimeStart: '', TimeEnd: '' })), '2026年12月31日(木) から 2027年1月1日(金)');
  assert.equal(dateTimeText(Object.assign({}, ev, { TimeEnd: '' })), '2026年11月3日(火) 10:00 から');
  assert.equal(dateTimeText(Object.assign({}, ev, { Date: '' })), '');
});

test('新規のカード(イベント): 7 項目と、青い枠、2 つのボタン', () => {
  const c = buildNewCard(ev, SITE);
  assert.equal(c.body[0].style, 'accent');
  assert.equal(c.body[0].items[0].text, '新しいイベントが登録されました');
  assert.equal(c.body[0].items[1].text, 'サイエンスショー');
  assert.equal(c.body[0].items[1].size, 'ExtraLarge');
  assert.deepEqual(facts(c), {
    'イベント名': 'サイエンスショー', '企画担当者': '山田', '場所': '○○小学校',
    'イベント日時': '2026年11月3日(火) 10:00 から 15:00', '実験内容・発表者': 'スライム作り(花子、太郎)',
    '許可願担当': '次郎', '報告書担当': '未定'
  });
  assert.deepEqual(c.actions.map(a => a.title), ['ポータルで詳細を見る', '出欠を入力']);
});

test('新規のカード: 書類が不要なら「不要」、空の項目は「未定」', () => {
  const c = buildNewCard(Object.assign({}, ev, { KyokaNotRequired: '1', HoukokuNotRequired: 'true', PlanLeader: '', PartsList: '[]' }), SITE);
  const f = facts(c);
  assert.equal(f['許可願担当'], '不要');
  assert.equal(f['報告書担当'], '不要');
  assert.equal(f['企画担当者'], '未定');
  assert.equal(f['実験内容・発表者'], '未定');
});

test('新規のカード(ミーティング): 4 項目と、赤い枠。回数つきの名前', () => {
  const m = Object.assign({}, ev, { Category: 'general', Title: '全体会', MeetingNumber: '4', Remarks: '議題1、議題2' });
  const c = buildNewCard(m, SITE);
  assert.equal(c.body[0].style, 'attention');
  assert.equal(c.body[0].items[0].text, '全体ミーティングが登録されました');
  assert.equal(c.body[0].items[1].text, '第4回 全体会');
  assert.deepEqual(facts(c), { 'ミーティング名': '第4回 全体会', '場所': '○○小学校', '日時': '2026年11月3日(火) 10:00 から 15:00', '議題': '議題1、議題2' });
  assert.equal(buildNewCard(Object.assign({}, m, { Category: 'admin' }), SITE).body[0].items[0].text, '幹部ミーティングが登録されました');
  assert.equal(facts(buildNewCard(Object.assign({}, m, { Remarks: '' }), SITE))['議題'], '未定');
});

test('ボタンのリンク: event を読ませ、id=ID~ を目印として添える', () => {
  const [a, b] = eventLinks(SITE, ev);
  assert.equal(a.url, 'https://scicomi.github.io/portal-site/events.html?event=ev_abc&id=ev_abc~');
  assert.equal(b.url, a.url);
  assert.equal(b.style, 'positive');
  assert.equal(eventLinks('https://example.test/p', ev)[0].url, 'https://example.test/p/events.html?event=ev_abc&id=ev_abc~');
  assert.ok(eventLinks('', ev)[0].url.startsWith('https://scicomi.github.io/portal-site/'));
});

test('差分: 変わった項目だけ。書き方だけの違いは無視する', () => {
  assert.equal(diffTeams(ev, Object.assign({}, ev, { Remarks: '変わらない対象外', VisitorCount: '9' })).length, 1);   // Remarks は対象
  assert.equal(diffTeams(ev, Object.assign({}, ev, { VisitorCount: '120', Reflections: 'x', UpdatedAt: 'y' })).length, 0);
  assert.equal(diffTeams(ev, Object.assign({}, ev, { Location: ' ○○小学校 ' })).length, 0);
  assert.equal(diffTeams(ev, Object.assign({}, ev, { PartsList: '[ { "name": "スライム作り", "presenters": ["花子", "太郎"] } ]' })).length, 0);
  const d = diffTeams(ev, Object.assign({}, ev, { Location: '△△公民館', AdminHoukoku: '三郎', Date: '2026-11-10' }));
  assert.deepEqual(d.map(x => x.label), ['場所', '日程', '報告書担当']);
  assert.deepEqual([d[0].from, d[0].to], ['○○小学校', '△△公民館']);
  assert.deepEqual([d[1].from, d[1].to], ['2026年11月3日(火)', '2026年11月10日(火)']);
  assert.deepEqual([d[2].from, d[2].to], ['', '三郎']);
});

test('変更のカード: 黄色い枠で、変更前 から 変更後。空は「未定」。長い値は切る', () => {
  const after = Object.assign({}, ev, { Location: '', AdminHoukoku: '三郎', Remarks: 'あ'.repeat(200) });
  const c = buildUpdateCard(after, diffTeams(ev, after), SITE);
  assert.equal(c.body[0].style, 'warning');
  assert.equal(c.body[0].items[0].text, 'イベントの内容が変更されました');
  assert.equal(c.body[0].items[1].text, 'サイエンスショー');
  const f = facts(c);
  assert.equal(f['場所'], '○○小学校 から 未定');
  assert.equal(f['報告書担当'], '未定 から 三郎');
  assert.ok(f['備考'].endsWith('…'));
  assert.ok(f['備考'].length < 140);
  assert.equal(c.actions.length, 2);
  const m = Object.assign({}, after, { Category: 'general' });
  assert.equal(buildUpdateCard(m, diffTeams(ev, m), SITE).body[0].items[0].text, 'ミーティングの内容が変更されました');
});

test('フローへ送る本文: eventKey と kind と attachments', () => {
  const card = buildNewCard(ev, SITE);
  const b = webhookBody('new', ev, card);
  assert.equal(b.type, 'message');
  assert.equal(b.eventKey, 'ev_abc');
  assert.equal(b.kind, 'new');
  assert.equal(b.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(b.attachments[0].content, card);
  // 日本語を含めても JSON として往復できる
  assert.equal(JSON.parse(JSON.stringify(b)).attachments[0].content.body[1].facts[0].value, 'サイエンスショー');
});

test('送信先の判定: https だけ。ローカルは明示したときだけ。未設定は無効', () => {
  assert.equal(teamsConfigured({}), false);
  assert.equal(teamsConfigured({ TEAMS_WEBHOOK_URL: '' }), false);
  assert.equal(teamsConfigured({ TEAMS_WEBHOOK_URL: 'https://example.test/x?sig=1' }), true);
  assert.equal(teamsConfigured({ TEAMS_WEBHOOK_URL: 'http://example.test/x' }), false);
  assert.equal(teamsConfigured({ TEAMS_WEBHOOK_URL: 'http://127.0.0.1:9999/x' }), false);
  assert.equal(teamsConfigured({ TEAMS_WEBHOOK_URL: 'http://127.0.0.1:9999/x', TEAMS_ALLOW_LOCAL_URL: 'true' }), true);
  assert.equal(teamsConfigured({ TEAMS_WEBHOOK_URL: 'http://evil.test/x', TEAMS_ALLOW_LOCAL_URL: 'true' }), false);
});

test('送信の失敗: 理由に送信先の URL を含めない', async () => {
  const env = { TEAMS_WEBHOOK_URL: 'https://secret-host.invalid/path?sig=SECRETVALUE' };
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 502 });
    await assert.rejects(postToTeams(env, {}), e => e.message === 'teams_http_502');
    globalThis.fetch = async () => { throw new TypeError('fetch failed: https://secret-host.invalid/path?sig=SECRETVALUE'); };
    await assert.rejects(postToTeams(env, {}), e => e.message === 'teams_network' && !/SECRET|secret-host/.test(e.message));
    let sent = null;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return { ok: true, status: 202 }; };
    await postToTeams(env, { a: 1 });
    assert.equal(sent.url, env.TEAMS_WEBHOOK_URL);
    assert.equal(sent.init.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(sent.init.body, '{"a":1}');
  } finally {
    globalThis.fetch = real;
  }
  await assert.rejects(postToTeams({}, {}), e => e.message === 'teams_disabled');
});
