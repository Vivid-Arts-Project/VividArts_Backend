const test = require('node:test');
const assert = require('node:assert/strict');
const { remainingBalance, hasUsableCheckout, balanceCheckoutDecision, paymentCallbackDecision, paymentSummary } = require('../utils/paymentRules');
const { resolveNotificationCustomerId, runAfterCommit } = require('../utils/notificationHelper');
const { createRealtimeNotificationHub, emitRealtimeNotification } = require('../utils/notificationRealtime');
const { enqueueEmailDelivery, claimEmailDeliveries, processEmailQueue, getEligibleAdminRecipients, sendRevisionRequestedAdminEmail } = require('../middleware/email');
const { requestOTP, verifyOTP } = require('../utils/otpHelper');
const { processUrgentDeadlineReminders, resolveScheduledReminder } = require('../utils/urgentReminderCron');
const { requireAdmin } = require('../routes/adminAuth');
const { onlinePaymentMethod } = require('../utils/paymentMethod');
const { signaturesMatch, assertPayhereCallbackAuthenticity } = require('../utils/payhereSecurity');
const { hasLiveCapacityReservation, isReusableDepositCheckout } = require('../utils/capacityReservation');

const deposit = (status = 'completed', amount = 2000) => ({ paymentType: 'advance', status, amount });
const balance = (status = 'pending', amount = 2000) => ({ paymentType: 'full', status, amount });

test('paid orders and recent pending deposits reserve production capacity', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  assert.equal(hasLiveCapacityReservation({ amount_paid: 100, payments: [] }, { now }), true);
  assert.equal(hasLiveCapacityReservation({
    amount_paid: 0,
    payments: [{ paymentType: 'advance', status: 'pending', updatedAt: new Date(now - 30 * 60 * 1000) }],
  }, { now, reservationMinutes: 60 }), true);
});

test('expired, failed, and balance checkouts do not reserve initial-order capacity', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  for (const payment of [
    { paymentType: 'advance', status: 'pending', updatedAt: new Date(now - 61 * 60 * 1000) },
    { paymentType: 'advance', status: 'failed', updatedAt: new Date(now) },
    { paymentType: 'full', status: 'pending', updatedAt: new Date(now) },
  ]) {
    assert.equal(hasLiveCapacityReservation({ amount_paid: 0, payments: [payment] }, {
      now,
      reservationMinutes: 60,
    }), false);
  }
});

test('a live pending deposit checkout is reused for concurrent resume requests', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  assert.equal(isReusableDepositCheckout({
    paymentType: 'advance',
    status: 'pending',
    payhereOrderId: 'ORD-stable',
    payhereMd5sig: 'HASH',
    metadata: { capacityReservedUntil: new Date(now + 60_000).toISOString() },
  }, now), true);
});

test('expired or incomplete PayHere checkout details are rotated instead of reused', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  const checkout = {
    paymentType: 'advance', status: 'pending', payhereOrderId: 'ORD-old', payhereMd5sig: 'HASH',
    metadata: { capacityReservedUntil: new Date(now - 1).toISOString() },
  };
  assert.equal(isReusableDepositCheckout(checkout, now), false);
  assert.equal(isReusableDepositCheckout({ ...checkout, payhereMd5sig: null }, now), false);
  assert.equal(isReusableDepositCheckout({ ...checkout, paymentType: 'full' }, now), false);
});

test('online payments accept card or an omitted method only', () => {
  assert.equal(onlinePaymentMethod(), 'card');
  assert.equal(onlinePaymentMethod('card'), 'card');
  assert.equal(onlinePaymentMethod(' CARD '), 'card');
});

test('bank, cash, and unknown payment methods are rejected', () => {
  for (const method of ['bank', 'cash', 'paypal', 'legacy_bank']) {
    assert.throws(() => onlinePaymentMethod(method), {
      code: 'UNSUPPORTED_PAYMENT_METHOD',
      statusCode: 400,
    });
  }
});

test('remaining balance uses completed transactions only', () => {
  assert.equal(remainingBalance(4000, [deposit(), balance('pending')]), 2000);
});

