// 単体テスト: src/teams.js のカードの組み立てと、前回との差分。Worker を起動しなくても動く。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAfterCard, drainTeamsAfter, buildNewCard, buildUpdateCard, diffTeams, dateTimeText, eventLinks, webhookBody, postToTeams, foldShort, splitNames, loadStudentIds, changeKind } from '../src/teams.js';
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
const groupsOf = card => card.body.slice(1).filter(b => b.type === 'Container' && b.separator);   // 項目のかたまり(「続きを表示」のリンクは含めない)
const rowParts = card => groupsOf(card).flatMap(g => g.items);
const labelOf = c => (c.items[0].type === 'ColumnSet' ? c.items[0].columns[0].items[0].text : c.items[0].text);
const markOf = c => (c.items[0].type === 'ColumnSet' ? c.items[0].columns[1].items[0].text : '');
const valueOf = c => c.items.slice(1).filter(b => !b.selectAction && b.isVisible !== false)
  .map(b => (b.type === 'ColumnSet' ? b.columns.map(col => col.items[0].text).join('').replace(/ /g, ' ') : b.text)).join('\n');
const rows = card => Object.fromEntries(rowParts(card).map(c => [labelOf(c) + markOf(c), valueOf(c)]));
const groupSizes = card => groupsOf(card).map(g => g.items.length);

test('日時の書き方: 年つき・曜日つき・複数日・時間だけ片方', () => {
  assert.equal(dateTimeText(ev), '2026年11月3日(火) 10:00 から 15:00');
  assert.equal(dateTimeText(Object.assign({}, ev, { DateEnd: '2026-11-04', TimeStart: '', TimeEnd: '' })), '2026年11月3日(火) から 11月4日(水)');
  assert.equal(dateTimeText(Object.assign({}, ev, { Date: '2026-12-31', DateEnd: '2027-01-01', TimeStart: '', TimeEnd: '' })), '2026年12月31日(木) から 2027年1月1日(金)');
  assert.equal(dateTimeText(Object.assign({}, ev, { TimeEnd: '' })), '2026年11月3日(火) 10:00 から');
  assert.equal(dateTimeText(Object.assign({}, ev, { Date: '' })), '');
});

test('新規のカード(イベント): 見出しは種類と題名だけ。項目は区切り線でかたまりに分け、小見出しは付けない。書かれていない項目は出さない', () => {
  const c = buildNewCard(ev, SITE);
  assert.equal(c.body[0].style, 'attention');
  assert.deepEqual(c.body[0].items.map(i => i.text), ['新しいイベントが登録されました', 'サイエンスショー']);
  assert.equal(c.body[0].items[1].size, 'ExtraLarge');
  assert.deepEqual(rows(c), {
    '場所': '○○小学校', 'イベント日時': '2026年11月3日(火) 10:00 から 15:00', '企画担当者': '山田',
    '実験内容': '・スライム作り', '許可願担当': '次郎'
  });
  assert.deepEqual(groupSizes(c), [3, 1, 1]);
  groupsOf(c).forEach(g => {
    assert.equal(g.separator, true);
    assert.ok(g.items.every(i => i.type === 'Container'), '小見出しの文字(TextBlock)が混ざっていない');
  });
  // 項目名は小さい青い文字。発表者は出さない
  rowParts(c).forEach(r => { assert.equal(r.items[0].size, 'Small'); assert.equal(r.items[0].color, 'Attention'); });
  assert.ok(!JSON.stringify(c).includes('花子'));
  assert.deepEqual(c.actions.map(a => a.title), ['詳細を見る', '出欠を入力']);
});

test('新規のカード: 実験は 1 件ごとの箇条書き。書類が不要なら「不要」。空の項目は出さない', () => {
  const two = Object.assign({}, ev, { PartsList: '[{"name":"スライム作り","presenters":["花子"]},{"name":"竜巻","presenters":[]},{"name":"","presenters":["x"]}]' });
  assert.equal(rows(buildNewCard(two, SITE))['実験内容'], '・スライム作り\n・竜巻');
  const c = buildNewCard(Object.assign({}, ev, { KyokaNotRequired: '1', HoukokuNotRequired: 'true', PlanLeader: '', PartsList: '[]' }), SITE);
  const r = rows(c);
  assert.equal(r['許可願担当'], '不要');
  assert.equal(r['報告書担当'], '不要');
  assert.ok(!('企画担当者' in r) && !('実験内容' in r), '空の項目は出さない');
  assert.ok(Object.values(r).every(v => v !== 'ー'), '「ー」は出さない');
});

