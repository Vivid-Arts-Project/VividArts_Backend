const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { paginationFrom, paginationMeta } = require('../utils/pagination');
const db = require('../models');
const { Payment } = db;
const { ensureInvoiceGenerated } = require('../utils/invoice');
const { getCatalog, calculateOrder } = require('../utils/pricing');
const { protect } = require('../middleware/authMiddleware');
const { uploadReferences, deleteImage } = require('../middleware/upload');
const { createAdminNotification } = require('../utils/adminNotificationHelper');
const { ACTIVE_STATUSES, buildTimelinePreview } = require('../utils/scheduling');
const { balanceCheckoutDecision, paymentCallbackDecision, paymentSummary } = require('../utils/paymentRules');

const requireAdmin = (req, res, next) => {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const requireCustomer = (req, res, next) => {
  protect(req, res, () => {
    req.customerId = req.user.customerId;
    next();
  });
};

const requirePaymentViewer = (req, res, next) => {
  if (req.session?.adminId) {
    req.isAdminViewer = true;
    return next();
  }
  return requireCustomer(req, res, next);
};

const requireOwnedPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ where: { payhereOrderId: req.params.orderId } });
    if (!payment) return res.status(404).json({ success: false, error: 'Order not found' });
    if (req.isAdminViewer) {
      req.payment = payment;
      return next();
    }
    const order = payment.order_id && await db.Order.findOne({
      where: { order_id: payment.order_id, customer_id: req.customerId },
      attributes: ['order_id'],
    });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    req.payment = payment;
    next();
  } catch (error) {
    next(error);
  }
};

// Currency rates
const CURRENCIES = {
  LKR: { rate: 1, symbol: 'Rs' },
  USD: { rate: 0.0031, symbol: '$' },
  AED: { rate: 0.011, symbol: 'د.إ' },
  GBP: { rate: 0.0024, symbol: '£' }
};

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_MERCHANT_SECRET = process.env.PAYHERE_MERCHANT_SECRET;
const PAYHERE_CHECKOUT_URL = process.env.PAYHERE_SANDBOX === 'false'
  ? 'https://www.payhere.lk/pay/checkout'
  : 'https://sandbox.payhere.lk/pay/checkout';
const PAYHERE_ALLOWED_CURRENCIES = (process.env.PAYHERE_ALLOWED_CURRENCIES || 'LKR')
  .split(',')
  .map((currency) => currency.trim().toUpperCase())
  .filter(Boolean);

const createOrderId = () => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const URGENT_ORDER_LIMIT = 2;
const URGENT_WINDOW_DAYS = 10;

const getUrgentAvailability = async (transaction) => {
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - URGENT_WINDOW_DAYS);
  const accepted = await db.Order.count({
    where: { is_urgent: true, createdAt: { [db.Sequelize.Op.gte]: windowStart } },
    transaction,
  });
  return {
    limit: URGENT_ORDER_LIMIT,
    windowDays: URGENT_WINDOW_DAYS,
    accepted,
    remaining: Math.max(0, URGENT_ORDER_LIMIT - accepted),
  };
};

const assertUrgentAvailability = async (computedOrder, transaction) => {
  if (!computedOrder.urgent) return;
  const availability = await getUrgentAvailability(transaction);
  if (availability.remaining === 0) {
    const error = new Error('Urgent-order capacity is currently full. Only 2 urgent orders can be accepted in each 10-day period. Please choose a standard order or contact us for the next available urgent date.');
    error.statusCode = 409;
    error.code = 'URGENT_CAPACITY_FULL';
    throw error;
  }
};

const createCommission = async (req, computedOrder, payment) => {
  const customerId = req.customerId;
  return db.sequelize.transaction(async transaction => {
    await assertUrgentAvailability(computedOrder, transaction);
    const product = await db.ProductOption.create({
      paper_size: computedOrder.sizeId, num_subjects: computedOrder.people,
      frame_type: computedOrder.frameId === 'none' ? 'without_frame' : computedOrder.frameId === 'premium' ? 'wooden_frame' : 'plastic_frame',
      pickup_option: computedOrder.deliveryMethod, is_urgent: computedOrder.urgent,
      urgent_deadline: computedOrder.urgentDeadline, customer_note: computedOrder.notes,
    }, { transaction });
    const order = await db.Order.create({ customer_id: customerId, product_id: product.product_id,
      calculated_price: computedOrder.total, payment_type: 'advance', amount_paid: 0,
      status: 'in_queue', is_urgent: computedOrder.urgent }, { transaction });
    await payment.update({ order_id: order.order_id }, { transaction });
    return order;
  });
};

