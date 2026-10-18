// ストレージの上限(プランの判定)の単体テスト。サーバーは要らない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlan, PLAN_LIMITS_MB } from '../src/storage.js';

test('detectPlan: Workers Paid の契約があれば paid、なければ free', () => {
  assert.equal(detectPlan([{ rate_plan: { id: 'workers_paid' }, state: 'Paid' }]), 'paid');
  assert.equal(detectPlan([{ rate_plan: { id: 'free' }, state: 'Paid' }, { rate_plan: { id: 'workers_paid' }, state: 'Paid' }]), 'paid');
  assert.equal(detectPlan([{ rate_plan: { id: 'workers_paid' }, state: 'Cancelled' }]), 'free');
  assert.equal(detectPlan([{ rate_plan: { id: 'free' } }]), 'free');
  assert.equal(detectPlan([]), 'free');
  assert.equal(detectPlan(null), 'free');
});

test('PLAN_LIMITS_MB: paid の D1 は free より大きい', () => {
  assert.ok(PLAN_LIMITS_MB.paid.d1 > PLAN_LIMITS_MB.free.d1);
});

import { summarizeActivity, activityRange, ACTIVITY_LIMITS } from '../src/usage.js';

test('summarizeActivity: 複数の行を足し、足りない値は 0', () => {
  assert.deepEqual(summarizeActivity({ workers: [{ sum: { requests: 10 } }, { sum: { requests: 5 } }], d1: [{ sum: { rowsRead: 7, rowsWritten: 2 } }] }),
    { requests: 15, rowsRead: 7, rowsWritten: 2 });
  assert.deepEqual(summarizeActivity({}), { requests: 0, rowsRead: 0, rowsWritten: 0 });
  assert.deepEqual(summarizeActivity(null), { requests: 0, rowsRead: 0, rowsWritten: 0 });
});

test('activityRange: day は UTC の 0 時から、month は UTC の 1 日から', () => {
  const now = new Date('2026-10-18T13:15:00Z');
  assert.equal(activityRange('day', now).since, '2026-10-18T00:00:00.000Z');
  assert.equal(activityRange('month', now).since, '2026-10-01T00:00:00.000Z');
  assert.equal(activityRange('month', now).dUntil, '2026-10-18');
  assert.equal(ACTIVITY_LIMITS.free.period, 'day');
});
