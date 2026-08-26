const ORDER_STATUSES = Object.freeze([
  'in_queue', 'sketching', 'waiting_for_feedback', 'revision_requested',
  'approved', 'payment_finished', 'framed', 'shipped', 'done', 'cancelled',
]);

const SYSTEM_CONTROLLED_STATUSES = Object.freeze([
  'waiting_for_feedback', 'revision_requested', 'approved', 'payment_finished',
]);

function normalizeStatus(status) {
  return status === 'finished' ? 'approved' : status;
}

function allowedTransitions(status, product = {}) {
  const current = normalizeStatus(status);
  const hasFrame = Boolean(product.frame_type && product.frame_type !== 'without_frame');
  const usesCourier = product.pickup_option === 'courier';
  const transitions = {
    in_queue: ['in_queue', 'sketching'],
    sketching: ['sketching', 'waiting_for_feedback'],
    waiting_for_feedback: ['waiting_for_feedback', 'revision_requested', 'approved'],
    revision_requested: ['revision_requested', 'waiting_for_feedback'],
    approved: ['approved', 'payment_finished'],
    payment_finished: ['payment_finished', ...(hasFrame ? ['framed'] : usesCourier ? ['shipped'] : ['done'])],
    framed: ['framed', ...(usesCourier ? ['shipped'] : ['done'])],
    shipped: ['done'],
    done: ['done'],
    cancelled: ['cancelled'],
  };
  return transitions[current] || [];
}

function canTransition(current, requested, product) {
  return allowedTransitions(current, product).includes(normalizeStatus(requested));
}

function adminAllowedTransitions(status, product = {}) {
  const current = normalizeStatus(status);
  if (['waiting_for_feedback', 'revision_requested', 'approved'].includes(current)) return [current];
  return allowedTransitions(current, product).filter(candidate => (
    candidate === current || !SYSTEM_CONTROLLED_STATUSES.includes(candidate)
  ));
}

module.exports = {
  ORDER_STATUSES,
  SYSTEM_CONTROLLED_STATUSES,
  normalizeStatus,
  allowedTransitions,
  canTransition,
  adminAllowedTransitions,
};