router.post('/orders/:id/reference-photos', requireCustomer, async (req, res) => {
  const order = await db.Order.findOne({
    where: { order_id: req.params.id, customer_id: req.customerId },
    attributes: ['order_id'],
  }).catch(error => {
    res.status(500).json({ success: false, error: error.message });
    return null;
  });
  if (res.headersSent) return;
  if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

  uploadReferences(req, res, async uploadError => {
    if (uploadError) return res.status(400).json({ success: false, error: uploadError.message });
    if (!req.files?.length) return res.status(400).json({ success: false, error: 'Select at least one reference photo' });

    try {
      const existingCount = await db.ReferencePhoto.count({ where: { order_id: order.order_id } });
      if (existingCount + req.files.length > 5) {
        await Promise.all(req.files.map(file => deleteImage(file.filename).catch(() => {})));
        return res.status(400).json({ success: false, error: 'An order can have up to 5 reference photos' });
      }

      const photos = await db.ReferencePhoto.bulkCreate(req.files.map((file, index) => ({
        order_id: order.order_id,
        cloudinary_url: file.path,
        cloudinary_public_id: file.filename,
        original_filename: file.originalname,
        file_size_bytes: file.size,
        mime_type: file.mimetype,
        sort_order: existingCount + index,
      })));
      res.status(201).json({ success: true, photos: photos.map(photo => photo.cloudinary_url) });
    } catch (error) {
      await Promise.all(req.files.map(file => deleteImage(file.filename).catch(() => {})));
      res.status(500).json({ success: false, error: 'Unable to save reference photos' });
    }
  });
});

const isPlaceholderValue = (value) => !value || String(value).trim().toLowerCase().startsWith('your');

const validatePayhereConfig = () => {
  if (isPlaceholderValue(PAYHERE_MERCHANT_ID) || isPlaceholderValue(PAYHERE_MERCHANT_SECRET)) {
    return 'Add your real PayHere sandbox merchant ID and merchant secret to server/.env';
  }

  if (isPlaceholderValue(BACKEND_URL)) {
    return 'Set BACKEND_URL in server/.env to your public backend URL. Use ngrok for local PayHere testing.';
  }

  if (!/^https?:\/\//.test(FRONTEND_URL) || !/^https?:\/\//.test(BACKEND_URL)) {
    return 'FRONTEND_URL and BACKEND_URL must start with http:// or https://';
  }

  return null;
};

const calculateDisplayAmount = (amount, currency) => {
  const rate = CURRENCIES[currency]?.rate || 1;
  return (amount * rate).toFixed(2);
};

const md5Upper = (value) => crypto.createHash('md5').update(value).digest('hex').toUpperCase();

const createPayhereCheckoutHash = ({ merchantId, orderId, amount, currency, merchantSecret }) => {
  const hashedSecret = md5Upper(merchantSecret);
  return md5Upper(`${merchantId}${orderId}${amount}${currency}${hashedSecret}`);
};

const createPayhereNotifyHash = ({ merchantId, orderId, amount, currency, statusCode, merchantSecret }) => {
  const hashedSecret = md5Upper(merchantSecret);
  return md5Upper(`${merchantId}${orderId}${amount}${currency}${statusCode}${hashedSecret}`);
};

const mapPayhereStatus = (statusCode) => {
  if (String(statusCode) === '2') return 'completed';
  if (String(statusCode) === '-1' || String(statusCode) === '-2' || String(statusCode) === '-3') return 'failed';
  return 'pending';
};

const syncLinkedOrderPayment = async (payment) => {
  if (!payment.order_id) return;
  const completed = await Payment.sum('amount', {
    where: { order_id: payment.order_id, status: 'completed' },
  });
  const order = await db.Order.findByPk(payment.order_id, { attributes: ['calculated_price'] });
  const paidInFull = order && Number(completed || 0) >= Number(order.calculated_price || 0);
  await db.Order.update(
    { amount_paid: Number(completed || 0), payment_type: paidInFull ? 'full' : 'advance' },
    { where: { order_id: payment.order_id } },
  );
};

