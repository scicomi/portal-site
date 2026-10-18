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