test('PayHere checkout is usable only after its signed fields are persisted', () => {
  const complete = {
    payhereOrderId: 'ORD-balance',
    payhereMd5sig: 'HASH',
    metadata: { checkoutAmount: '2000.00', checkoutCurrency: 'LKR' },
  };
  assert.equal(hasUsableCheckout(complete), true);
  assert.equal(hasUsableCheckout({ ...complete, payhereMd5sig: null }), false);
  assert.equal(hasUsableCheckout({ ...complete, metadata: {} }), false);
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

test('PayHere callback authentication requires the configured merchant and signature', () => {
  assert.equal(signaturesMatch('ABC123', 'abc123'), true);
  assert.doesNotThrow(() => assertPayhereCallbackAuthenticity({
    receivedMerchantId: '1234567',
    configuredMerchantId: '1234567',
    receivedSignature: 'ABC123',
    expectedSignature: 'abc123',
  }));
});

test('PayHere callback authentication rejects merchant and signature mismatches', () => {
  assert.throws(() => assertPayhereCallbackAuthenticity({
    receivedMerchantId: '7654321',
    configuredMerchantId: '1234567',
    receivedSignature: 'ABC123',
    expectedSignature: 'ABC123',
  }), { code: 'INVALID_PAYHERE_MERCHANT' });
  assert.throws(() => assertPayhereCallbackAuthenticity({
    receivedMerchantId: '1234567',
    configuredMerchantId: '1234567',
    receivedSignature: 'BAD123',
    expectedSignature: 'ABC123',
  }), { code: 'INVALID_PAYHERE_SIGNATURE' });
});

test('payment summary totals deposits that do not have a completed balance', () => {
  assert.deepEqual(paymentSummary([
    { order_id: 'half-paid', ...deposit('completed', 1500) },
    { order_id: 'paid', ...deposit('completed', 2000) },
    { order_id: 'paid', ...balance('completed', 2000) },
    { order_id: 'pending-deposit', ...deposit('pending', 500) },
  ]), { balancePending: 1500, halfPaidOrderCount: 1 });
});

test('customer-controlled notification targets are rejected', () => {
  assert.throws(() => resolveNotificationCustomerId({
    requestCustomerId: 'customer-2',
    orderCustomerId: 'customer-1',
    trustedBackend: false,
  }), { message: 'Customer-controlled notification targets are not allowed. Use the order owner.' });
});

test('trusted backend workflows may notify the order owner only', () => {
  assert.equal(resolveNotificationCustomerId({
    requestCustomerId: 'customer-1',
    orderCustomerId: 'customer-1',
    trustedBackend: true,
  }), 'customer-1');
});

test('transactional realtime notifications wait until commit', () => {
  let afterCommit;
  let emitted = false;
  runAfterCommit({ afterCommit(callback) { afterCommit = callback; } }, () => { emitted = true; });
  assert.equal(emitted, false);
  afterCommit();
  assert.equal(emitted, true);
});

test('realtime notification hub broadcasts only to matching subscribers', () => {
  const hub = createRealtimeNotificationHub();
  const customerEvents = [];
  const otherCustomerEvents = [];

  hub.subscribe({ type: 'customer', userId: 'customer-1', listener: (event) => customerEvents.push(event) });
  hub.subscribe({ type: 'customer', userId: 'customer-2', listener: (event) => otherCustomerEvents.push(event) });

  emitRealtimeNotification({
    hub,
    type: 'customer',
    userId: 'customer-1',
    event: { type: 'notification', notification: { id: 42, title: 'Order update' } },
  });

  assert.equal(customerEvents.length, 1);
  assert.equal(customerEvents[0].notification.id, 42);
  assert.equal(otherCustomerEvents.length, 0);
});

test('email send requests are queued for background processing', async () => {
  const record = await enqueueEmailDelivery({
    to: 'customer@example.com',
    subject: 'Queued email test',
    text: 'Hello world',
    html: '<p>Hello world</p>',
  }, {
    ensureTable: async () => {},
    emailDeliveryModel: {
      create: async values => ({ id: 1, ...values, toJSON() { return { id: this.id, ...values }; } }),
    },
  });

  assert.ok(record && record.id);
  assert.equal(record.status, 'queued');
  assert.equal(record.attempts, 0);
});

test('only one email worker can claim the same queued delivery', async () => {
  let status = 'queued';
  let activeToken = null;
  const delivery = { id: 7 };
  const emailDeliveryModel = {
    async findAll() { return [delivery]; },
    async update(values) {
      if (values.status === 'retrying') return [0];
      if (values.status === 'processing' && status === 'queued') {
        status = 'processing';
        activeToken = values.lockToken;
        return [1];
      }
      return [0];
    },
    async findOne({ where }) {
      return where.lockToken === activeToken ? { ...delivery, status, lockToken: activeToken } : null;
    },
  };

  const [first, second] = await Promise.all([
    claimEmailDeliveries({ emailDeliveryModel, now: new Date() }),
    claimEmailDeliveries({ emailDeliveryModel, now: new Date() }),
  ]);
  assert.equal(first.length + second.length, 1);
});

test('queue processing marks transient failures for retry', async () => {
  const fakeDelivery = {
    id: 99,
    status: 'queued',
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: new Date(Date.now() - 1000),
    update: async (changes) => ({ ...changes, id: 99 }),
    save: async () => ({ id: 99 }),
    toJSON: () => ({ id: 99 }),
  };

  const result = await processEmailQueue({
    queue: [fakeDelivery],
    transport: {
      sendMail: async () => { throw new Error('SMTP timeout'); },
    },
    now: () => new Date(),
  });

  assert.equal(result[0].status, 'retrying');
  assert.equal(result[0].attempts, 1);
});

test('eligible admin recipients respect notification preferences', () => {
  const admins = [
    { id: 'a1', email: 'enabled@example.com', notifPreferences: { revisionRequested: true } },
    { id: 'a2', email: 'disabled@example.com', notifPreferences: { revisionRequested: false } },
    { id: 'a3', email: 'missing@example.com' },
    { id: 'a4', email: '', notifPreferences: { revisionRequested: true } },
  ];

  const eligible = getEligibleAdminRecipients(admins, 'revisionRequested');
  assert.deepEqual(eligible.map(admin => admin.id), ['a1', 'a3']);
});

test('revision requested emails are sent only to eligible admins and create in-app notification once', async () => {
  const sent = [];
  const notifications = [];
  const admins = [
    { id: 'a1', email: 'admin1@example.com', notifPreferences: { revisionRequested: true } },
    { id: 'a2', email: 'admin2@example.com', notifPreferences: { revisionRequested: false } },
    { id: 'a3', email: 'admin3@example.com', notifPreferences: { revisionRequested: true } },
  ];

  const results = await sendRevisionRequestedAdminEmail({
    order: { order_id: 'ord-123', id: 'ord-123' },
    customerName: 'Jane Customer',
    revisionNote: 'Please make the face brighter',
    admins,
    sendEmailFn: async ({ to, subject, text, html, metadata }) => {
      sent.push({ to, subject, metadata });
      return { ok: true, to, subject };
    },
    createInAppNotification: async ({ adminId, orderId, type, title, message }) => {
      notifications.push({ adminId, orderId, type, title, message });
    },
    findExistingNotification: async () => null,
  });

  assert.equal(results.length, 2);
  assert.deepEqual(sent.map(item => item.to).sort(), ['admin1@example.com', 'admin3@example.com']);
  assert.equal(notifications.length, 2);
  assert.match(notifications[0].message, /Please make the face brighter/);
});

test('processUrgentDeadlineReminders deduplicates reminders, skips cancelled/completed orders, and respects admin preference', async () => {
  const notifications = [];
  const emails = [];
  const referenceNow = new Date('2026-01-01T12:00:00Z');
  const dueInOneDay = new Date(referenceNow.getTime() + (24 * 60 * 60 * 1000)).toISOString();
  const orders = [
    {
      status: 'active',
      order_id: 'o-dup',
      estimated_completion_at: dueInOneDay,
      productOption: { urgent_deadline: dueInOneDay },
    },
    {
      status: 'completed',
      order_id: 'o-completed',
      estimated_completion_at: dueInOneDay,
      productOption: { urgent_deadline: dueInOneDay },
    },
    {
      status: 'cancelled',
      order_id: 'o-cancelled',
      estimated_completion_at: dueInOneDay,
      productOption: { urgent_deadline: dueInOneDay },
    },
  ];
  const dbLike = {
    Order: { findAll: async () => orders },
    Admin: { findAll: async () => [
      { id: 'a1', email: 'a1@example.com', notifPreferences: { deadlineReminders: true } },
      { id: 'a2', email: 'a2@example.com', notifPreferences: { deadlineReminders: false } },
    ] },
    AdminNotification: {
      findOne: async () => null,
    },
    Sequelize: { Op: { gte: 'gte', notIn: 'notIn' } },
  };

  const processed = await processUrgentDeadlineReminders({
    orders,
    dbInstance: dbLike,
    sendEmailFn: async ({ to, subject, text, html, metadata }) => {
      emails.push({ to, subject, metadata });
      return { ok: true };
    },
    createNotificationFn: async ({ adminId, orderId, type, title, message }) => {
      notifications.push({ adminId, orderId, type, title, message });
    },
    now: () => referenceNow,
  });

  assert.equal(processed, 1);
  assert.equal(notifications.length, 1);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'a1@example.com');
});

test('scheduled orders create reminders seven days before the required date', () => {
  const today = new Date('2026-01-01T00:00:00');
  const reminder = resolveScheduledReminder({ order_id: 'scheduled-123', productOption: { scheduled_date: '2026-01-08' } }, today);
  assert.equal(reminder.reminderType, 'scheduled_reminder_7_days');
  assert.match(reminder.messageText, /in 7 days/i);
});

test('OTP expiry is rejected after the validity window', async () => {
  const expiryRecord = {
    identifier: 'otp@example.com',
    type: 'register',
    otp: '123456',
    attempts: 0,
    expiresAt: new Date(Date.now() - 1000),
    destroy: async () => {},
  };

  const dbStub = {
    VerificationToken: {
      findOne: async () => expiryRecord,
    },
  };

  const originalDb = require.cache[require.resolve('../models')];
  const originalHelperDb = require.cache[require.resolve('../utils/otpHelper')];
  require.cache[require.resolve('../models')] = { exports: dbStub };
  delete require.cache[require.resolve('../utils/otpHelper')];
  const { verifyOTP: verifyExpiredOTP } = require('../utils/otpHelper');

  await assert.rejects(() => verifyExpiredOTP('otp@example.com', '123456'), /expired/i);

  if (originalDb) require.cache[require.resolve('../models')] = originalDb;
  if (originalHelperDb) require.cache[require.resolve('../utils/otpHelper')] = originalHelperDb;
});

test('SMTP failure is handled gracefully without crashing', async () => {
  const result = await processEmailQueue({
    queue: [{
      id: 1,
      to: 'maybe@example.com',
      subject: 'SMTP fail',
      text: 'Hello',
      html: '<p>Hello</p>',
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1000),
      update: async (changes) => ({ ...changes, id: 1 }),
      toJSON: () => ({
        id: 1,
        to: 'maybe@example.com',
        subject: 'SMTP fail',
        text: 'Hello',
        html: '<p>Hello</p>',
        status: 'queued',
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: new Date(Date.now() - 1000),
      }),
    }],
    transport: { sendMail: async () => { throw new Error('SMTP timeout'); } },
    now: () => new Date(),
  });

  assert.equal(result[0].status, 'retrying');
  assert.equal(result[0].attempts, 1);
});

test('admin registration and protected routes reject unauthorized access', async () => {
  const next = () => {};
  const req = { session: {} };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  await requireAdmin(req, res, next);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error, 'Unauthorized');
});
