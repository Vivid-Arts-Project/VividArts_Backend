// Single source of truth for customer, payment, invoice, and admin pricing.
const db = require('../models');

const DEFAULT_PRICE_ROWS = [
  { category: 'BASE_PRICE', itemKey: 'BASE_A4_1_SUBJ', description: 'A4 portrait - 1 subject', price: 2000 },
  { category: 'BASE_PRICE', itemKey: 'BASE_A3_1_SUBJ', description: 'A3 portrait - 1 subject', price: 3500 },
  { category: 'SUBJECT_ADDON', itemKey: 'SUBJECT_ADDON_A4', description: 'Each additional A4 subject', price: 500 },
  { category: 'SUBJECT_ADDON', itemKey: 'SUBJECT_ADDON_A3', description: 'Each additional A3 subject', price: 750 },
  { category: 'FRAME', itemKey: 'FRAME_CLASSIC_A4', description: 'A4 classic frame', price: 1000 },
  { category: 'FRAME', itemKey: 'FRAME_PREMIUM_A4', description: 'A4 premium frame', price: 1500 },
  { category: 'FRAME', itemKey: 'FRAME_CLASSIC_A3', description: 'A3 classic frame', price: 1800 },
  { category: 'FRAME', itemKey: 'FRAME_PREMIUM_A3', description: 'A3 premium frame', price: 2400 },
  { category: 'SERVICE', itemKey: 'DELIVERY_STANDARD', description: 'Delivery charge', price: 500 },
  { category: 'SERVICE', itemKey: 'URGENT_ORDER', description: 'Urgent order charge', price: 500 },
];

let catalogReadyPromise;

async function ensurePriceCatalog() {
  if (!catalogReadyPromise) {
    catalogReadyPromise = (async () => {
      await db.PriceConfig.sync();
      for (const row of DEFAULT_PRICE_ROWS) {
        await db.PriceConfig.findOrCreate({ where: { itemKey: row.itemKey }, defaults: { ...row, isActive: true } });
      }
    })().catch((error) => {
      catalogReadyPromise = null;
      throw error;
    });
  }
  return catalogReadyPromise;
}

async function loadPrices() {
  await ensurePriceCatalog();
  const rows = await db.PriceConfig.findAll({ where: { isActive: true } });
  return Object.fromEntries(rows.map((row) => [row.itemKey, Number(row.price)]));
}

async function getCatalog() {
  const p = await loadPrices();
  return {
    currency: 'LKR',
    sizes: {
      A4: { label: 'A4', price: p.BASE_A4_1_SUBJ ?? 0, extraPersonPrice: p.SUBJECT_ADDON_A4 ?? 0 },
      A3: { label: 'A3', price: p.BASE_A3_1_SUBJ ?? 0, extraPersonPrice: p.SUBJECT_ADDON_A3 ?? 0 },
    },
    frames: {
      none: { label: 'No Frame', prices: { A4: 0, A3: 0 } },
      classic: { label: 'Classic', prices: { A4: p.FRAME_CLASSIC_A4 ?? 0, A3: p.FRAME_CLASSIC_A3 ?? 0 } },
      premium: { label: 'Premium', prices: { A4: p.FRAME_PREMIUM_A4 ?? 0, A3: p.FRAME_PREMIUM_A3 ?? 0 } },
    },
    deliveryPrice: p.DELIVERY_STANDARD ?? 0,
    urgentPrice: p.URGENT_ORDER ?? 0,
  };
}

async function calculateOrder(order = {}) {
  const catalog = await getCatalog();
  const sizeId = catalog.sizes[order.sizeId] ? order.sizeId : 'A3';
  const frameId = catalog.frames[order.frameId] ? order.frameId : 'classic';
  const rawPeople = Number(order.people);
  const people = Number.isFinite(rawPeople) && rawPeople >= 1 ? Math.min(Math.floor(rawPeople), 10) : 1;
  const urgent = order.urgent === true || order.isUrgent === true;
  const urgentDeadline = urgent && /^\d{4}-\d{2}-\d{2}$/.test(order.urgentDeadline || '')
    ? order.urgentDeadline
    : null;
  const deliveryMethod = order.deliveryMethod === 'pickup' ? 'pickup' : 'courier';
  const size = catalog.sizes[sizeId];
  const frame = catalog.frames[frameId];
  const basePrice = size.price;
  const extraPersonPrice = size.extraPersonPrice;
  const framePrice = frame.prices[sizeId];
  const peoplePrice = (people - 1) * extraPersonPrice;
  const deliveryPrice = deliveryMethod === 'courier' ? catalog.deliveryPrice : 0;
  const urgentPrice = urgent ? catalog.urgentPrice : 0;
  const total = basePrice + framePrice + peoplePrice + deliveryPrice + urgentPrice;

  return {
    sizeId, sizeLabel: size.label, frameId, frameLabel: frame.label, people, deliveryMethod, urgent, urgentDeadline,
    basePrice, extraPersonPrice, framePrice, peoplePrice, deliveryPrice, urgentPrice,
    total, dueAmount: Math.round(total * 0.5),
    notes: typeof order.notes === 'string' ? order.notes.slice(0, 500) : '',
  };
}

module.exports = { DEFAULT_PRICE_ROWS, ensurePriceCatalog, loadPrices, getCatalog, calculateOrder };
