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
const { ACTIVE_STATUSES, buildTimelinePreview, hasScheduledSlotConflict, requiredScheduledStart } = require('../utils/scheduling');
const { balanceCheckoutDecision, hasUsableCheckout, paymentCallbackDecision, orderStatusAfterPayment, paymentSummary } = require('../utils/paymentRules');
const { onlinePaymentMethod } = require('../utils/paymentMethod');
const { assertPayhereCallbackAuthenticity } = require('../utils/payhereSecurity');
const { hasLiveCapacityReservation, isReusableDepositCheckout } = require('../utils/capacityReservation');
const { requireAdmin } = require('./adminAuth');

const requireCustomer = (req, res, next) => {
  protect(req, res, () => {
    req.customerId = req.user.customerId;
    next();
  });
};

const requirePaymentViewer = (req, res, next) => {
  if (req.session?.adminId) {
    return requireAdmin(req, res, () => {
      req.isAdminViewer = true;
      next();
    });
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
};

// Normalize copied dashboard values so PayHere's exact-match hash stays stable.
const envValue = (name) => process.env[name]?.trim();
const FRONTEND_URL = envValue('FRONTEND_URL') || 'http://localhost:3000';
const BACKEND_URL = envValue('BACKEND_URL') || 'http://localhost:3001';
const PAYHERE_MERCHANT_ID = envValue('PAYHERE_MERCHANT_ID');
const PAYHERE_MERCHANT_SECRET = envValue('PAYHERE_MERCHANT_SECRET');
const PAYHERE_SANDBOX = (envValue('PAYHERE_SANDBOX') || 'true').toLowerCase();
const PAYHERE_INTEGRATION_DOMAIN = envValue('PAYHERE_INTEGRATION_DOMAIN')?.toLowerCase();
// The PayHere server callback may be public even when the app itself runs locally.
const PAYHERE_NOTIFY_URL = envValue('PAYHERE_NOTIFY_URL') || `${BACKEND_URL}/api/payments/payhere-notify`;
const PAYHERE_CHECKOUT_URL = PAYHERE_SANDBOX === 'false'
  ? 'https://www.payhere.lk/pay/checkout'
  : 'https://sandbox.payhere.lk/pay/checkout';
const PAYHERE_ALLOWED_CURRENCIES = ['LKR'];

const createOrderId = () => `ORD-${crypto.randomUUID()}`;
const localDateOnly = (date) => date
  ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  : null;

const URGENT_ORDER_LIMIT = 2;
const URGENT_WINDOW_DAYS = 10;
const SCHEDULED_WINDOW_DAYS = 15;
const CAPACITY_RESERVATION_MINUTES = Math.max(5, Number(process.env.CAPACITY_RESERVATION_MINUTES) || 60);

const acquireCapacityLock = async (transaction) => {
  if (!transaction) return;
  const lockRow = await db.SiteSetting.findByPk(1, {
    attributes: ['id'],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!lockRow) throw new Error('The scheduling capacity lock is not initialized');
};

const getCapacityOrders = async ({ transaction, excludeOrderId = null } = {}) => {
  const orders = await db.Order.findAll({
    where: {
      status: { [db.Sequelize.Op.in]: ACTIVE_STATUSES },
      ...(excludeOrderId ? { order_id: { [db.Sequelize.Op.ne]: excludeOrderId } } : {}),
    },
    include: [
      { model: db.ProductOption, as: 'productOption' },
      {
        model: db.Payment,
        as: 'payments',
        attributes: ['paymentType', 'status', 'updatedAt'],
        required: false,
      },
    ],
    transaction,
  });
  return orders.filter(order => hasLiveCapacityReservation(order, {
    reservationMinutes: CAPACITY_RESERVATION_MINUTES,
  }));
};

const getUrgentAvailability = async ({ transaction, excludeOrderId = null } = {}) => {
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - URGENT_WINDOW_DAYS);
  const capacityOrders = await getCapacityOrders({ transaction, excludeOrderId });
  const accepted = capacityOrders.filter(order => (
    order.is_urgent && new Date(order.createdAt) >= windowStart
  )).length;
  return {
    limit: URGENT_ORDER_LIMIT,
    windowDays: URGENT_WINDOW_DAYS,
    accepted,
    remaining: Math.max(0, URGENT_ORDER_LIMIT - accepted),
  };
};

const assertUrgentAvailability = async (computedOrder, transaction, excludeOrderId = null) => {
  if (!computedOrder.urgent) return;
  const availability = await getUrgentAvailability({ transaction, excludeOrderId });
  if (availability.remaining === 0) {
    const error = new Error('Urgent-order capacity is currently full. Only 2 urgent orders can be accepted in each 10-day period. Please choose a standard order or contact us for the next available urgent date.');
    error.statusCode = 409;
    error.code = 'URGENT_CAPACITY_FULL';
    throw error;
  }
};

const assertScheduledAvailability = async (computedOrder, transaction, excludeOrderId = null) => {
  if (!computedOrder.scheduled) return;
  const orders = await getCapacityOrders({ transaction, excludeOrderId });
  const timeline = buildTimelinePreview(orders, computedOrder);
  const conflictingOrder = hasScheduledSlotConflict(orders, computedOrder, SCHEDULED_WINDOW_DAYS);
  if (!timeline.feasible || conflictingOrder) {
    const message = conflictingOrder
      ? 'Scheduled-order availability for this 15-day production period is full. Please select a later date.'
      : timeline.unavailableReason;
    const error = new Error(message);
    error.statusCode = 409;
    error.code = 'SCHEDULED_DATE_UNAVAILABLE';
    throw error;
  }
  return { timeline, slotAvailable: true };
};

const createCommission = async (req, computedOrder, payment, transaction) => {
  const customerId = req.customerId;
  await acquireCapacityLock(transaction);
  await assertUrgentAvailability(computedOrder, transaction);
  await assertScheduledAvailability(computedOrder, transaction);
  const product = await db.ProductOption.create({
    paper_size: computedOrder.sizeId, num_subjects: computedOrder.people,
    frame_type: computedOrder.frameId === 'none' ? 'without_frame' : computedOrder.frameId === 'premium' ? 'wooden_frame' : 'plastic_frame',
    pickup_option: computedOrder.deliveryMethod, is_urgent: computedOrder.urgent,
    urgent_deadline: computedOrder.urgentDeadline, is_scheduled: computedOrder.scheduled,
    scheduled_date: computedOrder.scheduledDate,
    scheduled_start_date: computedOrder.scheduled ? localDateOnly(requiredScheduledStart(computedOrder)) : null,
    customer_note: computedOrder.notes,
  }, { transaction });
  const order = await db.Order.create({ customer_id: customerId, product_id: product.product_id,
    calculated_price: computedOrder.total, payment_type: 'advance', amount_paid: 0,
    status: 'in_queue', is_urgent: computedOrder.urgent, is_scheduled: computedOrder.scheduled }, { transaction });
  await payment.update({ order_id: order.order_id }, { transaction });
  return order;
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
      const photos = await db.sequelize.transaction(async transaction => {
        const lockedOrder = await db.Order.findOne({
          where: { order_id: order.order_id, customer_id: req.customerId },
          attributes: ['order_id', 'status', 'amount_paid'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!lockedOrder) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        if (lockedOrder.status !== 'in_queue' || Number(lockedOrder.amount_paid || 0) > 0) {
          throw Object.assign(new Error('Reference photos can only be added before the deposit is paid'), { statusCode: 409 });
        }
        const existingCount = await db.ReferencePhoto.count({
          where: { order_id: lockedOrder.order_id },
          transaction,
        });
        if (existingCount + req.files.length > 5) {
          throw Object.assign(new Error('An order can have up to 5 reference photos'), { statusCode: 400 });
        }
        return db.ReferencePhoto.bulkCreate(req.files.map((file, index) => ({
          order_id: lockedOrder.order_id,
          cloudinary_url: file.path,
          cloudinary_public_id: file.filename,
          original_filename: file.originalname,
          file_size_bytes: file.size,
          mime_type: file.mimetype,
          sort_order: existingCount + index,
        })), { transaction });
      });
      res.status(201).json({ success: true, photos: photos.map(photo => photo.cloudinary_url) });
    } catch (error) {
      await Promise.all(req.files.map(file => deleteImage(file.filename).catch(() => {})));
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.statusCode ? error.message : 'Unable to save reference photos',
      });
    }
  });
});

