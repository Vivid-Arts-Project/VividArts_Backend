const express = require('express');
const router = express.Router();

function getPaymentStore(req) {
  if (!req.app.locals.paymentStore) {
    req.app.locals.paymentStore = [];
  }
  return req.app.locals.paymentStore;
}

function getBasePrices() {
  return {
    base: 3800,
    frame: 800,
    people: 500,
    depositRate: 0.5,
  };
}

function calculateAmount(body = {}) {
  const base = Number(body.amount ?? getBasePrices().base);
  const frame = body.frame === 'premium' ? 1500 : body.frame === 'classic' ? 800 : 0;
  const people = Math.max(0, Number(body.people || 1) - 1) * getBasePrices().people;
  return Math.round(base + frame + people);
}

router.get('/prices', (req, res) => {
  res.json({
    success: true,
    prices: getBasePrices(),
  });
});

router.post('/create-order', (req, res) => {
  const orderId = `ORD-${Date.now()}`;
  const amount = calculateAmount(req.body);
  const order = {
    orderId,
    status: 'pending',
    currency: req.body.currency || 'LKR',
    paymentMethod: req.body.paymentMethod || 'card',
    bankDetails: req.body.bankDetails || null,
    amount,
    createdAt: new Date().toISOString(),
  };

  getPaymentStore(req).push(order);

  res.json({
    success: true,
    payment: {
      orderId,
      status: 'pending',
      amount,
    },
  });
});

router.post('/process', (req, res) => {
  const { orderId, amount, currency, paymentMethod, bankDetails } = req.body;
  const store = getPaymentStore(req);
  let order = store.find((item) => item.orderId === orderId);

  if (!order) {
    order = {
      orderId: orderId || `ORD-${Date.now()}`,
      status: 'completed',
      currency: currency || 'LKR',
      paymentMethod: paymentMethod || 'card',
      bankDetails: bankDetails || null,
      amount: Number(amount || 0),
      createdAt: new Date().toISOString(),
    };
    store.push(order);
  } else {
    order.status = 'completed';
    order.currency = currency || order.currency;
    order.paymentMethod = paymentMethod || order.paymentMethod;
    order.bankDetails = bankDetails || order.bankDetails;
    order.amount = Number(amount || order.amount);
    order.updatedAt = new Date().toISOString();
  }

  res.json({
    success: true,
    payment: {
      orderId: order.orderId,
      status: 'completed',
      amount: order.amount,
    },
  });
});

router.post('/create-payhere-checkout', (req, res) => {
  const orderId = `PAYHERE-${Date.now()}`;
  const order = {
    orderId,
    status: 'submitted',
    currency: req.body.currency || 'LKR',
    customer: req.body.customer || {},
    createdAt: new Date().toISOString(),
  };

  getPaymentStore(req).push(order);

  res.json({
    success: true,
    orderId,
    checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout',
    checkoutFields: {
      merchant_id: '122XXXX',
      return_url: 'http://localhost:3000/payment?payment=success',
      cancel_url: 'http://localhost:3000/payment?payment=cancelled',
      order_id: orderId,
      amount: '1900',
      currency: 'LKR',
      items: 'Pencil Portrait Deposit',
      first_name: req.body.customer?.firstName || 'Vivid',
      last_name: req.body.customer?.lastName || 'Arts',
      email: req.body.customer?.email || 'customer@example.com',
      phone: req.body.customer?.phone || '0770000000',
      address: req.body.customer?.address || 'Colombo',
      city: req.body.customer?.city || 'Colombo',
      country: req.body.customer?.country || 'Sri Lanka',
    },
  });
});

router.get('/status/:orderId', (req, res) => {
  const order = getPaymentStore(req).find((item) => item.orderId === req.params.orderId);

  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found' });
  }

  res.json({ success: true, payment: order });
});

router.get('/', (req, res) => {
  res.json({ success: true, payments: getPaymentStore(req) });
});

module.exports = router;
