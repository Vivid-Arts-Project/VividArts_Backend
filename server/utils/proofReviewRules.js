class ProofReviewRuleError extends Error {
  constructor(message, statusCode = 409, code = 'PROOF_REVIEW_NOT_AVAILABLE') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const MAX_INCLUDED_REVISIONS = 2;

function proofReviewDecision({ action, orderStatus, proofReviewStatus, revisionRequestsUsed, note }) {
  if (!['approve', 'revision'].includes(action)) {
    throw new ProofReviewRuleError('Action must be approve or revision', 400, 'INVALID_PROOF_ACTION');
  }
  if (orderStatus !== 'waiting_for_feedback' || proofReviewStatus !== 'pending') {
    throw new ProofReviewRuleError('This proof has already been reviewed or is not awaiting feedback');
  }

  const used = Math.max(0, Number(revisionRequestsUsed) || 0);
  if (action === 'approve') {
    return { approved: true, revisionNote: '', revisionRequestsRemaining: Math.max(0, MAX_INCLUDED_REVISIONS - used) };
  }

  const revisionNote = String(note || '').trim();
  if (!revisionNote) {
    throw new ProofReviewRuleError('Please describe the requested changes', 400, 'REVISION_NOTE_REQUIRED');
  }
  if (revisionNote.length > 1000) {
    throw new ProofReviewRuleError('Revision notes must be 1000 characters or fewer', 400, 'REVISION_NOTE_TOO_LONG');
  }
  if (used >= MAX_INCLUDED_REVISIONS) {
    throw new ProofReviewRuleError('The two included revision requests have been used. Please approve this proof or contact the studio.', 409, 'REVISION_LIMIT_REACHED');
  }

  return {
    approved: false,
    revisionNote,
    revisionRequestsRemaining: MAX_INCLUDED_REVISIONS - used - 1,
  };
}

module.exports = { MAX_INCLUDED_REVISIONS, ProofReviewRuleError, proofReviewDecision };