const isPlaceholderValue = (value) => !value || /^(your|replace[-_ ]with)/i.test(String(value).trim());

const validatePayhereConfig = () => {
  if (isPlaceholderValue(PAYHERE_MERCHANT_ID) || isPlaceholderValue(PAYHERE_MERCHANT_SECRET)) {
    return 'Add your real PayHere sandbox merchant ID and merchant secret to server/.env';
  }

  if (!/^\d{7}$/.test(PAYHERE_MERCHANT_ID)) {
    return 'PAYHERE_MERCHANT_ID must be the 7-digit Merchant ID from the selected PayHere account';
  }

  if (!['true', 'false'].includes(PAYHERE_SANDBOX)) {
    return 'PAYHERE_SANDBOX must be either true or false';
  }

  if (isPlaceholderValue(BACKEND_URL)) {
    return 'Set BACKEND_URL in server/.env to your public backend URL. Use ngrok for local PayHere testing.';
  }

  if (![FRONTEND_URL, BACKEND_URL, PAYHERE_NOTIFY_URL].every((url) => /^https?:\/\//.test(url))) {
    return 'FRONTEND_URL, BACKEND_URL, and PAYHERE_NOTIFY_URL must start with http:// or https://';
  }

  if (PAYHERE_INTEGRATION_DOMAIN) {
    const frontendHostname = new URL(FRONTEND_URL).hostname.toLowerCase();
    if (frontendHostname !== PAYHERE_INTEGRATION_DOMAIN) {
      return `FRONTEND_URL must use the approved PayHere integration domain (${PAYHERE_INTEGRATION_DOMAIN})`;
    }
  }

  return null;
};

const validatePayhereCallbackConfig = () => {
  if (isPlaceholderValue(PAYHERE_MERCHANT_ID) || isPlaceholderValue(PAYHERE_MERCHANT_SECRET)) {
    return 'PayHere callback credentials are not configured';
  }
  if (!/^\d{7}$/.test(PAYHERE_MERCHANT_ID)) return 'PayHere merchant ID is invalid';
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

const syncLinkedOrderPayment = async (payment, transaction) => {
  if (!payment.order_id) return;
  const order = await db.Order.findByPk(payment.order_id, {
    attributes: ['calculated_price', 'status'],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!order) return;
  const completed = await Payment.sum('amount', {
    where: { order_id: payment.order_id, status: 'completed' },
    transaction,
  });
  const paidInFull = order && Number(completed || 0) >= Number(order.calculated_price || 0);
  await db.Order.update(
    {
      amount_paid: Number(completed || 0),
      payment_type: paidInFull ? 'full' : 'advance',
      status: orderStatusAfterPayment(order.status, paidInFull),
    },
    { where: { order_id: payment.order_id }, transaction },
  );
};

const completeInitialOrderPayment = async (payment) => {
  if (payment.status !== 'completed' || payment.metadata?.balancePayment) return;

  const computedOrder = payment.metadata?.order || {};
  await createAdminNotification({
    orderId: payment.order_id,
    type: computedOrder.scheduled ? 'scheduled_order' : 'order',
    title: computedOrder.scheduled ? 'New scheduled portrait order' : 'New portrait order',
    message: computedOrder.scheduled
      ? `A scheduled portrait order was confirmed for ${computedOrder.scheduledDate}. Its production slot has been reserved.`
      : `A new ${computedOrder.sizeLabel || computedOrder.sizeId || ''} portrait order was paid and confirmed.`.replace('new  portrait', 'new portrait'),
  });
};

const buildInitialCheckout = ({ payment, customer = {} }) => {
  const gatewayAmount = calculateDisplayAmount(payment.amount, payment.currency);
  const hash = createPayhereCheckoutHash({
    merchantId: PAYHERE_MERCHANT_ID,
    orderId: payment.payhereOrderId,
    amount: gatewayAmount,
    currency: payment.currency,
    merchantSecret: PAYHERE_MERCHANT_SECRET,
  });
  return {
    hash,
    gatewayAmount,
    fields: {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${FRONTEND_URL}/commission/payment?payment=success&order_id=${payment.payhereOrderId}`,
      cancel_url: `${FRONTEND_URL}/commission/payment?payment=cancelled&order_id=${payment.payhereOrderId}`,
      notify_url: PAYHERE_NOTIFY_URL,
      order_id: payment.payhereOrderId,
      items: 'Vivid Arts portrait deposit',
      currency: payment.currency,
      amount: gatewayAmount,
      first_name: customer.firstName || 'Vivid',
      last_name: customer.lastName || '-',
      email: customer.email || 'customer@example.com',
      phone: customer.phone || '0771234567',
      address: customer.address || 'Colombo',
      city: customer.city || 'Colombo',
      country: customer.country || 'Sri Lanka',
      hash,
    },
  };
};

// ============= ROUTES =============

// Current position for the next portrait entering the production queue.
// Completed (`done`) orders no longer occupy a queue slot.
router.get('/queue-position', requireCustomer, async (_req, res) => {
  try {
    const activeOrders = await db.Order.count({
      where: {
        status: { [db.Sequelize.Op.notIn]: ['done', 'cancelled'] },
        amount_paid: { [db.Sequelize.Op.gt]: 0 },
      },
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
    const { currency, paymentMethod, order, customer = {} } = req.body;
    const selectedPaymentMethod = onlinePaymentMethod(paymentMethod);
    const selectedCurrency = String(currency || 'LKR').trim().toUpperCase();
    if (!PAYHERE_ALLOWED_CURRENCIES.includes(selectedCurrency)) {
      return res.status(400).json({
        success: false,
        error: `PayHere is configured for ${PAYHERE_ALLOWED_CURRENCIES.join(', ')} only.`,
        code: 'UNSUPPORTED_PAYMENT_CURRENCY',
      });
    }
    const computedOrder = await calculateOrder(order);

    const orderData = {
      payhereOrderId: createOrderId(),
      amount: computedOrder.dueAmount,
      currency: selectedCurrency,
      paymentMethod: selectedPaymentMethod,
      status: 'pending',
      metadata: {
        order: computedOrder,
        customer: {
          firstName: customer.firstName || null,
          lastName: customer.lastName || null,
          email: customer.email || null,
          phone: customer.phone || null,
          address: customer.address || null,
          city: customer.city || null,
          country: customer.country || null,
        },
      },
    };

    const { payment, commission } = await db.sequelize.transaction(async transaction => {
      const createdPayment = await Payment.create(orderData, { transaction });
      const createdCommission = await createCommission(req, computedOrder, createdPayment, transaction);
      return { payment: createdPayment, commission: createdCommission };
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

// Re-open the deposit checkout for a commission that the customer left unpaid.
router.post('/orders/:id/resume-checkout', requireCustomer, async (req, res) => {
  try {
    const configError = validatePayhereConfig();
    if (configError) return res.status(500).json({ success: false, error: configError });

    const { order, payment, fields, reused } = await db.sequelize.transaction(async transaction => {
      await acquireCapacityLock(transaction);
      const lockedOrder = await db.Order.findOne({
        where: { order_id: req.params.id, customer_id: req.customerId },
        include: [
          { model: db.Payment, as: 'payments' },
          { model: db.Customer, as: 'customer' },
          { model: db.ProductOption, as: 'productOption' },
        ],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lockedOrder) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      if (lockedOrder.status === 'cancelled') throw Object.assign(new Error('This order was cancelled and cannot accept payment'), { statusCode: 409 });
      if (Number(lockedOrder.amount_paid || 0) > 0) {
        throw Object.assign(new Error('The deposit for this order is already paid'), { statusCode: 400 });
      }

      const lockedPayment = lockedOrder.payments?.find(item => item.paymentType === 'advance');
      if (!lockedPayment || lockedPayment.status === 'completed') {
        throw Object.assign(new Error('No pending deposit was found for this order'), { statusCode: 400 });
      }
      const capacityRequest = {
        urgent: Boolean(lockedOrder.is_urgent || lockedOrder.productOption?.is_urgent),
        scheduled: Boolean(lockedOrder.is_scheduled || lockedOrder.productOption?.is_scheduled),
        scheduledDate: lockedOrder.productOption?.scheduled_date,
        people: lockedOrder.productOption?.num_subjects,
        frameId: lockedOrder.productOption?.frame_type,
        deliveryMethod: lockedOrder.productOption?.pickup_option,
      };
      await assertUrgentAvailability(capacityRequest, transaction, lockedOrder.order_id);
      await assertScheduledAvailability(capacityRequest, transaction, lockedOrder.order_id);

      const fullName = (lockedOrder.customer?.full_name || lockedOrder.customer?.username || 'Vivid Customer').trim();
      const [firstName, ...lastNameParts] = fullName.split(/\s+/);
      const storedCustomer = lockedPayment.metadata?.customer || {};
      const customerDetails = {
        firstName: storedCustomer.firstName || firstName,
        lastName: storedCustomer.lastName || lastNameParts.join(' ') || '-',
        email: storedCustomer.email || lockedOrder.customer?.email,
        phone: storedCustomer.phone || lockedOrder.customer?.phone_number,
        address: storedCustomer.address || lockedOrder.customer?.address,
        city: storedCustomer.city || 'Colombo',
        country: storedCustomer.country || 'Sri Lanka',
      };
      if (isReusableDepositCheckout(lockedPayment)) {
        const checkout = buildInitialCheckout({ payment: lockedPayment, customer: customerDetails });
        return { order: lockedOrder, payment: lockedPayment, fields: checkout.fields, reused: true };
      }
      await lockedPayment.update({
        payhereOrderId: createOrderId(),
        status: 'pending',
        completedAt: null,
        transactionId: null,
        payherePaymentId: null,
      }, { transaction });
      const checkout = buildInitialCheckout({ payment: lockedPayment, customer: customerDetails });
      await lockedPayment.update({
        payhereMd5sig: checkout.hash,
        metadata: {
          ...(lockedPayment.metadata || {}),
          checkoutAmount: checkout.gatewayAmount,
          checkoutCurrency: lockedPayment.currency,
          capacityReservedUntil: new Date(Date.now() + CAPACITY_RESERVATION_MINUTES * 60 * 1000).toISOString(),
        },
      }, { transaction });
      return { order: lockedOrder, payment: lockedPayment, fields: checkout.fields, reused: false };
    });

    res.status(201).json({
      success: true,
      checkoutUrl: PAYHERE_CHECKOUT_URL,
      checkoutFields: fields,
      orderId: payment.payhereOrderId,
      commissionId: order.order_id,
      reused,
    });
  } catch (error) {
    console.error('Error resuming PayHere checkout:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Unable to resume payment',
      code: error.code,
    });
  }
});

router.post('/timeline-preview', requireCustomer, async (req, res) => {
  try {
    const orders = await getCapacityOrders();
    const proposedOrder = {
      urgent: req.body?.urgent === true,
      urgentDeadline: req.body?.urgentDeadline || null,
      scheduled: req.body?.scheduled === true,
      scheduledDate: req.body?.scheduledDate || null,
      people: req.body?.people,
      frameId: req.body?.frameId,
      deliveryMethod: req.body?.deliveryMethod === 'pickup' ? 'pickup' : 'courier',
    };
    const timeline = buildTimelinePreview(orders, proposedOrder);
    if (proposedOrder.scheduled && timeline.requiredStart) {
      const conflict = hasScheduledSlotConflict(orders, proposedOrder, SCHEDULED_WINDOW_DAYS);
      if (conflict) {
        timeline.feasible = false;
        timeline.slotAvailable = false;
        timeline.unavailableReason = 'Scheduled-order availability for this 15-day production period is full. Please select a later date.';
      } else timeline.slotAvailable = true;
      timeline.scheduledWindowDays = SCHEDULED_WINDOW_DAYS;
    }
    res.json({ success: true, timeline });
  } catch (error) {
    console.error('Error calculating timeline preview:', error);
    res.status(500).json({ success: false, error: 'Failed to calculate the estimated timeline' });
  }
});

router.get('/urgent-availability', async (_req, res) => {
  try {
    const availability = await getUrgentAvailability({});
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
      if (order.status === 'cancelled') {
        const error = new Error('This order was cancelled and cannot accept payment');
        error.statusCode = 409;
        throw error;
      }
      const payments = await Payment.findAll({
        where: { order_id: order.order_id },
        order: [['paymentId', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const incompletePendingBalance = payments.find(payment => (
        payment.paymentType === 'full'
        && payment.status === 'pending'
        && !hasUsableCheckout(payment)
      ));
      if (incompletePendingBalance) {
        await incompletePendingBalance.update({ status: 'failed' }, { transaction });
      }
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
      const gatewayAmount = calculateDisplayAmount(decision.balance, currency);
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
        notify_url: PAYHERE_NOTIFY_URL,
        order_id: payment.payhereOrderId,
        items: `Vivid Arts order ${order.order_id.slice(0, 8)} balance`,
        currency, amount: gatewayAmount,
        first_name: firstName || 'Vivid', last_name: lastNameParts.join(' ') || '-',
        email: order.customer?.email || 'customer@example.com',
        phone: order.customer?.phone_number || '0771234567',
        address: order.customer?.address || 'Colombo', city: 'Colombo', country: 'Sri Lanka', hash,
      };
      await payment.update({
        payhereMd5sig: hash,
        metadata: {
          ...(payment.metadata || {}),
          balancePayment: true,
          checkoutAmount: gatewayAmount,
          checkoutCurrency: currency,
          customer: {
            firstName: firstName || 'Vivid',
            lastName: lastNameParts.join(' ') || '-',
            email: order.customer?.email,
            phone: order.customer?.phone_number,
            address: order.customer?.address,
            city: 'Colombo',
            country: 'Sri Lanka',
          },
        },
      }, { transaction });
      return { payment, checkoutFields };
    });
    const { payment, checkoutFields } = checkout;
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

    const configError = validatePayhereCallbackConfig();
    if (configError) return res.status(503).send('Payment callback is not configured');
    const localMd5sig = createPayhereNotifyHash({
      merchantId: PAYHERE_MERCHANT_ID,
      orderId: order_id,
      amount: payhere_amount,
      currency: payhere_currency,
      statusCode: status_code,
      merchantSecret: PAYHERE_MERCHANT_SECRET
    });

    try {
      assertPayhereCallbackAuthenticity({
        receivedMerchantId: merchant_id,
        configuredMerchantId: PAYHERE_MERCHANT_ID,
        receivedSignature: md5sig,
        expectedSignature: localMd5sig,
      });
    } catch (error) {
      console.warn(`Rejected PayHere callback: ${error.code}`);
      return res.status(error.statusCode || 400).send(error.message);
    }

    const nextStatus = mapPayhereStatus(status_code);
    let payment;
    let newlyCompleted = false;
    try {
      ({ payment, newlyCompleted } = await db.sequelize.transaction(async transaction => {
        await acquireCapacityLock(transaction);
        const lockedPayment = await Payment.findOne({
          where: { payhereOrderId: order_id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!lockedPayment) return { payment: null, newlyCompleted: false };

        const callbackDecision = paymentCallbackDecision({
          currentStatus: lockedPayment.status,
          nextStatus,
          expectedAmount: lockedPayment.amount,
          receivedAmount: payhere_amount,
          expectedCurrency: lockedPayment.currency,
          receivedCurrency: payhere_currency,
        });
        if (callbackDecision.idempotent) return { payment: lockedPayment, newlyCompleted: false };

        if (callbackDecision.status === 'completed' && !lockedPayment.metadata?.balancePayment && lockedPayment.order_id) {
          const order = await db.Order.findByPk(lockedPayment.order_id, {
            include: [{ model: db.ProductOption, as: 'productOption' }],
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!order || order.status === 'cancelled') {
            throw Object.assign(new Error('This order can no longer accept payment'), {
              statusCode: 409,
              code: 'ORDER_NOT_PAYABLE',
            });
          }
          const capacityRequest = {
            urgent: Boolean(order.is_urgent || order.productOption?.is_urgent),
            scheduled: Boolean(order.is_scheduled || order.productOption?.is_scheduled),
            scheduledDate: order.productOption?.scheduled_date,
            people: order.productOption?.num_subjects,
            frameId: order.productOption?.frame_type,
            deliveryMethod: order.productOption?.pickup_option,
          };
          await assertUrgentAvailability(capacityRequest, transaction, order.order_id);
          await assertScheduledAvailability(capacityRequest, transaction, order.order_id);
        }

        await lockedPayment.update({
          status: callbackDecision.status,
          completedAt: callbackDecision.status === 'completed' ? new Date() : null,
          transactionId: payment_id || null,
          payherePaymentId: payment_id || null,
          metadata: {
            ...(lockedPayment.metadata || {}),
            payhereAmount: payhere_amount,
            payhereCurrency: payhere_currency,
            payhereMethod: method,
            payhereStatusCode: status_code,
            payhereStatusMessage: status_message || null
          }
        }, { transaction });
        await syncLinkedOrderPayment(lockedPayment, transaction);
        return {
          payment: lockedPayment,
          newlyCompleted: callbackDecision.status === 'completed',
        };
      }));
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).send(error.message);
      throw error;
    }

    if (!payment) return res.status(404).send('Payment record not found');

    if (newlyCompleted) {
      await completeInitialOrderPayment(payment);
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
    if (process.env.NODE_ENV !== 'development' || PAYHERE_SANDBOX === 'false') {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const payment = req.payment;

    const wasPending = payment.status === 'pending';
    if (wasPending) {
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
    if (wasPending && payment.status === 'completed') await completeInitialOrderPayment(payment);

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

// 4. Get Prices (must be before /:orderId to avoid route conflicts)
router.get('/prices', async (req, res) => {
  try {
    const catalog = await getCatalog();
    res.json({ success: true, ...catalog, currencies: CURRENCIES });
  } catch (error) {
    console.error('Error fetching prices:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch prices' });
  }
});

// 5. Get Payment Status
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

// 6. Download invoice PDF (available once payment is completed)
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

// 7. Get All Payments (for admin)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginationFrom(req.query);
    const [{ count, rows: payments }, completedPayments] = await Promise.all([
      Payment.findAndCountAll({
        where: { status: 'completed' },
        include: [{
          model: db.Order,
          as: 'order',
          include: [
            { model: db.Customer, as: 'customer', attributes: ['customer_id', 'full_name', 'username', 'email'] },
            { model: db.ProductOption, as: 'productOption', attributes: ['paper_size', 'num_subjects', 'frame_type'] },
          ],
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
