const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { calculateOrder } = require('./pricing');

const INVOICES_DIR = path.join(__dirname, '..', 'invoices');
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'vivid-arts-logo.png');

const CURRENCY_SYMBOLS = {
  LKR: 'Rs',
  USD: '$',
  AED: 'د.إ',
  GBP: '£'
};

const money = (amount, currency) => {
  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  return `${symbol} ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const invoicePath = (orderId) => path.join(INVOICES_DIR, `invoice-${orderId}.pdf`);

function drawRow(doc, y, label, value, { bold = false } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
  doc.text(label, 50, y, { continued: false });
  doc.text(value, 0, y, { align: 'right' });
}

function drawLogoMark(doc, x, y, width = 64, height = 34) {
  if (!fs.existsSync(LOGO_PATH)) return;

  const imageWidth = width / 0.743;
  doc.save();
  doc.rect(x, y, width, height).clip();
  doc.image(LOGO_PATH, x - imageWidth * 0.132, y - imageWidth * 0.253, { width: imageWidth });
  doc.restore();
}

async function renderInvoice(doc, payment) {
  const metadata = payment.metadata || {};
  let customer = metadata.customer || {};
  let order = metadata.order;
  let orderInstance = null;
  let allPayments = [];

  if (payment.order_id) {
    try {
      const db = require('../models');
      orderInstance = await db.Order.findByPk(payment.order_id, {
        include: [
          { model: db.Customer, as: 'customer' },
          { model: db.ProductOption, as: 'productOption' },
          { model: db.Payment, as: 'payments' },
        ],
      });
      if (orderInstance) {
        allPayments = orderInstance.payments || [];
        if ((!customer.firstName && !customer.lastName) && orderInstance.customer) {
          const fullName = (orderInstance.customer.full_name || orderInstance.customer.username || '').trim();
          const [fName, ...lParts] = fullName.split(/\s+/);
          customer = {
            firstName: fName || 'Vivid Customer',
            lastName: lParts.join(' ') || '',
            email: orderInstance.customer.email,
            phone: orderInstance.customer.phone_number,
          };
        }
        if (!order) {
          const paymentWithOrder = allPayments.find(p => p.metadata?.order);
          if (paymentWithOrder) {
            order = paymentWithOrder.metadata.order;
          } else {
            const product = orderInstance.productOption || {};
            order = await calculateOrder({
              sizeId: product.paper_size,
              frameId: product.frame_type,
              people: product.num_subjects,
              urgent: orderInstance.is_urgent,
              deliveryMethod: product.pickup_option,
            });
          }
        }
      }
    } catch (e) {
      console.error('Error loading order for invoice:', e);
    }
  }

  if (!order) {
    order = await calculateOrder({});
  }

  const total = Number(order.total || orderInstance?.calculated_price || 0);
  const dueAmount = Number(payment.amount || 0);

  // Check if this payment is a balance payment:
  const isBalancePayment = Boolean(
    payment.metadata?.balancePayment ||
    (payment.paymentType === 'full' && (allPayments.length > 1 || allPayments.some(p => p.paymentType === 'advance')))
  );

  // Find advance/deposit payment if any
  const depositPayment = allPayments.find(p => p.paymentType === 'advance' && (p.status === 'completed' || p.paymentId === payment.paymentId));
  const depositAmount = isBalancePayment
    ? (depositPayment ? Number(depositPayment.amount) : Math.max(0, total - dueAmount))
    : dueAmount;

  const totalPaid = isBalancePayment ? (depositAmount + dueAmount) : dueAmount;
  const balanceDue = Math.max(total - totalPaid, 0);
  const issuedAt = payment.completedAt || payment.updatedAt || payment.createdAt || new Date();

  // Header
  drawLogoMark(doc, 50, 42);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1a2e').text('VIVID ARTS', 126, 43);
  doc.font('Helvetica').fontSize(10).fillColor('#6b6b80').text('Pencil portrait commissions', 126, 68);

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a2e').text('INVOICE', 0, 50, { align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#6b6b80')
    .text(`Invoice #: ${payment.payhereOrderId}`, 0, 74, { align: 'right' })
    .text(`Date: ${new Date(issuedAt).toLocaleDateString()}`, 0, 88, { align: 'right' });

  doc.moveTo(50, 110).lineTo(545, 110).strokeColor('#e5e4e7').stroke();

  // Bill to
  let y = 130;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a2e').text('Bill To', 50, y);
  y += 16;
  doc.font('Helvetica').fontSize(10).fillColor('#374151');
  const lastName = String(customer.lastName || '').trim();
  const billName = [customer.firstName, lastName === 'Arts Customer' ? '' : lastName]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ') || 'N/A';
  doc.text(billName, 50, y); y += 14;
  if (customer.email) { doc.text(customer.email, 50, y); y += 14; }
  if (customer.phone) { doc.text(customer.phone, 50, y); y += 14; }

  // Payment info (right column)
  let infoY = 130;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a2e').text('Payment', 350, infoY, { width: 195 });
  infoY += 16;
  doc.font('Helvetica').fontSize(10).fillColor('#374151');
  doc.text(`Method: ${payment.paymentMethod === 'card' ? 'Bank card (PayHere)' : (payment.paymentMethod || 'PayHere')}`, 350, infoY, { width: 195 }); infoY += 14;
  doc.text(`Status: ${payment.status}`, 350, infoY, { width: 195 }); infoY += 14;
  if (isBalancePayment) {
    doc.text('Payment Type: Balance payment (Final)', 350, infoY, { width: 195 }); infoY += 14;
  } else if (payment.paymentType === 'advance') {
    doc.text('Payment Type: 50% Deposit', 350, infoY, { width: 195 }); infoY += 14;
  }
  if (payment.transactionId) { doc.text(`Transaction ID: ${payment.transactionId}`, 350, infoY, { width: 195 }); infoY += 14; }

  y = Math.max(y, infoY) + 20;

  // Line items table
  const tableTop = y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e');
  doc.text('Description', 50, tableTop);
  doc.text('Amount', 0, tableTop, { align: 'right' });
  doc.moveTo(50, tableTop + 16).lineTo(545, tableTop + 16).strokeColor('#e5e4e7').stroke();

  const sizeLabel = order.sizeLabel || order.sizeId || 'Portrait';
  const frameLabel = order.frameLabel || order.frameId || 'Frame';
  const rows = [
    [`Base price (${sizeLabel} portrait)`, money(order.basePrice ?? total, payment.currency)],
    ...(order.framePrice > 0 ? [[`${frameLabel} frame`, money(order.framePrice, payment.currency)]] : []),
    ...(order.peoplePrice > 0 ? [[`Extra subjects (${(order.people || 1) - 1})`, money(order.peoplePrice, payment.currency)]] : []),
    ...(order.deliveryPrice > 0 ? [['Delivery', money(order.deliveryPrice, payment.currency)]] : []),
    ...(order.urgentPrice > 0 ? [['Urgent order', money(order.urgentPrice, payment.currency)]] : []),
    ...(order.scheduledPrice > 0 ? [['Scheduled order', money(order.scheduledPrice, payment.currency)]] : []),
  ];

  let rowY = tableTop + 26;
  rows.forEach(([label, value]) => {
    drawRow(doc, rowY, label, value);
    rowY += 20;
  });

  doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor('#e5e4e7').stroke();
  rowY += 10;

  if (isBalancePayment) {
    drawRow(doc, rowY, 'Total', money(total, payment.currency), { bold: true });
    rowY += 20;
    drawRow(doc, rowY, 'Deposit paid (50% advance)', money(depositAmount, payment.currency));
    rowY += 20;
    drawRow(doc, rowY, 'Paid now (Final balance)', money(dueAmount, payment.currency), { bold: true });
    rowY += 20;
    drawRow(doc, rowY, 'Total paid', money(totalPaid, payment.currency), { bold: true });
    rowY += 20;
    drawRow(doc, rowY, 'Balance due', `${money(balanceDue, payment.currency)} (Paid in full)`, { bold: true, color: '#087a57' });
    rowY += 35;

    doc.font('Helvetica').fontSize(9).fillColor('#8f8eab')
      .text('Thank you for commissioning Vivid Arts. Your payment has been received in full and your order is complete.', 50, rowY, { width: 495, align: 'center' });
  } else if (payment.paymentType === 'full' && !depositPayment) {
    drawRow(doc, rowY, 'Total', money(total, payment.currency), { bold: true });
    rowY += 20;
    drawRow(doc, rowY, 'Paid now (100% full payment)', money(dueAmount, payment.currency), { bold: true });
    rowY += 20;
    drawRow(doc, rowY, 'Balance due', `${money(0, payment.currency)} (Paid in full)`, { bold: true, color: '#087a57' });
    rowY += 35;

    doc.font('Helvetica').fontSize(9).fillColor('#8f8eab')
      .text('Thank you for commissioning Vivid Arts. Your order is fully paid and in production.', 50, rowY, { width: 495, align: 'center' });
  } else {
    drawRow(doc, rowY, 'Total', money(total, payment.currency), { bold: true });
    rowY += 22;
    drawRow(doc, rowY, 'Paid now (50% deposit)', money(dueAmount, payment.currency), { bold: true });
    rowY += 20;
    drawRow(doc, rowY, 'Balance due before delivery', money(balanceDue, payment.currency));
    rowY += 40;

    doc.font('Helvetica').fontSize(9).fillColor('#8f8eab')
      .text('Thank you for commissioning Vivid Arts. The remaining balance is due after you approve the proof image.', 50, rowY, { width: 495, align: 'center' });
  }
}

async function generateInvoiceBuffer(payment) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    renderInvoice(doc, payment).then(() => doc.end()).catch(reject);
  });
}

async function ensureInvoiceGenerated(payment) {
  fs.mkdirSync(INVOICES_DIR, { recursive: true });
  const filePath = invoicePath(payment.payhereOrderId);
  const logoUpdatedAt = fs.existsSync(LOGO_PATH) ? fs.statSync(LOGO_PATH).mtimeMs : 0;
  const templateUpdatedAt = fs.statSync(__filename).mtimeMs;
  const invoiceUpdatedAt = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;

  if (!fs.existsSync(filePath) || invoiceUpdatedAt < Math.max(logoUpdatedAt, templateUpdatedAt)) {
    const buffer = await generateInvoiceBuffer(payment);
    fs.writeFileSync(filePath, buffer);
  }

  return filePath;
}

module.exports = {
  generateInvoiceBuffer,
  ensureInvoiceGenerated,
  invoicePath
};
