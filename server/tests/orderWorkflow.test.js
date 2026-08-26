const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedTransitions, adminAllowedTransitions, canTransition } = require('../utils/orderWorkflow');
const { ACTIVE_STATUSES, sortProductionQueue } = require('../utils/scheduling');

test('cancelled orders are terminal and excluded from active production', () => {
  assert.deepEqual(allowedTransitions('cancelled'), ['cancelled']);
  assert.equal(canTransition('cancelled', 'sketching', {}), false);
  assert.equal(ACTIVE_STATUSES.includes('cancelled'), false);
});

test('cancelled orders sort outside the active production queue', () => {
  const rows = [
    { order_id: 'cancelled', status: 'cancelled', createdAt: '2026-01-01', is_urgent: false, productOption: {} },
    { order_id: 'active', status: 'in_queue', createdAt: '2026-01-02', is_urgent: false, productOption: {} },
  ];
  assert.deepEqual(sortProductionQueue(rows).map(row => row.order_id), ['active', 'cancelled']);
});

test('courier orders pass through shipped before completion', () => {
  const courierWithoutFrame = { frame_type: 'without_frame', pickup_option: 'courier' };
  const courierWithFrame = { frame_type: 'wooden_frame', pickup_option: 'courier' };
  assert.deepEqual(allowedTransitions('approved', courierWithoutFrame), ['approved', 'payment_finished']);
  assert.deepEqual(allowedTransitions('payment_finished', courierWithoutFrame), ['payment_finished', 'shipped']);
  assert.deepEqual(allowedTransitions('payment_finished', courierWithFrame), ['payment_finished', 'framed']);
  assert.deepEqual(allowedTransitions('framed', courierWithFrame), ['framed', 'shipped']);
  assert.deepEqual(allowedTransitions('shipped', courierWithFrame), ['done']);
});

test('proof lifecycle statuses are not offered as manual admin transitions', () => {
  assert.deepEqual(adminAllowedTransitions('sketching'), ['sketching']);
  assert.deepEqual(adminAllowedTransitions('waiting_for_feedback'), ['waiting_for_feedback']);
  assert.deepEqual(adminAllowedTransitions('revision_requested'), ['revision_requested']);
  assert.deepEqual(adminAllowedTransitions('approved', { frame_type: 'wooden_frame' }), ['approved']);
  assert.deepEqual(adminAllowedTransitions('payment_finished', { frame_type: 'wooden_frame' }), ['payment_finished', 'framed']);
});
