const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTimelinePreview, hasScheduledSlotConflict, productionDays } = require('../utils/scheduling');

const dateAfter = (days) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const order = (id, createdDay, options = {}) => ({
  order_id: id,
  status: 'in_queue',
  is_urgent: Boolean(options.urgent),
  is_scheduled: Boolean(options.scheduled),
  createdAt: new Date(2026, 0, createdDay),
  productOption: {
    num_subjects: options.people || 1,
    frame_type: options.frame || 'plastic_frame',
    pickup_option: options.delivery || 'pickup',
    is_scheduled: Boolean(options.scheduled),
    urgent_deadline: options.urgentDeadline || null,
    scheduled_date: options.scheduledDate || null,
  },
});

test('standard production formula includes subjects, revisions, and premium framing', () => {
  assert.equal(productionDays({ people: 1, frameId: 'classic' }), 10);
  assert.equal(productionDays({ people: 3, frameId: 'premium' }), 13);
});

test('scheduled order is inserted after the last order that completes before its required start', () => {
  const orders = [
    order('urgent', 1, { urgent: true, urgentDeadline: dateAfter(5) }),
    order('normal-1', 2),
    order('normal-2', 3),
  ];
  const timeline = buildTimelinePreview(orders, {
    scheduled: true, scheduledDate: dateAfter(27), people: 1, frameId: 'classic', deliveryMethod: 'pickup',
  });
  assert.equal(timeline.queuePosition, 3);
  assert.equal(timeline.queueType, 'Scheduled queue');
  assert.equal(timeline.requiredStart, dateAfter(15));
  assert.equal(timeline.feasible, true);
});

test('scheduled order moves directly behind urgent work when the next normal order cannot finish in time', () => {
  const orders = [
    order('urgent', 1, { urgent: true, urgentDeadline: dateAfter(5) }),
    order('normal-1', 2),
    order('normal-2', 3),
  ];
  const timeline = buildTimelinePreview(orders, {
    scheduled: true, scheduledDate: dateAfter(26), people: 1, frameId: 'classic', deliveryMethod: 'pickup',
  });
  assert.equal(timeline.queuePosition, 2);
  assert.equal(timeline.requiredStart, dateAfter(14));
  assert.equal(timeline.feasible, true);
});

test('scheduled order is rejected when its calculated start date has passed', () => {
  const timeline = buildTimelinePreview([], {
    scheduled: true, scheduledDate: dateAfter(5), people: 1, frameId: 'classic', deliveryMethod: 'pickup',
  });
  assert.equal(timeline.feasible, false);
  assert.match(timeline.unavailableReason, /later date/i);
});

test('scheduled production starts must be at least 15 days apart', () => {
  const existing = order('scheduled', 1, { scheduled: true, scheduledDate: dateAfter(32) });
  const proposed = { scheduled: true, scheduledDate: dateAfter(27), people: 1, frameId: 'classic', deliveryMethod: 'pickup' };
  assert.equal(hasScheduledSlotConflict([existing], proposed, 15), true);
  existing.productOption.scheduled_date = dateAfter(50);
  assert.equal(hasScheduledSlotConflict([existing], proposed, 15), false);
});
