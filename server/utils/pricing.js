// Mirrors the catalog in AACMS_FrontEnd/src/pages/CustomisePage.jsx.
// Amounts are always recomputed here from sizeId/frameId/people — the
// client-submitted total is never trusted directly for a payment charge.

const SIZES = {
  A4: { label: 'A4', price: 2500 },
  A3: { label: 'A3', price: 3800 },
};

const FRAMES = {
  none: { label: 'No Frame', price: 0 },
  classic: { label: 'Classic', price: 800 },
  premium: { label: 'Premium', price: 1500 },
};

const EXTRA_PERSON_PRICE = 500;
const MAX_PEOPLE = 10;

function calculateOrder(order = {}) {
  const sizeId = SIZES[order.sizeId] ? order.sizeId : 'A3';
  const frameId = FRAMES[order.frameId] ? order.frameId : 'classic';

  const peopleRaw = Number(order.people);
  const people = Number.isFinite(peopleRaw) && peopleRaw >= 1
    ? Math.min(Math.floor(peopleRaw), MAX_PEOPLE)
    : 1;

  const basePrice = SIZES[sizeId].price;
  const framePrice = FRAMES[frameId].price;
  const peoplePrice = Math.max(0, people - 1) * EXTRA_PERSON_PRICE;
  const total = basePrice + framePrice + peoplePrice;
  const dueAmount = Math.round(total * 0.5);

  return {
    sizeId,
    sizeLabel: SIZES[sizeId].label,
    frameId,
    frameLabel: FRAMES[frameId].label,
    people,
    basePrice,
    framePrice,
    peoplePrice,
    total,
    dueAmount,
    notes: typeof order.notes === 'string' ? order.notes.slice(0, 500) : '',
  };
}

module.exports = { SIZES, FRAMES, EXTRA_PERSON_PRICE, calculateOrder };