// ============= ROUTES =============

// Current position for the next portrait entering the production queue.
// Completed (`done`) orders no longer occupy a queue slot.
router.get('/queue-position', requireCustomer, async (_req, res) => {
  try {
    const activeOrders = await db.Order.count({
      where: { status: { [db.Sequelize.Op.ne]: 'done' } },
    });

    res.json({
      success: true,
      activeOrders,
      queuePosition: activeOrders + 1,
    });
  } catch (error) {
    console.error('Error fetching queue position:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch queue position' });
  }
});

// 1. Create Payment Order
router.post('/create-order', requireCustomer, async (req, res) => {
  try {
    const { currency, paymentMethod, bankDetails, order } = req.body;
    const computedOrder = await calculateOrder(order);
    await assertUrgentAvailability(computedOrder);

    const orderData = {
      payhereOrderId: createOrderId(),
      amount: computedOrder.dueAmount,
      currency: currency || 'LKR',
      paymentMethod: paymentMethod || 'card',
      status: 'pending',
      metadata: { order: computedOrder },
      ...(paymentMethod === 'bank' && bankDetails ? {
        bankName: bankDetails.bankName || null
      } : {})
    };

    const payment = await Payment.create(orderData);
    const commission = await createCommission(req, computedOrder, payment);
    await createAdminNotification({
      orderId: commission.order_id,
      type: 'order',
      title: 'New portrait order',
      message: `A new ${computedOrder.sizeLabel || computedOrder.sizeId} portrait order was placed.`,
    });

    res.status(201).json({
      success: true,
      payment: {
        id: payment.paymentId,
        orderId: payment.payhereOrderId,
        commissionId: commission.order_id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status
      }
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Failed to create order',
      code: error.code,
    });
  }
});

