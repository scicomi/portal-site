// 単体テスト: src/teams.js のカードの組み立てと、前回との差分。Worker を起動しなくても動く。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNewCard, buildUpdateCard, diffTeams, dateTimeText, eventLinks, webhookBody, postToTeams, foldShort, splitNames, loadStudentIds, changeKind } from '../src/teams.js';
import { teamsConfigured } from '../src/config.js';

const SITE = 'https://scicomi.github.io/portal-site/';
const ev = {
  ID: 'ev_abc', Title: 'サイエンスショー', Category: 'normal', Date: '2026-11-03', DateEnd: '',
  Location: '○○小学校', TimeStart: '10:00', TimeEnd: '15:00', Remarks: '', PlanLeader: '山田',
  PartsList: '[{"name":"スライム作り","presenters":["花子","太郎"]}]',
  AdminKyoka: '次郎', KyokaNotRequired: '', AdminHoukoku: '', HoukokuNotRequired: '',
  TransportDriver: '', TransportPassengers: ''
};

// カードの項目を { '項目名(印)': '値' } にする。値は、名前と学番の間を空白でつなぐ。折りたたまれた文は先頭だけ
const rowParts = card => card.body.slice(1).filter(b => b.type === 'Container').flatMap(g => g.items);
const labelOf = c => (c.items[0].type === 'ColumnSet' ? c.items[0].columns[0].items[0].text : c.items[0].text);
const markOf = c => (c.items[0].type === 'ColumnSet' ? c.items[0].columns[1].items[0].text : '');
const valueOf = c => c.items.slice(1).filter(b => b.type !== 'ActionSet' && b.isVisible !== false)
  .map(b => (b.type === 'ColumnSet' ? b.columns.map(col => col.items[0].text).join('').replace(/ /g, ' ') : b.text)).join('\n');
const rows = card => Object.fromEntries(rowParts(card).map(c => [labelOf(c) + markOf(c), valueOf(c)]));
const groupSizes = card => card.body.slice(1).filter(b => b.type === 'Container').map(g => g.items.length);

test('日時の書き方: 年つき・曜日つき・複数日・時間だけ片方', () => {
  assert.equal(dateTimeText(ev), '2026年11月3日(火) 10:00 から 15:00');
  assert.equal(dateTimeText(Object.assign({}, ev, { DateEnd: '2026-11-04', TimeStart: '', TimeEnd: '' })), '2026年11月3日(火) から 11月4日(水)');
  assert.equal(dateTimeText(Object.assign({}, ev, { Date: '2026-12-31', DateEnd: '2027-01-01', TimeStart: '', TimeEnd: '' })), '2026年12月31日(木) から 2027年1月1日(金)');
  assert.equal(dateTimeText(Object.assign({}, ev, { TimeEnd: '' })), '2026年11月3日(火) 10:00 から');
  assert.equal(dateTimeText(Object.assign({}, ev, { Date: '' })), '');
});

test('新規のカード(イベント): 見出しは種類と題名だけ。項目は区切り線で 3 つのかたまりに分け、小見出しは付けない', () => {
  const c = buildNewCard(ev, SITE);
  assert.equal(c.body[0].style, 'accent');
  assert.deepEqual(c.body[0].items.map(i => i.text), ['新しいイベントが登録されました', 'サイエンスショー']);
  assert.equal(c.body[0].items[1].size, 'ExtraLarge');
  assert.deepEqual(rows(c), {
    'イベント日時': '2026年11月3日(火) 10:00 から 15:00', '集合・解散': 'ー', '場所': '○○小学校', '企画担当者': '山田',
    '実験内容': '・スライム作り', '関連ファイル': 'ー', '許可願担当': '次郎', '報告書担当': 'ー'
  });
  assert.deepEqual(Object.keys(rows(c)), ['イベント日時', '集合・解散', '場所', '企画担当者', '実験内容', '関連ファイル', '許可願担当', '報告書担当']);
  assert.deepEqual(groupSizes(c), [4, 2, 2]);
  c.body.slice(1).filter(b => b.type === 'Container').forEach(g => {
    assert.equal(g.separator, true);
    assert.ok(g.items.every(i => i.type === 'Container'), '小見出しの文字(TextBlock)が混ざっていない');
  });
  // 項目名は小さい青い文字。発表者は出さない
  rowParts(c).forEach(r => { assert.equal(r.items[0].size, 'Small'); assert.equal(r.items[0].color, 'Accent'); });
  assert.ok(!JSON.stringify(c).includes('花子'));
  assert.deepEqual(c.actions.map(a => a.title), ['ポータルで詳細を見る', '出欠を入力']);
});

