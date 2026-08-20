const { ORDER_STATUSES } = require('./orderWorkflow');

const ACTIVE_STATUSES = [...ORDER_STATUSES.filter(status => status !== 'done'), 'finished'];

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

const dateInputValue = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const dateValue = (value) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

const subjectCount = (order) => Math.max(1, Number(order.productOption?.num_subjects || order.people || 1));
const normalProductionDays = (order) => 7 + Math.max(0, subjectCount(order) - 1) + 3;

const calculateCompletionFromSketchingStart = ({ start, isUrgent, urgentDeadline, people }) => {
  if (isUrgent && Number.isFinite(dateValue(urgentDeadline))) return urgentDeadline;
  const productionDays = 7 + Math.max(0, Number(people || 1) - 1) + 3;
  return dateInputValue(addDays(start, productionDays));
};

const sortProductionQueue = (orders) => [...orders].sort((a, b) => {
  if (a.status === 'done' && b.status !== 'done') return 1;
  if (a.status !== 'done' && b.status === 'done') return -1;
  if (a.is_urgent !== b.is_urgent) return a.is_urgent ? -1 : 1;
  if (a.is_urgent && b.is_urgent) {
    const deadlineDifference = dateValue(a.productOption?.urgent_deadline) - dateValue(b.productOption?.urgent_deadline);
    if (deadlineDifference) return deadlineDifference;
  }
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
});

const buildTimelinePreview = (orders, proposedOrder) => {
  const today = startOfToday();
  const active = sortProductionQueue(orders.filter(order => ACTIVE_STATUSES.includes(order.status)));
  const urgentOrders = active.filter(order => order.is_urgent);
  const normalOrders = active.filter(order => !order.is_urgent);
  const people = Math.max(1, Number(proposedOrder.people || 1));
  const drawingDays = 7 + Math.max(0, people - 1);
  const revisionDays = 3;

  if (proposedOrder.urgent) {
    const deadline = dateValue(proposedOrder.urgentDeadline);
    const earlierUrgentOrders = urgentOrders.filter(order => dateValue(order.productOption?.urgent_deadline) <= deadline).length;
    const urgentRevisionDays = 1;
    const totalUrgentDays = Number.isFinite(deadline)
      ? Math.max(0, Math.ceil((deadline - today.getTime()) / (24 * 60 * 60 * 1000)))
      : 0;
    return {
      queuePosition: earlierUrgentOrders + 1,
      queueType: 'Urgent priority',
      sketchingStart: dateInputValue(today),
      drawingDays: Math.max(0, totalUrgentDays - urgentRevisionDays),
      revisionDays: urgentRevisionDays,
      estimatedCompletion: proposedOrder.urgentDeadline,
      deliveryEstimate: proposedOrder.deliveryMethod === 'courier' ? '2–5 working days after completion' : 'Pickup after completion',
    };
  }

  const latestUrgentDeadline = urgentOrders.reduce((latest, order) => {
    const deadline = dateValue(order.productOption?.urgent_deadline);
    return Number.isFinite(deadline) && deadline > latest.getTime() ? new Date(deadline) : latest;
  }, today);

  let sketchingStart = latestUrgentDeadline;
  normalOrders.forEach(order => {
    sketchingStart = addDays(sketchingStart, normalProductionDays(order));
  });
  const drawingComplete = addDays(sketchingStart, drawingDays);
  const estimatedCompletion = addDays(drawingComplete, revisionDays);

  return {
    queuePosition: urgentOrders.length + normalOrders.length + 1,
    queueType: 'Standard queue',
    sketchingStart: dateInputValue(sketchingStart),
    drawingDays,
    revisionDays,
    estimatedCompletion: dateInputValue(estimatedCompletion),
    deliveryEstimate: proposedOrder.deliveryMethod === 'courier' ? '2–5 working days after completion' : 'Pickup after completion',
  };
};

module.exports = {
  ACTIVE_STATUSES,
  buildTimelinePreview,
  calculateCompletionFromSketchingStart,
  sortProductionQueue,
};
