class MessageRuleError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_MESSAGE') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const MAX_MESSAGE_LENGTH = 2000;

function normalizeMessage(value) {
  const message = String(value || '').trim();
  if (!message) throw new MessageRuleError('Message is required', 400, 'MESSAGE_REQUIRED');
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new MessageRuleError(`Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer`, 400, 'MESSAGE_TOO_LONG');
  }
  return message;
}

module.exports = { MAX_MESSAGE_LENGTH, MessageRuleError, normalizeMessage };