test('新規のカード(イベント): 書かれている項目をすべて、決めた順番で出す(対象・人数は出さない)', () => {
  const full = Object.assign({}, ev, {
    PlanName: '夏休み科学教室', Audience: '小学生 40名', GatherTime: '9:30', DismissTime: '16:00',
    TransportMethod: '学校の車', TransportDriver: '田中', TransportPassengers: '高橋', AdminHoukoku: '三郎', Remarks: '駐車場は裏門',
    Files: '[{"name":"資料.pdf","url":"https://example.com/a.pdf"}]'
  });
  const c = buildNewCard(full, SITE);
  assert.deepEqual(Object.keys(rows(c)), ['企画名', '場所', 'イベント日時', '集合・解散', '企画担当者', '実験内容', '運搬方法', '運転者', '同乗者', '許可願担当', '報告書担当', '備考', '関連ファイル']);
  assert.deepEqual(groupSizes(c), [5, 1, 3, 2, 2]);
  assert.ok(!JSON.stringify(c).includes('小学生 40名') && !JSON.stringify(c).includes('対象'));
  assert.deepEqual(diffTeams(ev, Object.assign({}, ev, { Audience: '30名' })), []);   // 対象・人数だけの変更は、通知の対象にしない
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
  assert.ok(!('議題' in rows(buildNewCard(Object.assign({}, m, { Remarks: '' }), SITE))), '空の議題は出さない');
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

test('変更のカード: 新規と同じ項目(書かれているもの)を並べ、変わった項目の横に(追記)(変更)(削除)。変更後の値だけ', () => {
  const after = Object.assign({}, ev, { Location: '', AdminHoukoku: '三郎', Remarks: '駐車場は裏門', Date: '2026-11-10' });
  const c = buildUpdateCard(after, ev, diffTeams(ev, after), SITE);
  assert.equal(c.body[0].style, 'warning');
  assert.deepEqual(c.body[0].items.map(i => i.text), ['イベントの内容が更新されました', 'サイエンスショー']);   // 追記と削除と変更が混ざる
  assert.deepEqual(rows(c), {
    '場所(削除)': 'ー', 'イベント日時(変更)': '2026年11月10日(火) 10:00 から 15:00', '企画担当者': '山田',
    '実験内容': '・スライム作り', '許可願担当': '次郎', '報告書担当(追記)': '三郎', '備考(追記)': '駐車場は裏門'
  });
  assert.ok(!JSON.stringify(c).includes('○○小学校'), '変更前の値は出さない');
  // 印: 項目名のすぐ横に、色なしの一番小さい薄い文字で、括弧つき。項目名は青
  const place = rowParts(c).find(x => labelOf(x) === '場所');
  const [lab, mk] = place.items[0].columns;
  assert.deepEqual([lab.items[0].color, lab.items[0].size], ['Attention', 'Small']);
  assert.equal(mk.spacing, 'None');
  assert.deepEqual([mk.items[0].text, mk.items[0].size, mk.items[0].isSubtle, mk.items[0].color], ['(削除)', 'Small', true, undefined]);
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
  // 空になった項目は、「ー」と「(削除)」で出す。変わっていない方には印を付けない
  const before2 = Object.assign({}, ev, { TransportDriver: '田中', TransportPassengers: '高橋' });
  const r2 = rows(buildUpdateCard(ev, before2, diffTeams(before2, ev), SITE));
  assert.deepEqual([r2['運転者(削除)'], r2['同乗者(削除)']], ['ー', 'ー']);
  const after3 = Object.assign({}, before2, { TransportDriver: '佐藤' });
  const r3 = rows(buildUpdateCard(after3, before2, diffTeams(before2, after3), SITE));
  assert.equal(r3['運転者(変更)'], '佐藤');
  assert.equal(r3['同乗者'], '高橋');
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
  const [shortB, fullB, open, close] = agenda.items.slice(1);
  assert.equal(shortB.text, '1行目\n2行目\n3行目…');
  assert.equal(fullB.text, long);
  assert.equal(fullB.isVisible, false);
  // 「続きを表示」「閉じる」は、ボタンではなく、小さい青い文字のリンク(押せる枠に入れた文字)
  assert.deepEqual([open.type, open.selectAction.type, open.items[0].text, open.items[0].size, open.items[0].color], ['Container', 'Action.ToggleVisibility', '続きを表示', 'Small', 'Accent']);
  assert.deepEqual([close.items[0].text, close.isVisible, close.selectAction.type], ['閉じる', false, 'Action.ToggleVisibility']);
  assert.deepEqual(open.selectAction.targetElements, [shortB.id, fullB.id, open.id, close.id]);
  assert.deepEqual(close.selectAction.targetElements, open.selectAction.targetElements);
  assert.ok(!JSON.stringify(c).includes('ActionSet'), 'ボタン(ActionSet)は使わない');
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

test('終了後のカード: 振り返りのお願い、日時、広報担当(チャンネルごと。決まっていなければ空欄)。目印は付けない', () => {
  const e = Object.assign({}, ev, { PrAssignments: '{"Twitter":"山田","HP":"佐藤"}' });
  const c = buildAfterCard(e, SITE, ['Twitter', 'Instagram', 'HP'], { '山田': '1AAJ1001' });
  assert.equal(c.body[0].style, 'accent');
  assert.deepEqual(c.body[0].items.map(i => i.text), ['振り返りを記入してください', 'サイエンスショー']);
  assert.deepEqual(rows(c), { 'イベント日時': '2026年11月3日(火) 10:00 から 15:00', 'Twitterの投稿担当': '山田 1AAJ1001', 'Instagramの投稿担当': '\u00a0', 'HPの投稿担当': '佐藤' });
  assert.deepEqual(c.actions.map(a => a.title), ['振り返りを記入する', '詳細を見る']);
  assert.equal(c.actions[0].url, SITE + 'events.html?event=ev_abc&tab=feedback');
  assert.ok(c.actions.every(a => !a.url.includes('~')), '変更の返信先を探す目印を付けない');
  assert.equal(c.msteams.width, 'Full');
  // 広報担当が壊れた値でも、カードは作れる
  assert.ok(buildAfterCard(Object.assign({}, ev, { PrAssignments: 'x' }), SITE, ['HP'], {}).body.length >= 2);
});

// D1 の代わり: 実行された文と、返す行を記録する
function fakeAfterDb(candidates, evRow) {
  const calls = [];
  return { calls, DB: { prepare: sql => ({ bind: (...args) => {
    calls.push({ sql, args });
    return {
      all: async () => ({ results: sql.includes('LEFT JOIN teams_after') ? candidates : [] }),
      first: async () => (sql.startsWith('SELECT * FROM events') ? evRow : null),
      run: async () => ({ meta: { changes: 1 } })
    };
  } }) } };
}

test('終了後の通知: 前日に終わったイベントを、翌朝 9 時から。1 回だけ。失敗は再試行', async () => {
  const real = globalThis.fetch;
  const sentBodies = [];
  globalThis.fetch = async (url, init) => { sentBodies.push(JSON.parse(init.body)); return { ok: true, status: 202 }; };
  try {
    const mk = (cands, row) => Object.assign(fakeAfterDb(cands, row), { TEAMS_WEBHOOK_URL: 'https://example.test/x?sig=1', SITE_URL: SITE });
    const jst = (iso) => new Date(iso + '+09:00');   // 日本時間の時刻
    // 前日の日付は、日本時間で決める(UTC の日付とずれる朝 9 時でも、前日は 11/3)
    const a = mk([{ ID: 'ev_abc', Attempts: null, Has: null }], Object.assign({}, ev));
    assert.equal(await drainTeamsAfter(a, 3, jst('2026-11-04T09:00:00')), 1);
    assert.equal(a.calls[0].args[0], '2026-11-03');
    assert.ok(a.calls[0].sql.includes("NOT IN ('general', 'admin')"), 'ミーティングは対象外');
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0].kind, 'after');
    assert.equal(sentBodies[0].eventKey, 'ev_abc');
    assert.ok(a.calls.some(c => c.sql.includes("INSERT INTO teams_after")), '送る前に行を作って確保する');
    assert.ok(a.calls.some(c => c.sql.includes("State = 'sent'")));
    // 朝 9 時より前は送らない。送信先が未設定でも送らない
    assert.equal(await drainTeamsAfter(mk([{ ID: 'ev_abc' }], ev), 3, jst('2026-11-04T08:59:00')), 0);
    assert.equal(await drainTeamsAfter({ DB: a.DB }, 3, jst('2026-11-04T10:00:00')), 0);
    assert.equal(sentBodies.length, 1);
    // 失敗: 状態は送信済みにならず、次の試行の時刻を後ろにずらす。3 回失敗したら諦める
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const f = mk([{ ID: 'ev_abc', Attempts: 0, Has: 'ev_abc' }], Object.assign({}, ev));
    assert.equal(await drainTeamsAfter(f, 3, jst('2026-11-04T09:00:00')), 0);
    assert.ok(f.calls.some(c => c.sql.startsWith('UPDATE teams_after SET DueAt = ?, Attempts = ?')));
    assert.ok(!f.calls.some(c => c.sql.includes("State = 'sent'")));
    const last = mk([{ ID: 'ev_abc', Attempts: 3, Has: 'ev_abc' }], Object.assign({}, ev));
    await drainTeamsAfter(last, 3, jst('2026-11-04T09:00:00'));
    assert.ok(last.calls.some(c => c.sql.includes("State = 'failed'")));
  } finally {
    globalThis.fetch = real;
  }
});

test('イベントのカードの折りたたみ: 実験内容までを見せ、後ろは「続きを表示」で開く。変更のカードでは、変わった項目は後ろでも見せる', () => {
  const full = Object.assign({}, ev, {
    PlanName: '夏休み科学教室', TransportMethod: '学校の車', TransportDriver: '田中', AdminHoukoku: '三郎', Remarks: '駐車場は裏門',
    Files: '[{"name":"資料.pdf","url":"https://example.com/a.pdf"}]'
  });
  const c = buildNewCard(full, SITE);
  const hidden = x => x.isVisible === false;
  const state = card => groupsOf(card).map(g => hidden(g) ? 'かたまりごと隠す' : g.items.map(i => (hidden(i) ? '隠' : '見') + labelOf(i)).join(' '));
  assert.deepEqual(state(c), ['見企画名 見場所 見イベント日時 見企画担当者', '見実験内容', 'かたまりごと隠す', 'かたまりごと隠す', 'かたまりごと隠す']);
  const [open, close] = c.body.slice(-2);
  assert.deepEqual([open.items[0].text, open.isVisible, close.items[0].text, close.isVisible], ['続きを表示', true, '閉じる', false]);
  const hiddenIds = groupsOf(c).filter(hidden).map(g => g.id);
  assert.equal(hiddenIds.length, 3);
  assert.deepEqual(open.selectAction.targetElements, hiddenIds.concat([open.id, close.id]));
  assert.ok(c.body.indexOf(open) > c.body.indexOf(groupsOf(c)[4]), 'リンクは、項目のあとに置く');
  // 隠すものがなければ、リンクも出さない
  assert.ok(!JSON.stringify(buildNewCard(Object.assign({}, ev, { AdminKyoka: '' }), SITE)).includes('"id":"hmo"'));
  // 変更のカード: 後ろの項目のうち、変わったもの(報告書担当)は見せ、変わっていないものは隠す。かたまりの中の一部だけ隠れるときは、その行だけを隠す
  const after = Object.assign({}, full, { AdminHoukoku: '四郎' });
  const u = buildUpdateCard(after, full, diffTeams(full, after), SITE);
  assert.deepEqual(state(u), ['見企画名 見場所 見イベント日時 見企画担当者', '見実験内容', 'かたまりごと隠す', '隠許可願担当 見報告書担当', 'かたまりごと隠す']);
  assert.equal(rows(u)['報告書担当(変更)'], '四郎');
  // ミーティングは、折りたたまない(長い議題だけを折りたたむ)
  const m = buildNewCard(Object.assign({}, ev, { Category: 'general', Remarks: '議題' }), SITE);
  assert.ok(!JSON.stringify(m).includes('hid0'));
});