test('新規のカード: 実験は 1 件ごとの箇条書き。書類が不要なら「不要」、空の項目は「ー」', () => {
  const two = Object.assign({}, ev, { PartsList: '[{"name":"スライム作り","presenters":["花子"]},{"name":"竜巻","presenters":[]},{"name":"","presenters":["x"]}]' });
  assert.equal(rows(buildNewCard(two, SITE))['実験内容'], '・スライム作り\n・竜巻');
  const c = buildNewCard(Object.assign({}, ev, { KyokaNotRequired: '1', HoukokuNotRequired: 'true', PlanLeader: '', PartsList: '[]' }), SITE);
  const r = rows(c);
  assert.equal(r['許可願担当'], '不要');
  assert.equal(r['報告書担当'], '不要');
  assert.equal(r['企画担当者'], 'ー');
  assert.equal(r['実験内容'], 'ー');
});

test('名前の横の学番: 一番小さい薄い文字を、間隔なしで添える。複数人は 1 人 1 行。学番が分からない人は名前だけ', () => {
  const e = Object.assign({}, ev, { PlanLeader: '山田', AdminKyoka: '佐藤,鈴木、高橋' });
  const c = buildNewCard(e, SITE, { '山田': '1AAJ1001', '佐藤': '1AAJ1002' });
  const r = rows(c);
  assert.equal(r['企画担当者'], '山田 1AAJ1001');
  assert.equal(r['許可願担当'], '佐藤 1AAJ1002\n鈴木\n高橋');
  const leader = rowParts(c).find(x => labelOf(x) === '企画担当者').items[1];
  assert.equal(leader.type, 'ColumnSet');
  const [nameCol, idCol] = leader.columns;
  assert.equal(nameCol.items[0].size, 'Medium');
  assert.equal(idCol.spacing, 'None');                       // 列の間隔は空けず、半角の空き(NBSP 1 つ)だけを置く
  assert.equal(idCol.items[0].text, ' 1AAJ1001');
  assert.deepEqual([idCol.items[0].size, idCol.items[0].isSubtle], ['Small', true]);
  assert.equal(idCol.items[0].color, undefined);             // 色なし
  assert.deepEqual(splitNames('A,B、C，D, '), ['A', 'B', 'C', 'D']);
});

test('学番の取得: 名前が同じでも学番が 1 つに決まるときだけ使う。取れなくても例外にしない', async () => {
  const calls = [];
  const db = rowsOut => ({ prepare: sql => ({ bind: (...p) => ({ all: async () => { calls.push([sql, p]); return { results: rowsOut }; } }) }) });
  const members = [
    { Name: '山田', StudentID: '1AAJ1001' }, { Name: '山田', StudentID: '1AAJ1001' },   // 年度ごとの重複: 学番は同じ
    { Name: '佐藤', StudentID: '1AAJ1002' }, { Name: '佐藤', StudentID: '1AAJ9999' },   // 同姓同名: 決められない
    { Name: '鈴木', StudentID: '' }                                                     // 学番が空
  ];
  const out = await loadStudentIds({ DB: db(members) }, Object.assign({}, ev, { PlanLeader: '山田', AdminKyoka: '佐藤,鈴木' }));
  assert.deepEqual(out, { '山田': '1AAJ1001' });
  assert.match(calls[0][0], /FROM members WHERE Name IN \(\?,\?,\?\)/);
  assert.deepEqual(calls[0][1].sort(), ['佐藤', '山田', '鈴木']);
  assert.deepEqual(await loadStudentIds({ DB: db([]) }, Object.assign({}, ev, { PlanLeader: '', AdminKyoka: '' })), {});
  const failing = { DB: { prepare: () => { throw new Error('boom'); } } };
  assert.deepEqual(await loadStudentIds(failing, ev), {});
});

