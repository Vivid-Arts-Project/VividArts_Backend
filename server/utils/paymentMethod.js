const ONLINE_PAYMENT_METHOD = 'card';

class UnsupportedPaymentMethodError extends Error {
  constructor() {
    super('Only online PayHere card payments are supported');
    this.name = 'UnsupportedPaymentMethodError';
    this.statusCode = 400;
    this.code = 'UNSUPPORTED_PAYMENT_METHOD';
  }
}

function onlinePaymentMethod(value) {
  if (value === undefined || value === null || value === '') return ONLINE_PAYMENT_METHOD;
  if (String(value).trim().toLowerCase() !== ONLINE_PAYMENT_METHOD) {
    throw new UnsupportedPaymentMethodError();
  }
  return ONLINE_PAYMENT_METHOD;
}

module.exports = { ONLINE_PAYMENT_METHOD, UnsupportedPaymentMethodError, onlinePaymentMethod };
