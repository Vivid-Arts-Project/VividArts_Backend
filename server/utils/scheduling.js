const { ORDER_STATUSES } = require('./orderWorkflow');

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
const ACTIVE_STATUSES = [...ORDER_STATUSES.filter(status => !TERMINAL_STATUSES.has(status)), 'finished'];
const DAY_MS = 24 * 60 * 60 * 1000;
const REVISION_DAYS = 2;
const DELIVERY_DAYS = 3;
const SCHEDULE_TOLERANCE_DAYS = 2;

const startOfToday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date; };
const addDays = (date, days) => { const result = new Date(date); result.setDate(result.getDate() + days); return result; };
const dateInputValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parseDate = (value) => {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const dateValue = (value) => parseDate(value)?.getTime() ?? Number.POSITIVE_INFINITY;
const product = (order) => order.productOption || {};
const subjectCount = (order) => Math.max(1, Number(product(order).num_subjects || order.people || 1));
const isPremiumFrame = (order) => ['premium', 'wooden_frame'].includes(product(order).frame_type || order.frameId);
const isCourier = (order) => (product(order).pickup_option || order.deliveryMethod) === 'courier';
const isScheduled = (order) => Boolean(order.is_scheduled || product(order).is_scheduled || order.scheduled);
const scheduledDate = (order) => product(order).scheduled_date || order.scheduledDate;

const productionBreakdown = (order) => ({
  drawingDays: 7 + subjectCount(order),
  revisionDays: REVISION_DAYS,
  frameDays: isPremiumFrame(order) ? 1 : 0,
});
const productionDays = (order) => Object.values(productionBreakdown(order)).reduce((sum, days) => sum + days, 0);
const totalScheduledDays = (order) => productionDays(order) + (isCourier(order) ? DELIVERY_DAYS : 0) + SCHEDULE_TOLERANCE_DAYS;
const requiredScheduledStart = (order) => {
  const requested = parseDate(scheduledDate(order));
  return requested ? addDays(requested, -totalScheduledDays(order)) : null;
};
const hasScheduledSlotConflict = (orders, proposedOrder, windowDays = 15) => {
  const requestedStart = requiredScheduledStart(proposedOrder);
  if (!requestedStart) return false;
  return orders.some(order => {
    if (!isScheduled(order)) return false;
    const existingStart = product(order).scheduled_start_date
      ? parseDate(product(order).scheduled_start_date)
      : requiredScheduledStart(order);
    return existingStart && Math.abs(existingStart.getTime() - requestedStart.getTime()) < windowDays * DAY_MS;
  });
};

const urgentSort = (a, b) => dateValue(product(a).urgent_deadline) - dateValue(product(b).urgent_deadline)
  || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
const urgentAnchor = (urgentOrders, today) => urgentOrders.reduce((latest, order) => {
  const deadline = parseDate(product(order).urgent_deadline);
  return deadline && deadline > latest ? deadline : latest;
}, today);

const insertScheduledOrder = (queue, scheduledOrder, anchor) => {
  const requiredStart = requiredScheduledStart(scheduledOrder) || anchor;
  let cursor = new Date(anchor);
  let index = 0;
  for (; index < queue.length; index += 1) {
    const reservedStart = requiredScheduledStart(queue[index]);
    const itemStart = isScheduled(queue[index]) && reservedStart
      ? new Date(Math.max(cursor.getTime(), reservedStart.getTime()))
      : cursor;
    const itemEnd = addDays(itemStart, productionDays(queue[index]));
    if (itemEnd > requiredStart) break;
    cursor = itemEnd;
  }
  queue.splice(index, 0, scheduledOrder);
};

const sortProductionQueue = (orders) => {
  const completed = orders.filter(order => TERMINAL_STATUSES.has(order.status))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const active = orders.filter(order => !TERMINAL_STATUSES.has(order.status))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const urgent = active.filter(order => order.is_urgent).sort(urgentSort);
  const standard = active.filter(order => !order.is_urgent && !isScheduled(order));
  const scheduled = active.filter(order => !order.is_urgent && isScheduled(order))
    .sort((a, b) => dateValue(scheduledDate(a)) - dateValue(scheduledDate(b)));
  const anchor = urgentAnchor(urgent, startOfToday());
  scheduled.forEach(order => insertScheduledOrder(standard, order, anchor));
  return [...urgent, ...standard, ...completed];
};

const timelineForPosition = (ordered, proposedOrder, position, anchor) => {
  let cursor = new Date(anchor);
  for (let index = 0; index < position; index += 1) {
    const item = ordered[index];
    const reservedStart = requiredScheduledStart(item);
    const itemStart = isScheduled(item) && reservedStart
      ? new Date(Math.max(cursor.getTime(), reservedStart.getTime()))
      : cursor;
    cursor = addDays(itemStart, productionDays(item));
  }
  const requestedStart = requiredScheduledStart(proposedOrder);
  const sketchingStart = requestedStart ? new Date(Math.max(cursor.getTime(), requestedStart.getTime())) : cursor;
  return { cursor, sketchingStart, requestedStart };
};

const buildTimelinePreview = (orders, proposedOrder) => {
  const today = startOfToday();
  const active = orders.filter(order => ACTIVE_STATUSES.includes(order.status));
  const urgentOrders = active.filter(order => order.is_urgent).sort(urgentSort);
  const breakdown = productionBreakdown(proposedOrder);

  if (proposedOrder.urgent) {
    const deadline = dateValue(proposedOrder.urgentDeadline);
    const earlierUrgentOrders = urgentOrders.filter(order => dateValue(product(order).urgent_deadline) <= deadline).length;
    const totalUrgentDays = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - today.getTime()) / DAY_MS)) : 0;
    return {
      queuePosition: earlierUrgentOrders + 1, queueType: 'Urgent priority', sketchingStart: dateInputValue(today),
      drawingDays: Math.max(0, totalUrgentDays - 1), revisionDays: 1, frameDays: 0,
      estimatedCompletion: proposedOrder.urgentDeadline,
      deliveryEstimate: proposedOrder.deliveryMethod === 'courier' ? '2–3 days after completion' : 'Pickup after completion',
      feasible: true,
    };
  }

  const ordered = sortProductionQueue(active).filter(order => !order.is_urgent);
  const anchor = urgentAnchor(urgentOrders, today);
  let insertionIndex = ordered.length;
  if (proposedOrder.scheduled) {
    const testQueue = [...ordered];
    insertScheduledOrder(testQueue, proposedOrder, anchor);
    insertionIndex = testQueue.indexOf(proposedOrder);
  }
  const { cursor, sketchingStart, requestedStart } = timelineForPosition(ordered, proposedOrder, insertionIndex, anchor);
  const estimatedCompletion = addDays(sketchingStart, productionDays(proposedOrder));
  const requestedDate = parseDate(proposedOrder.scheduledDate);
  const delivered = addDays(estimatedCompletion, proposedOrder.deliveryMethod === 'courier' ? DELIVERY_DAYS : 0);
  const feasible = !requestedDate || Boolean(requestedStart && requestedStart >= today && cursor <= requestedStart && delivered <= requestedDate);

  return {
    queuePosition: urgentOrders.length + insertionIndex + 1,
    queueType: proposedOrder.scheduled ? 'Scheduled queue' : 'Standard queue',
    sketchingStart: dateInputValue(sketchingStart), requiredStart: requestedStart ? dateInputValue(requestedStart) : null,
    drawingDays: breakdown.drawingDays, revisionDays: breakdown.revisionDays, frameDays: breakdown.frameDays,
    toleranceDays: proposedOrder.scheduled ? SCHEDULE_TOLERANCE_DAYS : 0,
    estimatedCompletion: dateInputValue(estimatedCompletion), scheduledDate: proposedOrder.scheduledDate || null,
    deliveryEstimate: proposedOrder.deliveryMethod === 'courier' ? '2–3 days after completion' : 'Pickup after completion',
    feasible, unavailableReason: feasible ? null : 'That date cannot be guaranteed with the current queue. Please select a later date.',
  };
};

const calculateCompletionFromSketchingStart = ({ start, isUrgent, urgentDeadline, people, frameId }) => {
  if (isUrgent && parseDate(urgentDeadline)) return urgentDeadline;
  return dateInputValue(addDays(start, productionDays({ people, frameId })));
};

module.exports = { ACTIVE_STATUSES, buildTimelinePreview, calculateCompletionFromSketchingStart, hasScheduledSlotConflict, productionDays, requiredScheduledStart, sortProductionQueue };