// 2. Create PayHere checkout payload for card payments
router.post('/create-payhere-checkout', requireCustomer, async (req, res) => {
  try {
    const configError = validatePayhereConfig();
    if (configError) {
      return res.status(500).json({
        success: false,
        error: configError
      });
    }

    const { currency = 'LKR', customer = {}, order } = req.body;
    const selectedCurrency = CURRENCIES[currency] ? currency : 'LKR';
    if (!PAYHERE_ALLOWED_CURRENCIES.includes(selectedCurrency)) {
      return res.status(400).json({
        success: false,
        error: `PayHere is configured for ${PAYHERE_ALLOWED_CURRENCIES.join(', ')} only. Select LKR or add the currency to PAYHERE_ALLOWED_CURRENCIES after PayHere enables it.`
      });
    }

    const computedOrder = await calculateOrder(order);
    await assertUrgentAvailability(computedOrder);
    const gatewayAmount = calculateDisplayAmount(computedOrder.dueAmount, selectedCurrency);

    const payment = await Payment.create({
      payhereOrderId: createOrderId(),
      amount: computedOrder.dueAmount,
      currency: selectedCurrency,
      paymentMethod: 'card',
      status: 'pending'
    });
    const commission = await createCommission(req, computedOrder, payment);
    await createAdminNotification({
      orderId: commission.order_id,
      type: 'order',
      title: 'New portrait order',
      message: `A new ${computedOrder.sizeLabel || computedOrder.sizeId} portrait order was placed.`,
    });

    const hash = createPayhereCheckoutHash({
      merchantId: PAYHERE_MERCHANT_ID,
      orderId: payment.payhereOrderId,
      amount: gatewayAmount,
      currency: selectedCurrency,
      merchantSecret: PAYHERE_MERCHANT_SECRET
    });

    const checkoutFields = {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${FRONTEND_URL}/commission/payment?payment=success&order_id=${payment.payhereOrderId}`,
      cancel_url: `${FRONTEND_URL}/commission/payment?payment=cancelled&order_id=${payment.payhereOrderId}`,
      notify_url: `${BACKEND_URL}/api/payments/payhere-notify`,
      order_id: payment.payhereOrderId,
      items: 'Vivid Arts portrait deposit',
      currency: selectedCurrency,
      amount: gatewayAmount,
      first_name: customer.firstName || 'Vivid',
      last_name: customer.lastName || '-',
      email: customer.email || 'customer@example.com',
      phone: customer.phone || '0771234567',
      address: customer.address || 'Colombo',
      city: customer.city || 'Colombo',
      country: customer.country || 'Sri Lanka',
      hash
    };

    await payment.update({
      payhereMd5sig: hash,
      metadata: {
        checkoutAmount: gatewayAmount,
        checkoutCurrency: selectedCurrency,
        order: computedOrder,
        customer: {
          firstName: customer.firstName || 'Vivid',
          lastName: customer.lastName || null,
          email: customer.email || null,
          phone: customer.phone || null,
          address: customer.address || null,
          city: customer.city || null,
          country: customer.country || null
        }
      }
    });

    await syncLinkedOrderPayment(payment);

    res.status(201).json({
      success: true,
      checkoutUrl: PAYHERE_CHECKOUT_URL,
      checkoutFields,
      orderId: payment.payhereOrderId
      , commissionId: commission.order_id
    });
  } catch (error) {
    console.error('Error creating PayHere checkout:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Failed to create PayHere checkout',
      code: error.code,
    });
  }
});

router.post('/timeline-preview', requireCustomer, async (req, res) => {
  try {
    const orders = await db.Order.findAll({
      where: { status: { [db.Sequelize.Op.in]: ACTIVE_STATUSES } },
      include: [{ model: db.ProductOption, as: 'productOption' }],
    });
    const proposedOrder = {
      urgent: req.body?.urgent === true,
      urgentDeadline: req.body?.urgentDeadline || null,
      people: req.body?.people,
      deliveryMethod: req.body?.deliveryMethod === 'pickup' ? 'pickup' : 'courier',
    };
    res.json({ success: true, timeline: buildTimelinePreview(orders, proposedOrder) });
  } catch (error) {
    console.error('Error calculating timeline preview:', error);
    res.status(500).json({ success: false, error: 'Failed to calculate the estimated timeline' });
  }
});

router.get('/urgent-availability', async (_req, res) => {
  try {
    const availability = await getUrgentAvailability();
    res.json({ success: true, ...availability, available: availability.remaining > 0 });
  } catch (error) {
    console.error('Error fetching urgent-order availability:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch urgent-order availability' });
  }
});

// Pay the outstanding balance for an existing, customer-approved order.
router.post('/orders/:id/balance-checkout', requireCustomer, async (req, res) => {
  try {
    const configError = validatePayhereConfig();
    if (configError) return res.status(500).json({ success: false, error: configError });

    const newPayhereOrderId = createOrderId();
    const checkout = await db.sequelize.transaction(async transaction => {
      const order = await db.Order.findOne({
        where: { order_id: req.params.id, customer_id: req.customerId },
        include: [{ model: db.Customer, as: 'customer' }],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!order) {
        const error = new Error('Order not found');
        error.statusCode = 404;
        throw error;
      }
      const payments = await Payment.findAll({
        where: { order_id: order.order_id },
        order: [['paymentId', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const decision = balanceCheckoutDecision({
        orderStatus: order.status,
        total: order.calculated_price,
        payments,
      });
      const currency = order.currency || 'LKR';
      if (!PAYHERE_ALLOWED_CURRENCIES.includes(currency)) {
        const error = new Error(`PayHere is not configured for ${currency}`);
        error.statusCode = 400;
        throw error;
      }
      let payment = decision.reusablePayment;
      if (payment) {
        await payment.update({
          payhereOrderId: newPayhereOrderId,
          amount: decision.balance,
          currency,
          paymentMethod: 'card',
          status: 'pending',
          completedAt: null,
          transactionId: null,
          payherePaymentId: null,
        }, { transaction });
      } else {
        payment = await Payment.create({
          payhereOrderId: newPayhereOrderId,
          order_id: order.order_id,
          amount: decision.balance,
          currency,
          paymentMethod: 'card',
          paymentType: 'full',
          status: 'pending',
        }, { transaction });
      }
      return { order, balance: decision.balance, payment, currency };
    });
    const { order, balance, payment, currency } = checkout;

    const gatewayAmount = calculateDisplayAmount(balance, currency);
    const hash = createPayhereCheckoutHash({
      merchantId: PAYHERE_MERCHANT_ID, orderId: payment.payhereOrderId,
      amount: gatewayAmount, currency, merchantSecret: PAYHERE_MERCHANT_SECRET,
    });
    const fullName = (order.customer?.full_name || order.customer?.username || 'Vivid Customer').trim();
    const [firstName, ...lastNameParts] = fullName.split(/\s+/);
    const checkoutFields = {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${FRONTEND_URL}/commission/payment?payment=success&order_id=${payment.payhereOrderId}`,
      cancel_url: `${FRONTEND_URL}/my-orders`,
      notify_url: `${BACKEND_URL}/api/payments/payhere-notify`,
      order_id: payment.payhereOrderId,
      items: `Vivid Arts order ${order.order_id.slice(0, 8)} balance`,
      currency, amount: gatewayAmount,
      first_name: firstName || 'Vivid', last_name: lastNameParts.join(' ') || '-',
      email: order.customer?.email || 'customer@example.com',
      phone: order.customer?.phone_number || '0771234567',
      address: order.customer?.address || 'Colombo', city: 'Colombo', country: 'Sri Lanka', hash,
    };
    await payment.update({ payhereMd5sig: hash, metadata: { balancePayment: true, checkoutAmount: gatewayAmount, checkoutCurrency: currency } });
    res.status(201).json({ success: true, checkoutUrl: PAYHERE_CHECKOUT_URL, checkoutFields, orderId: payment.payhereOrderId });
  } catch (error) {
    console.error('Error creating balance checkout:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, error: 'A balance checkout is already active for this order', code: 'BALANCE_CHECKOUT_ACTIVE' });
    }
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Failed to create balance checkout',
      code: error.code,
    });
  }
});

