// Compatibility API for existing admin routes; checkout uses this same catalog.
const { calculateOrder, loadPrices } = require('../utils/pricing');

async function calculatePrice({ paperSize, subjectCount, numSubjects, frameType, pickupOption, isUrgent }) {
  const order = await calculateOrder({
    sizeId: paperSize,
    people: numSubjects || { one: 1, two: 2, more_than_two: 3 }[subjectCount] || 1,
    frameId: { without_frame: 'none', plastic_frame: 'classic', wooden_frame: 'premium' }[frameType] || 'none',
    isUrgent,
  });
  const breakdown = [
    { label: `Base price (${order.sizeId}, 1 subject)`, amount: order.basePrice },
    ...(order.peoplePrice ? [{ label: `Additional subjects (${order.people - 1})`, amount: order.peoplePrice }] : []),
    ...(order.framePrice ? [{ label: `${order.frameLabel} frame`, amount: order.framePrice }] : []),
    ...(pickupOption === 'pickup' ? [] : [{ label: 'Delivery charge', amount: order.deliveryPrice }]),
    ...(order.urgentPrice ? [{ label: 'Urgent order charge', amount: order.urgentPrice }] : []),
    ...(order.scheduledPrice ? [{ label: 'Scheduled order charge', amount: order.scheduledPrice }] : []),
  ];
  return { breakdown, total: breakdown.reduce((sum, row) => sum + row.amount, 0) };
}

module.exports = { calculatePrice, loadPrices };
