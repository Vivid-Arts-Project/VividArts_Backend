const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { Payment } = require('../models');
const { ensureInvoiceGenerated } = require('../utils/invoice');
const { getCatalog, calculateOrder } = require('../utils/pricing');

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

// ============= ROUTES =============

// 1. Create Payment Order
router.post('/create-order', async (req, res) => {
  try {
    const { currency, paymentMethod, bankDetails, order } = req.body;
    const computedOrder = await calculateOrder(order);

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

    res.status(201).json({
      success: true,
      payment: {
        id: payment.paymentId,
        orderId: payment.payhereOrderId,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status
      }
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create order' 
    });
  }
});

// 2. Create PayHere checkout payload for card payments
router.post('/create-payhere-checkout', async (req, res) => {
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
    const gatewayAmount = calculateDisplayAmount(computedOrder.dueAmount, selectedCurrency);

    const payment = await Payment.create({
      payhereOrderId: createOrderId(),
      amount: computedOrder.dueAmount,
      currency: selectedCurrency,
      paymentMethod: 'card',
      status: 'pending'
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
      last_name: customer.lastName || 'Arts Customer',
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
          lastName: customer.lastName || 'Arts Customer',
          email: customer.email || null,
          phone: customer.phone || null,
          address: customer.address || null,
          city: customer.city || null,
          country: customer.country || null
        }
      }
    });

    res.status(201).json({
      success: true,
      checkoutUrl: PAYHERE_CHECKOUT_URL,
      checkoutFields,
      orderId: payment.payhereOrderId
    });
  } catch (error) {
    console.error('Error creating PayHere checkout:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create PayHere checkout'
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

    await payment.update({
      status: mapPayhereStatus(status_code),
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
router.post('/sandbox-confirm-return/:orderId', async (req, res) => {
  try {
    if (process.env.NODE_ENV !== 'development' || process.env.PAYHERE_SANDBOX === 'false') {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const payment = await Payment.findOne({
      where: { payhereOrderId: req.params.orderId },
    });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (payment.status === 'pending') {
      await payment.update({
        status: 'completed',
        transactionId: payment.transactionId || `SANDBOX-${Date.now()}`,
        metadata: {
          ...(payment.metadata || {}),
          sandboxConfirmedFromReturn: true,
        },
      });
    }

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
router.post('/process', async (req, res) => {
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
      transactionId: result.transactionId,
      bankReference: result.reference || null,
      metadata: result
    });

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
router.get('/status/:orderId', async (req, res) => {
  try {
    const payment = await Payment.findOne({
      where: { payhereOrderId: req.params.orderId }
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

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
router.get('/:orderId/invoice', async (req, res) => {
  try {
    const payment = await Payment.findOne({ where: { payhereOrderId: req.params.orderId } });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

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
router.get('/', async (req, res) => {
  try {
    const payments = await Payment.findAll({
      order: [['createdAt', 'DESC']]
    });
    res.json({ success: true, payments });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payments'
    });
  }
});

module.exports = router;