test('新規のカード(ミーティング): 赤い枠。日時・場所・議題。回数つきの名前', () => {
  const m = Object.assign({}, ev, { Category: 'general', Title: '全体会', MeetingNumber: '4', Remarks: '議題1、議題2' });
  const c = buildNewCard(m, SITE);
  assert.equal(c.body[0].style, 'attention');
  assert.deepEqual(c.body[0].items.map(i => i.text), ['全体ミーティングが登録されました', '第4回 全体会']);
  assert.deepEqual(rows(c), { '日時': '2026年11月3日(火) 10:00 から 15:00', '場所': '○○小学校', '議題': '議題1、議題2' });
  assert.deepEqual(groupSizes(c), [2, 1]);
  assert.equal(buildNewCard(Object.assign({}, m, { Category: 'admin' }), SITE).body[0].items[0].text, '幹部ミーティングが登録されました');
  assert.equal(rows(buildNewCard(Object.assign({}, m, { Remarks: '' }), SITE))['議題'], 'ー');
});

test('ボタンのリンク: event を読ませ、id=ID~ を目印として添える', () => {
  const [a, b] = eventLinks(SITE, ev);
  assert.equal(a.url, 'https://scicomi.github.io/portal-site/events.html?event=ev_abc&id=ev_abc~');
  assert.equal(b.url, a.url);
  assert.equal(b.style, 'positive');
  assert.equal(eventLinks('https://example.test/p', ev)[0].url, 'https://example.test/p/events.html?event=ev_abc&id=ev_abc~');
  assert.ok(eventLinks('', ev)[0].url.startsWith('https://scicomi.github.io/portal-site/'));
});

test('差分: 変わった項目だけ。書き方だけの違い・発表者だけの違いは無視する', () => {
  assert.equal(diffTeams(ev, Object.assign({}, ev, { Remarks: '対象の列' })).length, 1);
  assert.equal(diffTeams(ev, Object.assign({}, ev, { VisitorCount: '120', Reflections: 'x', UpdatedAt: 'y' })).length, 0);
  assert.equal(diffTeams(ev, Object.assign({}, ev, { Location: ' ○○小学校 ' })).length, 0);
  assert.equal(diffTeams(ev, Object.assign({}, ev, { PartsList: '[ { "name": "スライム作り", "presenters": ["花子", "太郎"] } ]' })).length, 0);
  assert.equal(diffTeams(ev, Object.assign({}, ev, { PartsList: '[{"name":"スライム作り","presenters":["佐藤"]}]' })).length, 0);   // 発表者だけ(カードに出さない)
  assert.deepEqual(diffTeams(ev, Object.assign({}, ev, { PartsList: '[{"name":"竜巻","presenters":[]}]' })).map(x => x.label), ['実験内容']);
  const d = diffTeams(ev, Object.assign({}, ev, { Location: '△△公民館', AdminHoukoku: '三郎', Date: '2026-11-10' }));
  assert.deepEqual(d.map(x => x.label), ['場所', '日程', '報告書担当']);
  assert.deepEqual([d[0].from, d[0].to], ['○○小学校', '△△公民館']);
  assert.deepEqual([d[2].from, d[2].to], ['', '三郎']);
});

test('追記・変更・削除の区別', () => {
  assert.equal(changeKind('', '三郎'), '追記');
  assert.equal(changeKind('○○', ''), '削除');
  assert.equal(changeKind('○○', '△△'), '変更');
  assert.equal(changeKind('', ''), '変更');
});

