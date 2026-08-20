const ORDER_STATUSES = Object.freeze([
  'in_queue', 'sketching', 'waiting_for_feedback', 'revision_requested',
  'approved', 'framed', 'shipped', 'done',
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
    sketching: ['sketching'],
    waiting_for_feedback: ['waiting_for_feedback'],
    revision_requested: ['revision_requested'],
    approved: ['approved', ...(hasFrame ? ['framed'] : usesCourier ? ['shipped'] : ['done'])],
    framed: ['framed', ...(usesCourier ? ['shipped'] : ['done'])],
    shipped: ['shipped', 'done'],
    done: ['done'],
  };
  return transitions[current] || [];
}

function canTransition(current, requested, product) {
  return allowedTransitions(current, product).includes(normalizeStatus(requested));
}

module.exports = { ORDER_STATUSES, normalizeStatus, allowedTransitions, canTransition };
