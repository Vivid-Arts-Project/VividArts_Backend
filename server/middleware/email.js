const nodemailer = require('nodemailer');

const requiredSmtpVariables = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];

function getMissingSmtpVariables() {
  return requiredSmtpVariables.filter((name) => !process.env[name]);
}

function createTransporter() {
  const missing = getMissingSmtpVariables();
  if (missing.length) {
    throw new Error(`Email is not configured. Missing environment variables: ${missing.join(', ')}`);
  }

  const port = Number(process.env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('SMTP_PORT must be a valid positive integer');
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getOrderUrl(orderId) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${frontendUrl}/orders/${encodeURIComponent(orderId)}`;
}

async function sendEmail({ to, subject, text, html }) {
  if (!to) {
    throw new Error('Cannot send email without a recipient address');
  }

  const missing = getMissingSmtpVariables();
  if (missing.length) {
    console.warn(`[email] Skipped "${subject}": missing ${missing.join(', ')}`);
    return { skipped: true, reason: `Missing ${missing.join(', ')}` };
  }

  const transporter = createTransporter();
  try {
    return await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
  } catch (error) {
    console.error(`[email] Failed to send "${subject}" to ${to}:`, error.message);
    return { skipped: true, reason: error.message };
  }
}

async function sendProofReadyEmail(email, customerName, orderId) {
  const safeName = escapeHtml(customerName || 'Customer');
  const safeOrderId = escapeHtml(orderId);
  const orderUrl = getOrderUrl(orderId);

  return sendEmail({
    to: email,
    subject: `Your artwork proof is ready – Order ${orderId}`,
    text: `Hi ${customerName || 'Customer'}, your proof for order ${orderId} is ready. Review it here: ${orderUrl}`,
    html: `<p>Hi ${safeName},</p><p>Your proof for order <strong>${safeOrderId}</strong> is ready for review.</p><p><a href="${escapeHtml(orderUrl)}">Review your proof</a></p>`,
  });
}

async function sendStatusUpdateEmail(email, customerName, orderId, status) {
  const readableStatus = String(status || '').replaceAll('_', ' ');
  const safeName = escapeHtml(customerName || 'Customer');
  const safeOrderId = escapeHtml(orderId);
  const safeStatus = escapeHtml(readableStatus);
  const orderUrl = getOrderUrl(orderId);

  return sendEmail({
    to: email,
    subject: `Order ${orderId} status updated`,
    text: `Hi ${customerName || 'Customer'}, order ${orderId} is now ${readableStatus}. View it here: ${orderUrl}`,
    html: `<p>Hi ${safeName},</p><p>Order <strong>${safeOrderId}</strong> is now <strong>${safeStatus}</strong>.</p><p><a href="${escapeHtml(orderUrl)}">View your order</a></p>`,
  });
}

module.exports = {
  sendEmail,
  sendProofReadyEmail,
  sendStatusUpdateEmail,
};
