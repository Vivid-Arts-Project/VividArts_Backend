const ORDER_STATUSES = Object.freeze([
  'in_queue', 'sketching', 'waiting_for_feedback', 'revision_requested',
  'approved', 'framed', 'done',
]);

function normalizeStatus(status) {
  return status === 'finished' ? 'approved' : status;
}

function allowedTransitions(status, product = {}) {
  const current = normalizeStatus(status);
  const hasFrame = Boolean(product.frame_type && product.frame_type !== 'without_frame');
  const transitions = {
    in_queue: ['in_queue', 'sketching'],
    sketching: ['sketching', 'waiting_for_feedback'],
    waiting_for_feedback: ['waiting_for_feedback', 'sketching', 'revision_requested', 'approved'],
    revision_requested: ['revision_requested', 'sketching', 'waiting_for_feedback'],
    approved: ['approved', ...(hasFrame ? ['framed'] : ['done'])],
    framed: ['framed', 'done'],
    shipped: ['done'],
    done: ['done'],
  };
  return transitions[current] || [];
}

function canTransition(current, requested, product) {
  return allowedTransitions(current, product).includes(normalizeStatus(requested));
}

module.exports = { ORDER_STATUSES, normalizeStatus, allowedTransitions, canTransition };
