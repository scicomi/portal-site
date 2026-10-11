// 単体テスト: src/eventNotify.js の通知の文面と、変わった項目の判定。Worker を起動しなくても動く。

import test from 'node:test';
import assert from 'node:assert/strict';
import { eventPushPayload, changedFields, formatDateJP, formatDateRange, eventDisplayName } from '../src/eventNotify.js';

const base = {
  ID: 'ev_1', Title: 'サイエンスショー', Category: 'normal', Date: '2026-11-03', DateEnd: '',
  Location: '○○小学校', TimeStart: '10:00', TimeEnd: '15:00', Remarks: 'メモ', PlanLeader: '山田',
  PartsList: '[{"name":"スライム","presenters":["山田"]}]'
};
const edit = (patch) => {
  const after = Object.assign({}, base, patch);
  return eventPushPayload(after, { before: base, fields: changedFields(base, after) });
};

test('日付の書き方: 曜日付き・複数日', () => {
  assert.equal(formatDateJP('2026-11-03'), '11/3(火)');
  assert.equal(formatDateJP('2026-01-01'), '1/1(木)');
  assert.equal(formatDateJP(''), '');
  assert.equal(formatDateRange({ Date: '2026-11-03', DateEnd: '2026-11-04' }), '11/3(火)〜11/4(水)');
  assert.equal(formatDateRange({ Date: '2026-11-03', DateEnd: '2026-11-03' }), '11/3(火)');
});

test('追加: イベントとミーティング。時間と場所は載せない', () => {
  assert.deepEqual(eventPushPayload(base), {
    title: '新しいイベント', body: 'サイエンスショー / 11/3(火) 出欠を記入して下さい', url: 'events.html?event=ev_1', tag: 'ev_1'
  });
  const mtg = Object.assign({}, base, { Category: 'general', Title: '全体ミーティング', MeetingNumber: '5' });
  assert.equal(eventPushPayload(mtg).title, '新しいミーティング');
  assert.equal(eventPushPayload(mtg).body, '第5回 全体ミーティング / 11/3(火) 出欠を記入して下さい');
  assert.equal(eventDisplayName(Object.assign({}, base, { MeetingNumber: '5' })), 'サイエンスショー');   // イベントには回数を付けない
  assert.equal(eventPushPayload(Object.assign({}, base, { Category: 'other' })).title, '新しいイベント');
});

test('編集: 日程・時間・場所が 1 つだけ変わったときは、変更前後を出す', () => {
  assert.deepEqual(edit({ Date: '2026-11-10' }), {
    title: '日程が変わりました', body: 'サイエンスショー / 11/3(火) → 11/10(火)', url: 'events.html?event=ev_1', tag: 'ev_1'
  });
  assert.equal(edit({ Location: '△△公民館' }).body, 'サイエンスショー / ○○小学校 → △△公民館');
  assert.equal(edit({ Location: '' }).body, 'サイエンスショー / ○○小学校 → 未定');
  assert.equal(edit({ TimeStart: '13:00' }).title, '時間が変わりました');
  assert.equal(edit({ TimeStart: '13:00' }).body, 'サイエンスショー / 10:00〜15:00 → 13:00〜15:00');
  assert.equal(edit({ PlanName: '光の実験' }).title, '企画名が変わりました');
  // 名前が変わったときは、新しい名前で出す
  assert.equal(edit({ Title: '科学まつり' }).body, '科学まつり / サイエンスショー → 科学まつり');
});

test('編集: 氏名・本文を含む項目は、項目名だけ(中身は載せない)', () => {
  assert.deepEqual(edit({ Remarks: '駐車場は裏門' }), {
    title: '内容が変わりました', body: 'サイエンスショー / 備考', url: 'events.html?event=ev_1', tag: 'ev_1'
  });
  assert.equal(edit({ PlanLeader: '佐藤' }).body, 'サイエンスショー / 企画担当者');
  assert.equal(edit({ TransportPassengers: '佐藤' }).body, 'サイエンスショー / 運転者・同乗者');
  assert.ok(!edit({ PlanLeader: '佐藤' }).body.includes('佐藤'));
  // ミーティングの備考は「議題・資料」
  const mtg = Object.assign({}, base, { Category: 'admin' });
  assert.equal(eventPushPayload(Object.assign({}, mtg, { Remarks: 'x' }), { before: mtg, fields: changedFields(mtg, Object.assign({}, mtg, { Remarks: 'x' })) }).body, 'サイエンスショー / 議題・資料');
});

test('編集: 複数の項目は並べる。長い値は切る', () => {
  const p = edit({ Date: '2026-11-10', Location: '△△公民館' });
  assert.equal(p.title, '内容が変わりました');
  assert.equal(p.body, 'サイエンスショー / 場所・日程');
  assert.equal(edit({ Location: 'あ'.repeat(30) }).body, 'サイエンスショー / ○○小学校 → ' + 'あ'.repeat(20) + '…');
});

test('通知しない変更: 対象外の列、JSON の書き方だけの違い', () => {
  assert.equal(changedFields(base, Object.assign({}, base, { VisitorCount: '120', Reflections: 'よかった', Files: '[1]', UpdatedAt: 'x' })).length, 0);
  assert.equal(changedFields(base, Object.assign({}, base, { PartsList: '[ { "name": "スライム", "presenters": ["山田"] } ]' })).length, 0);
  assert.equal(changedFields(base, Object.assign({}, base, { PartsList: '[{"name":"スライム","presenters":["佐藤"]}]' }))[0].key, 'parts');
  assert.equal(changedFields(base, Object.assign({}, base, { Location: ' ○○小学校 ' })).length, 0);   // 前後の空白だけ
});
