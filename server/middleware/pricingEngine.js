// ─── pricingEngine.js ────────────────────────────────────────────────────────
// Central pricing function used by:
//   • customer order routes  (when a new order is submitted)
//   • admin routes           (GET /admin/pricing — live preview for the frontend)
//
// It reads prices from the PriceConfigs DB table so any admin update to prices
// is reflected immediately in every new order calculation.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../models');

/**
 * Load all active price rows from the DB and index them by itemKey.
 * Returns a plain object: { BASE_A4_1_SUBJ: 2000, ADDON_A3_2_SUBJ: 750, ... }
 */
async function loadPrices() {
  const rows = await db.PriceConfig.findAll({ where: { isActive: true } });
  return Object.fromEntries(rows.map(r => [r.itemKey, parseFloat(r.price)]));
}

/**
 * Calculate the total price for an order.
 *
 * @param {Object} opts
 * @param {'A4'|'A3'}                            opts.paperSize
 * @param {'one'|'two'|'more_than_two'}          opts.subjectCount
 * @param {'without_frame'|'plastic_frame'|'wooden_frame'} opts.frameType
 * @param {'courier'|'pickup'}                   opts.pickupOption
 * @param {boolean}                              opts.isUrgent
 *
 * @returns {Promise<{
 *   breakdown: Array<{label:string, amount:number}>,
 *   total: number
 * }>}
 */
async function calculatePrice({ paperSize, subjectCount, frameType, pickupOption, isUrgent }) {
  const p = await loadPrices();
  const breakdown = [];

  // 1. Base price — depends on paper size only (always 1-subject base)
  const baseKey = paperSize === 'A4' ? 'BASE_A4_1_SUBJ' : 'BASE_A3_1_SUBJ';
  const basePrice = p[baseKey] ?? 0;
  breakdown.push({ label: `Base price (${paperSize}, 1 subject)`, amount: basePrice });

  // 2. Subject add-on — only applies when more than 1 subject
  if (subjectCount !== 'one') {
    const addonKey = paperSize === 'A4'
      ? (subjectCount === 'two' ? 'ADDON_A4_2_SUBJ' : 'ADDON_A4_3_PLUS')
      : (subjectCount === 'two' ? 'ADDON_A3_2_SUBJ' : 'ADDON_A3_3_PLUS');
    const addonPrice = p[addonKey] ?? 0;
    const addonLabel = subjectCount === 'two' ? '2nd subject add-on' : '3+ subjects add-on';
    breakdown.push({ label: addonLabel, amount: addonPrice });
  }

  // 3. Frame add-on — only when customer chose a frame
  if (frameType !== 'without_frame') {
    const frameKey = frameType === 'plastic_frame'
      ? (paperSize === 'A4' ? 'FRAME_CLASSIC_A4' : 'FRAME_CLASSIC_A3')
      : (paperSize === 'A4' ? 'FRAME_PREMIUM_A4' : 'FRAME_PREMIUM_A3');
    const framePrice = p[frameKey] ?? 0;
    const frameLabel = frameType === 'plastic_frame' ? 'Classic frame' : 'Premium frame';
    breakdown.push({ label: frameLabel, amount: framePrice });
  }

  // 4. Delivery fee — only for courier (pickup is free)
  if (pickupOption === 'courier') {
    const deliveryPrice = p['DELIVERY_STANDARD'] ?? 0;
    breakdown.push({ label: 'Standard delivery', amount: deliveryPrice });
  }

  // 5. Urgent handling fee — only when rush order
  if (isUrgent) {
    const urgentPrice = p['URGENT_ORDER'] ?? 0;
    breakdown.push({ label: 'Urgent handling fee', amount: urgentPrice });
  }

  const total = breakdown.reduce((sum, row) => sum + row.amount, 0);
  return { breakdown, total };
}

module.exports = { calculatePrice, loadPrices };