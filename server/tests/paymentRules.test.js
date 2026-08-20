const test = require('node:test');
const assert = require('node:assert/strict');
const { remainingBalance, balanceCheckoutDecision, paymentCallbackDecision, paymentSummary } = require('../utils/paymentRules');

const deposit = (status = 'completed', amount = 2000) => ({ paymentType: 'advance', status, amount });
const balance = (status = 'pending', amount = 2000) => ({ paymentType: 'full', status, amount });

test('remaining balance uses completed transactions only', () => {
  assert.equal(remainingBalance(4000, [deposit(), balance('pending')]), 2000);
});

test('balance requires proof approval', () => {
  assert.throws(() => balanceCheckoutDecision({ orderStatus: 'sketching', total: 4000, payments: [deposit()] }), { code: 'PROOF_NOT_APPROVED' });
});

test('balance requires a completed deposit', () => {
  assert.throws(() => balanceCheckoutDecision({ orderStatus: 'approved', total: 4000, payments: [deposit('pending')] }), { code: 'DEPOSIT_NOT_COMPLETED' });
});

test('approved order receives the exact remaining half', () => {
  assert.deepEqual(balanceCheckoutDecision({ orderStatus: 'approved', total: 4000, payments: [deposit()] }), { balance: 2000, reusablePayment: null });
});

test('duplicate pending balance checkout is rejected', () => {
  assert.throws(() => balanceCheckoutDecision({ orderStatus: 'approved', total: 4000, payments: [deposit(), balance()] }), { code: 'BALANCE_CHECKOUT_ACTIVE' });
});

test('failed balance checkout is reused instead of creating a third row', () => {
  const failed = balance('failed');
  assert.equal(balanceCheckoutDecision({ orderStatus: 'approved', total: 4000, payments: [deposit(), failed] }).reusablePayment, failed);
});

test('completed balance prevents further checkout', () => {
  assert.throws(() => balanceCheckoutDecision({ orderStatus: 'approved', total: 4000, payments: [deposit(), balance('completed')] }), { code: 'ALREADY_PAID' });
});

test('duplicate completed callback is idempotent', () => {
  assert.equal(paymentCallbackDecision({ currentStatus: 'completed', nextStatus: 'completed', expectedAmount: 2000, receivedAmount: '2000.00', expectedCurrency: 'LKR', receivedCurrency: 'lkr' }).idempotent, true);
});

test('callback with invalid amount or currency is rejected', () => {
  assert.throws(() => paymentCallbackDecision({ currentStatus: 'pending', nextStatus: 'completed', expectedAmount: 2000, receivedAmount: 2500, expectedCurrency: 'LKR', receivedCurrency: 'LKR' }), { code: 'PAYMENT_DETAILS_MISMATCH' });
});

test('payment summary totals deposits that do not have a completed balance', () => {
  assert.deepEqual(paymentSummary([
    { order_id: 'half-paid', ...deposit('completed', 1500) },
    { order_id: 'paid', ...deposit('completed', 2000) },
    { order_id: 'paid', ...balance('completed', 2000) },
    { order_id: 'pending-deposit', ...deposit('pending', 500) },
  ]), { balancePending: 1500, halfPaidOrderCount: 1 });
});