// 3. PayHere server notification endpoint
router.post('/payhere-notify', async (req, res) => {
  try {
    const {
      merchant_id,
      order_id,
      payment_id,
      payhere_amount,
      payhere_currency,
      status_code,
      md5sig,
      method,
      status_message
    } = req.body;

    const payment = await Payment.findOne({ where: { payhereOrderId: order_id } });

    if (!payment) {
      return res.status(404).send('Payment record not found');
    }

    const localMd5sig = createPayhereNotifyHash({
      merchantId: merchant_id,
      orderId: order_id,
      amount: payhere_amount,
      currency: payhere_currency,
      statusCode: status_code,
      merchantSecret: PAYHERE_MERCHANT_SECRET
    });

    if (localMd5sig !== md5sig) {
      if (payment.status === 'completed') return res.status(400).send('Invalid signature');
      await payment.update({
        status: 'failed',
        metadata: {
          ...(payment.metadata || {}),
          payhereStatusMessage: 'Invalid PayHere signature',
          receivedMd5sig: md5sig
        }
      });

      return res.status(400).send('Invalid signature');
    }

    const nextStatus = mapPayhereStatus(status_code);
    let callbackDecision;
    try {
      callbackDecision = paymentCallbackDecision({
        currentStatus: payment.status,
        nextStatus,
        expectedAmount: payment.amount,
        receivedAmount: payhere_amount,
        expectedCurrency: payment.currency,
        receivedCurrency: payhere_currency,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).send(error.message);
    }
    if (callbackDecision.idempotent) return res.send('OK');

    await payment.update({
      status: callbackDecision.status,
      completedAt: callbackDecision.status === 'completed' ? new Date() : null,
      transactionId: payment_id || null,
      payherePaymentId: payment_id || null,
      metadata: {
        ...(payment.metadata || {}),
        payhereAmount: payhere_amount,
        payhereCurrency: payhere_currency,
        payhereMethod: method,
        payhereStatusCode: status_code,
        payhereStatusMessage: status_message || null
      }
    });

    await syncLinkedOrderPayment(payment);

    if (payment.status === 'completed') {
      ensureInvoiceGenerated(payment).catch((err) => {
        console.error('Invoice generation failed:', err);
      });
    }

    res.send('OK');
  } catch (error) {
    console.error('PayHere notification error:', error);
    res.status(500).send('PayHere notification failed');
  }
});

// PayHere cannot post its server notification to localhost during local
// development. The browser return is therefore used only in development
// sandbox mode so the complete checkout and invoice flow can be tested.
// Production payments must always be confirmed by /payhere-notify above.
router.post('/sandbox-confirm-return/:orderId', requireCustomer, requireOwnedPayment, async (req, res) => {
  try {
    if (process.env.NODE_ENV !== 'development' || process.env.PAYHERE_SANDBOX === 'false') {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const payment = req.payment;

    if (payment.status === 'pending') {
      await payment.update({
        status: 'completed',
        completedAt: new Date(),
        transactionId: payment.transactionId || `SANDBOX-${Date.now()}`,
        metadata: {
          ...(payment.metadata || {}),
          sandboxConfirmedFromReturn: true,
        },
      });
    }

    await syncLinkedOrderPayment(payment);

    await ensureInvoiceGenerated(payment);
    res.json({
      success: true,
      payment: {
        orderId: payment.payhereOrderId,
        status: payment.status,
        transactionId: payment.transactionId,
      },
    });
  } catch (error) {
    console.error('Sandbox return confirmation error:', error);
    res.status(500).json({ success: false, error: 'Unable to confirm sandbox payment' });
  }
});

// 4. Process bank transfer payments
router.post('/process', requireCustomer, async (req, res) => {
  try {
    const { orderId, paymentMethod, bankDetails } = req.body;

    // Find the payment record
    const payment = await Payment.findOne({ where: { payhereOrderId: orderId } });
    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    const ownedOrder = payment.order_id && await db.Order.findOne({
      where: { order_id: payment.order_id, customer_id: req.customerId },
      attributes: ['order_id'],
    });
    if (!ownedOrder) return res.status(404).json({ success: false, error: 'Order not found' });

    let result;

    if (paymentMethod === 'bank') {
      // Bank transfer - generate reference
      result = {
        success: true,
        transactionId: `BT-${Date.now()}`,
        reference: `REF-${Date.now().toString().slice(-6)}`,
        bankDetails: bankDetails,
        message: 'Bank transfer initiated'
      };
    } else {
      return res.status(400).json({
        success: false,
        error: 'Use /create-payhere-checkout for card payments'
      });
    }

    // Update payment record
    await payment.update({
      status: 'completed',
      completedAt: new Date(),
      transactionId: result.transactionId,
      bankReference: result.reference || null,
      metadata: result
    });

    await syncLinkedOrderPayment(payment);

    ensureInvoiceGenerated(payment).catch((err) => {
      console.error('Invoice generation failed:', err);
    });

    res.json({
      success: true,
      payment: {
        id: payment.paymentId,
        orderId: payment.payhereOrderId,
        status: payment.status,
        transactionId: payment.transactionId,
        ...result
      }
    });
  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({
      success: false,
      error: 'Payment processing failed'
    });
  }
});

// 5. Get Prices (must be before /:orderId to avoid route conflicts)
router.get('/prices', async (req, res) => {
  try {
    const catalog = await getCatalog();
    res.json({ success: true, ...catalog, currencies: CURRENCIES });
  } catch (error) {
    console.error('Error fetching prices:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch prices' });
  }
});

// 6. Get Payment Status
router.get('/status/:orderId', requireCustomer, requireOwnedPayment, async (req, res) => {
  try {
    const payment = req.payment;

    res.json({
      success: true,
      payment: {
        orderId: payment.payhereOrderId,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        transactionId: payment.transactionId,
        payherePaymentId: payment.payherePaymentId,
        createdAt: payment.createdAt
      }
    });
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment status'
    });
  }
});

// 7. Download invoice PDF (available once payment is completed)
router.get('/:orderId/invoice', requirePaymentViewer, requireOwnedPayment, async (req, res) => {
  try {
    const payment = req.payment;

    if (payment.status !== 'completed') {
      return res.status(409).json({
        success: false,
        error: 'Invoice is only available once the payment is completed'
      });
    }

    const filePath = await ensureInvoiceGenerated(payment);
    res.download(filePath, `invoice-${payment.payhereOrderId}.pdf`);
  } catch (error) {
    console.error('Error generating invoice:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate invoice'
    });
  }
});

// 8. Get All Payments (for admin)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginationFrom(req.query);
    const [{ count, rows: payments }, completedPayments] = await Promise.all([
      Payment.findAndCountAll({
        include: [{
          model: db.Order,
          as: 'order',
          include: [{ model: db.Customer, as: 'customer' }],
        }],
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      }),
      Payment.findAll({
        where: { status: 'completed' },
        attributes: ['order_id', 'paymentType', 'amount', 'status'],
        raw: true,
      }),
    ]);
    res.json({
      success: true,
      payments,
      summary: paymentSummary(completedPayments),
      pagination: paginationMeta(count, page, limit),
    });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payments'
    });
  }
});

module.exports = router;