test('集合・解散と関連ファイル: 集合・解散は片方だけでもよい。ファイルはリンクで、リンクにできないものと書類(依頼書など)は出さない', () => {
  const files = JSON.stringify([
    { name: '資料[1].pdf', url: 'https://example.com/files/a b(1).pdf', size: 10, uploadedAt: 'x' },
    { name: '壊れた', url: '' },
    { name: '危険', url: 'javascript:alert(1)' }
  ]);
  const e = Object.assign({}, ev, { GatherTime: '9:30', DismissTime: '', Files: files, RequestDoc: '[{"name":"依頼書.pdf","url":"https://example.com/files/req.pdf"}]' });
  const r = rows(buildNewCard(e, SITE));
  assert.equal(r['集合・解散'], '集合 9:30');
  assert.equal(r['関連ファイル'], '・[資料1.pdf](https://example.com/files/a%20b%281%29.pdf)');
  assert.ok(!JSON.stringify(buildNewCard(e, SITE)).includes('req.pdf'));
  assert.equal(rows(buildNewCard(Object.assign({}, e, { DismissTime: '12:30' }), SITE))['集合・解散'], '集合 9:30 / 解散 12:30');
  // 変更: ファイルの追加は「追記」。アップロードの日時が変わっただけでは変更にしない
  const before = Object.assign({}, e, { Files: '[]' });
  const c = buildUpdateCard(e, before, diffTeams(before, e), SITE);
  assert.equal(rows(c)['関連ファイル(追記)'], '・[資料1.pdf](https://example.com/files/a%20b%281%29.pdf)');
  const same = Object.assign({}, e, { Files: files.replace('"x"', '"y"') });
  assert.deepEqual(diffTeams(e, same), []);
  // ミーティングには出さない
  assert.ok(!('集合・解散' in rows(buildNewCard(Object.assign({}, e, { Category: 'general' }), SITE))));
});

test('変更のカード: 新規と同じ項目を全部並べ、変わった項目の横に(追記)(変更)(削除)。変更後の値だけ', () => {
  const after = Object.assign({}, ev, { Location: '', AdminHoukoku: '三郎', Remarks: '駐車場は裏門', Date: '2026-11-10' });
  const c = buildUpdateCard(after, ev, diffTeams(ev, after), SITE);
  assert.equal(c.body[0].style, 'warning');
  assert.deepEqual(c.body[0].items.map(i => i.text), ['イベントの内容が更新されました', 'サイエンスショー']);   // 追記と削除と変更が混ざる
  assert.deepEqual(rows(c), {
    'イベント日時(変更)': '2026年11月10日(火) 10:00 から 15:00', '集合・解散': 'ー', '場所(削除)': 'ー', '企画担当者': '山田',
    '実験内容': '・スライム作り', '関連ファイル': 'ー', '許可願担当': '次郎', '報告書担当(追記)': '三郎', '備考(追記)': '駐車場は裏門'
  });
  assert.ok(!JSON.stringify(c).includes('○○小学校'), '変更前の値は出さない');
  // 印: 項目名のすぐ横に、色なしの一番小さい薄い文字で、括弧つき。項目名は青
  const place = rowParts(c).find(x => labelOf(x) === '場所');
  const [lab, mk] = place.items[0].columns;
  assert.deepEqual([lab.items[0].color, lab.items[0].size], ['Accent', 'Small']);
  assert.equal(mk.spacing, 'None');
  assert.deepEqual([mk.items[0].text, mk.items[0].size, mk.items[0].isSubtle, mk.items[0].color], ['(削除)', 'Small', true, undefined]);
  // 「そのほか」の項目(備考)は、最後のかたまり
  assert.equal(labelOf(rowParts(c).pop()), '備考');
  assert.equal(c.actions.length, 2);
});

test('変更のカード: 見出しの動詞は、すべて追記なら「追記」、すべて変更なら「変更」、混ざれば「更新」。ミーティングも', () => {
  const lead = (patch, base = ev) => { const a = Object.assign({}, base, patch); return buildUpdateCard(a, base, diffTeams(base, a), SITE).body[0].items[0].text; };
  assert.equal(lead({ AdminHoukoku: '三郎' }), 'イベントの内容が追記されました');
  assert.equal(lead({ Location: '△△公民館' }), 'イベントの内容が変更されました');
  assert.equal(lead({ Location: '△△公民館', AdminHoukoku: '三郎' }), 'イベントの内容が更新されました');
  const mb = Object.assign({}, ev, { Category: 'general', Title: '全体会', MeetingNumber: '4', Remarks: '' });
  assert.equal(lead({ Remarks: '議題1' }, mb), 'ミーティングの内容が追記されました');
  const ma = Object.assign({}, mb, { Remarks: '議題1' });
  assert.deepEqual(rows(buildUpdateCard(ma, mb, diffTeams(mb, ma), SITE)), { '日時': '2026年11月3日(火) 10:00 から 15:00', '場所': '○○小学校', '議題(追記)': '議題1' });
});

