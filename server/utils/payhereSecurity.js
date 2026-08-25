const crypto = require('crypto');
const { PaymentRuleError } = require('./paymentRules');

function signaturesMatch(receivedSignature, expectedSignature) {
  const received = String(receivedSignature || '').trim().toUpperCase();
  const expected = String(expectedSignature || '').trim().toUpperCase();
  if (!received || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function assertPayhereCallbackAuthenticity({
  receivedMerchantId,
  configuredMerchantId,
  receivedSignature,
  expectedSignature,
}) {
  if (!configuredMerchantId || String(receivedMerchantId || '').trim() !== configuredMerchantId) {
    throw new PaymentRuleError('Invalid merchant', 400, 'INVALID_PAYHERE_MERCHANT');
  }
  if (!signaturesMatch(receivedSignature, expectedSignature)) {
    throw new PaymentRuleError('Invalid signature', 400, 'INVALID_PAYHERE_SIGNATURE');
  }
}

module.exports = { signaturesMatch, assertPayhereCallbackAuthenticity };
