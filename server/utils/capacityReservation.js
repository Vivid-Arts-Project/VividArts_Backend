const hasLiveCapacityReservation = (order, {
  now = Date.now(),
  reservationMinutes = 60,
} = {}) => {
  if (Number(order.amount_paid || 0) > 0) return true;
  const cutoff = now - reservationMinutes * 60 * 1000;
  return Boolean(order.payments?.some(payment => (
    payment.paymentType === 'advance'
    && payment.status === 'pending'
    && new Date(payment.updatedAt).getTime() >= cutoff
  )));
};

const isReusableDepositCheckout = (payment, now = Date.now()) => {
  const reservedUntil = Date.parse(payment?.metadata?.capacityReservedUntil || '');
  return Boolean(
    payment
    && payment.paymentType === 'advance'
    && payment.status === 'pending'
    && payment.payhereOrderId
    && payment.payhereMd5sig
    && Number.isFinite(reservedUntil)
    && reservedUntil > now
  );
};

module.exports = { hasLiveCapacityReservation, isReusableDepositCheckout };