test('変更のカード: 題名の変更・運転者と同乗者・実験の追加は、それぞれの項目に印が付く', () => {
  const after = Object.assign({}, ev, {
    Title: '科学まつり', TransportDriver: '田中', TransportPassengers: '高橋,伊藤',
    PartsList: '[{"name":"スライム作り","presenters":[]},{"name":"空気砲","presenters":[]}]'
  });
  const c = buildUpdateCard(after, ev, diffTeams(ev, after), SITE, { '田中': '1AAJ1005' });
  assert.equal(c.body[0].items[1].text, '科学まつり');
  const r = rows(c);
  assert.equal(r['実験内容(変更)'], '・スライム作り\n・空気砲');
  assert.equal(r['イベント名(変更)'], '科学まつり');
  assert.equal(r['運転者(追記)'], '田中 1AAJ1005');
  assert.equal(r['同乗者(追記)'], '高橋\n伊藤');
  // 両方とも空になったら、1 行にして「削除」
  const before2 = Object.assign({}, ev, { TransportDriver: '田中', TransportPassengers: '高橋' });
  const r2 = rows(buildUpdateCard(ev, before2, diffTeams(before2, ev), SITE));
  assert.equal(r2['運転者・同乗者(削除)'], 'ー');
});

test('長い文章の折りたたみ: 3 行を超える、または 90 文字を超えると、先頭だけを出して「続きを表示」で全文を開く', () => {
  assert.equal(foldShort('短い文'), '');
  assert.equal(foldShort('1行目\n2行目\n3行目'), '');
  assert.equal(foldShort('1行目\n2行目\n3行目\n4行目'), '1行目\n2行目\n3行目…');
  assert.equal(foldShort('あ'.repeat(90)), '');
  assert.equal(foldShort('あ'.repeat(91)), 'あ'.repeat(90) + '…');
  const long = '1行目\n2行目\n3行目\n4行目\n5行目';
  const m = Object.assign({}, ev, { Category: 'general', Remarks: long, Location: '' });
  const c = buildNewCard(m, SITE);
  const agenda = rowParts(c).find(x => labelOf(x) === '議題');
  const [shortB, fullB, set] = agenda.items.slice(1);
  assert.equal(shortB.text, '1行目\n2行目\n3行目…');
  assert.equal(fullB.text, long);
  assert.equal(fullB.isVisible, false);
  assert.equal(set.type, 'ActionSet');
  const [open, close] = set.actions;
  assert.deepEqual([open.type, open.title, close.title, close.isVisible], ['Action.ToggleVisibility', '続きを表示', '閉じる', false]);
  assert.deepEqual(open.targetElements, [shortB.id, fullB.id, open.id, close.id]);
  assert.deepEqual(close.targetElements, open.targetElements);
  // 折りたたみが複数あっても、id は重ならない
  const after = Object.assign({}, ev, { Remarks: long, PlanLeader: 'あ'.repeat(5), Location: '1\n2\n3\n4' });
  const ids = JSON.stringify(buildUpdateCard(after, ev, diffTeams(ev, after), SITE)).match(/"id":"(f[sfoc]\d+)"/g);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 8);
});

test('カードの幅: Teams で横幅いっぱいにする(msteams.width)', () => {
  assert.deepEqual(buildNewCard(ev, SITE).msteams, { width: 'Full' });
  const after = Object.assign({}, ev, { Location: 'x' });
  assert.deepEqual(buildUpdateCard(after, ev, diffTeams(ev, after), SITE).msteams, { width: 'Full' });
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
  assert.equal(JSON.parse(JSON.stringify(b)).attachments[0].content.body[0].items[1].text, 'サイエンスショー');
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
