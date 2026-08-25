const test = require('node:test');
const assert = require('node:assert/strict');
const { proofReviewDecision } = require('../utils/proofReviewRules');

const pendingReview = (overrides = {}) => ({
  action: 'approve',
  orderStatus: 'waiting_for_feedback',
  proofReviewStatus: 'pending',
  revisionRequestsUsed: 0,
  note: '',
  ...overrides,
});

test('a pending proof can be approved once', () => {
  assert.deepEqual(proofReviewDecision(pendingReview()), {
    approved: true,
    revisionNote: '',
    revisionRequestsRemaining: 2,
  });
});

test('proof actions reject invalid and completed workflow states', () => {
  assert.throws(() => proofReviewDecision(pendingReview({ action: 'anything' })), { code: 'INVALID_PROOF_ACTION' });
  assert.throws(() => proofReviewDecision(pendingReview({ orderStatus: 'approved' })), { code: 'PROOF_REVIEW_NOT_AVAILABLE' });
  assert.throws(() => proofReviewDecision(pendingReview({ proofReviewStatus: 'approved' })), { code: 'PROOF_REVIEW_NOT_AVAILABLE' });
});

test('revision requests require a bounded note', () => {
  assert.throws(() => proofReviewDecision(pendingReview({ action: 'revision' })), { code: 'REVISION_NOTE_REQUIRED' });
  assert.throws(() => proofReviewDecision(pendingReview({ action: 'revision', note: 'x'.repeat(1001) })), { code: 'REVISION_NOTE_TOO_LONG' });
});

test('only two included revision requests are accepted', () => {
  assert.equal(proofReviewDecision(pendingReview({ action: 'revision', note: 'Adjust the shading', revisionRequestsUsed: 1 })).revisionRequestsRemaining, 0);
  assert.throws(() => proofReviewDecision(pendingReview({ action: 'revision', note: 'One more change', revisionRequestsUsed: 2 })), { code: 'REVISION_LIMIT_REACHED' });
});
