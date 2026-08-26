class PaymentRuleError extends Error {
  constructor(message, statusCode = 409, code = 'PAYMENT_RULE_VIOLATION') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function remainingBalance(total, payments) {
  const paid = payments
    .filter(payment => payment.status === 'completed')
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  return Math.max(0, Number(total || 0) - paid);
}

function hasUsableCheckout(payment) {
  return Boolean(
    payment?.payhereOrderId
    && payment?.payhereMd5sig
    && payment?.metadata?.checkoutAmount
    && payment?.metadata?.checkoutCurrency
  );
}

function balanceCheckoutDecision({ orderStatus, total, payments }) {
  if (!['approved', 'finished'].includes(orderStatus)) {
    throw new PaymentRuleError('The balance is available after proof approval', 400, 'PROOF_NOT_APPROVED');
  }
  const balance = remainingBalance(total, payments);
  if (balance <= 0) throw new PaymentRuleError('This order is already paid in full', 400, 'ALREADY_PAID');

  const deposit = payments.find(payment => payment.paymentType === 'advance');
  if (!deposit || deposit.status !== 'completed') {
    throw new PaymentRuleError('The deposit must be completed before paying the balance', 409, 'DEPOSIT_NOT_COMPLETED');
  }
  const balancePayment = payments.find(payment => payment.paymentType === 'full');
  if (balancePayment?.status === 'pending') {
    throw new PaymentRuleError('A balance checkout is already active for this order', 409, 'BALANCE_CHECKOUT_ACTIVE');
  }
  if (balancePayment?.status === 'completed') {
    throw new PaymentRuleError('This order is already paid in full', 400, 'ALREADY_PAID');
  }
  if (payments.length >= 2 && !balancePayment) {
    throw new PaymentRuleError('This order already has the maximum two payment transactions', 409, 'PAYMENT_LIMIT_REACHED');
  }
  return { balance, reusablePayment: balancePayment?.status === 'failed' ? balancePayment : null };
}

function paymentCallbackDecision({ currentStatus, nextStatus, expectedAmount, receivedAmount, expectedCurrency, receivedCurrency }) {
  if (Number(receivedAmount).toFixed(2) !== Number(expectedAmount).toFixed(2)
    || String(receivedCurrency).toUpperCase() !== String(expectedCurrency).toUpperCase()) {
    throw new PaymentRuleError('Payment details do not match', 400, 'PAYMENT_DETAILS_MISMATCH');
  }
  if (currentStatus === 'completed') return { idempotent: true, status: 'completed' };
  return { idempotent: false, status: nextStatus };
}

function orderStatusAfterPayment(orderStatus, paidInFull) {
  return paidInFull && ['approved', 'finished'].includes(orderStatus) ? 'payment_finished' : orderStatus;
}

function paymentSummary(payments) {
  const orders = new Map();

  for (const payment of payments) {
    if (!payment.order_id || payment.status !== 'completed') continue;
    const current = orders.get(payment.order_id) || { deposit: 0, balanceCompleted: false };
    if (payment.paymentType === 'advance') current.deposit += Number(payment.amount || 0);
    if (payment.paymentType === 'full') current.balanceCompleted = true;
    orders.set(payment.order_id, current);
  }

  const halfPaidOrders = [...orders.values()].filter(order => order.deposit > 0 && !order.balanceCompleted);
  return {
    balancePending: halfPaidOrders.reduce((sum, order) => sum + order.deposit, 0),
    halfPaidOrderCount: halfPaidOrders.length,
  };
}

module.exports = { PaymentRuleError, remainingBalance, hasUsableCheckout, balanceCheckoutDecision, paymentCallbackDecision, orderStatusAfterPayment, paymentSummary };
