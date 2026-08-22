const nodemailer = require('nodemailer');
const db = require('../models');

const requiredSmtpVariables = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
const DEFAULT_EMAIL_RETRY_LIMIT = 3;

async function ensureEmailDeliveryTable() {
  if (!db?.sequelize?.models?.EmailDelivery) return;
  await db.sequelize.models.EmailDelivery.sync({ alter: true });
}

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

function getOrderUrl(orderId, view = null) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const baseUrl = `${frontendUrl}/orders/${encodeURIComponent(orderId)}`;
  if (!view || view === 'overview') return baseUrl;
  return `${baseUrl}?view=${encodeURIComponent(view)}`;
}

async function enqueueEmailDelivery({ to, subject, text, html, metadata = {}, maxAttempts = DEFAULT_EMAIL_RETRY_LIMIT }) {
  if (!to) {
    throw new Error('Cannot queue email without a recipient address');
  }

  await ensureEmailDeliveryTable();

  const EmailDelivery = db?.EmailDelivery;
  if (!EmailDelivery) {
    return {
      id: Date.now(),
      to,
      subject,
      text,
      html,
      metadata,
      status: 'queued',
      attempts: 0,
      maxAttempts,
      queued: true,
      nextAttemptAt: new Date(),
    };
  }

  const record = await EmailDelivery.create({
    to,
    subject,
    text,
    html,
    metadata,
    status: 'queued',
    attempts: 0,
    maxAttempts,
    nextAttemptAt: new Date(),
  });

  const payload = record.toJSON ? record.toJSON() : record;
  return { ...payload, queued: true };
}

async function processEmailQueue({ queue = null, transport = null, now = () => new Date() } = {}) {
  await ensureEmailDeliveryTable();

  const EmailDelivery = db?.EmailDelivery;
  let items = queue;

  if (!items) {
    if (!EmailDelivery) return [];
    items = await EmailDelivery.findAll({
      where: {
        status: ['queued', 'retrying'],
      },
    });
  }

  const activeTransport = transport || (() => {
    const missing = getMissingSmtpVariables();
    if (missing.length) {
      throw new Error(`Email is not configured. Missing environment variables: ${missing.join(', ')}`);
    }
    return createTransporter();
  })();

  const processed = [];

  for (const item of items || []) {
    const record = item && typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
    if (!record || !record.id) continue;

    if (record.nextAttemptAt && new Date(record.nextAttemptAt).getTime() > now().getTime()) {
      processed.push(record);
      continue;
    }

    try {
      const nextAttempt = Number(record.attempts || 0) + 1;
      await activeTransport.sendMail({
        from: process.env.EMAIL_FROM || process.env.SMTP_USER,
        to: record.to,
        subject: record.subject,
        text: record.text,
        html: record.html,
      });

      const updated = { status: 'sent', attempts: nextAttempt, sentAt: now(), lastError: null, nextAttemptAt: null };
      if (item && typeof item.update === 'function') {
        await item.update(updated);
        processed.push({ ...record, ...updated });
      } else if (EmailDelivery) {
        const persisted = await EmailDelivery.findByPk(record.id);
        if (persisted) {
          await persisted.update(updated);
          processed.push({ ...record, ...updated, id: record.id });
        } else {
          processed.push({ ...record, ...updated });
        }
      } else {
        processed.push({ ...record, ...updated });
      }
    } catch (error) {
      const nextAttempt = Number(record.attempts || 0) + 1;
      const shouldRetry = nextAttempt < Number(record.maxAttempts || DEFAULT_EMAIL_RETRY_LIMIT);
      const updated = {
        status: shouldRetry ? 'retrying' : 'failed',
        attempts: nextAttempt,
        lastError: error.message,
        nextAttemptAt: shouldRetry ? new Date(Date.now() + Math.min(1000 * (2 ** nextAttempt), 300000)) : null,
      };

      if (item && typeof item.update === 'function') {
        await item.update(updated);
        processed.push({ ...record, ...updated });
      } else if (EmailDelivery) {
        const persisted = await EmailDelivery.findByPk(record.id);
        if (persisted) {
          await persisted.update(updated);
          processed.push({ ...record, ...updated, id: record.id });
        } else {
          processed.push({ ...record, ...updated });
        }
      } else {
        processed.push({ ...record, ...updated });
      }
    }
  }

  return processed;
}

let emailQueueTimer = null;

function startEmailQueueWorker(intervalMs = 30000) {
  if (emailQueueTimer) return emailQueueTimer;

  const flush = async () => {
    try {
      await processEmailQueue();
    } catch (error) {
      console.error('[email] Queue worker failed:', error.message);
    }
  };

  flush();
  emailQueueTimer = setInterval(flush, intervalMs);
  return emailQueueTimer;
}

async function sendEmail({ to, subject, text, html, metadata = {} }) {
  if (!to) {
    throw new Error('Cannot send email without a recipient address');
  }

  const missing = getMissingSmtpVariables();
  if (missing.length) {
    const skippedRecord = await enqueueEmailDelivery({
      to,
      subject,
      text,
      html,
      metadata,
      maxAttempts: 0,
    });
    if (db?.EmailDelivery) {
      const record = await db.EmailDelivery.findByPk(skippedRecord.id);
      if (record) {
        await record.update({ status: 'skipped', lastError: `Missing ${missing.join(', ')}` });
      }
    }
    console.warn(`[email] Skipped "${subject}": missing ${missing.join(', ')}`);
    return { skipped: true, queued: false, reason: `Missing ${missing.join(', ')}` };
  }

  try {
    return await enqueueEmailDelivery({ to, subject, text, html, metadata });
  } catch (error) {
    console.error('[email] enqueue failed:', error.message);
    return { skipped: true, queued: false, reason: error.message };
  }
}

function getEligibleAdminRecipients(admins = [], preferenceKey = 'revisionRequested') {
  return (admins || []).filter((admin) => {
    const preferences = admin?.notifPreferences || {};
    const emailAddress = admin?.email || admin?.businessEmail;
    if (!emailAddress) return false;
    return preferences[preferenceKey] !== false;
  });
}

async function sendRevisionRequestedAdminEmail({
  order,
  customerName,
  revisionNote,
  admins = [],
  sendEmailFn = sendEmail,
  createInAppNotification = null,
}) {
  const orderId = order?.order_id || order?.id || order;
  const safeCustomerName = String(customerName || 'Customer').trim() || 'Customer';
  const safeRevisionNote = String(revisionNote || '').trim() || 'No additional notes were provided.';
  const eligibleAdmins = getEligibleAdminRecipients(admins, 'revisionRequested');
  const sent = [];

  for (const admin of eligibleAdmins) {
    const subject = `Revision requested for order ${orderId}`;
    const reviewUrl = getOrderUrl(orderId);
    const text = [
      `Revision requested for order ${orderId}.`,
      `Customer: ${safeCustomerName}`,
      `Revision note: ${safeRevisionNote}`,
      `Admin order review: ${reviewUrl}`,
    ].join('\n');

    const html = `
      <p>Revision requested for order <strong>${escapeHtml(orderId)}</strong>.</p>
      <p><strong>Customer:</strong> ${escapeHtml(safeCustomerName)}</p>
      <p><strong>Revision note:</strong> ${escapeHtml(safeRevisionNote)}</p>
      <p><a href="${escapeHtml(reviewUrl)}">Open admin order</a></p>
    `;

    if (createInAppNotification && typeof createInAppNotification === 'function') {
      const existing = await db.AdminNotification.findOne({
        where: {
          admin_id: admin.id,
          order_id: orderId,
          type: 'revision',
        },
      });
      if (!existing) {
        await createInAppNotification({
          adminId: admin.id,
          orderId,
          type: 'revision',
          title: 'Revision requested',
          message: `Customer ${safeCustomerName} requested changes for order #${String(orderId).slice(0, 8)}. Note: "${safeRevisionNote}"`,
        });
      }
    }

    const payload = await sendEmailFn({
      to: admin.email,
      subject,
      text,
      html,
      metadata: { type: 'revision_requested_admin', orderId, customerName: safeCustomerName, revisionNote: safeRevisionNote },
    });
    sent.push({ adminId: admin.id, email: admin.email, payload });
  }

  return sent;
}

async function sendProofReadyEmail(email, customerName, orderId, proofVersion = null) {
  const safeName = escapeHtml(customerName || 'Customer');
  const safeOrderId = escapeHtml(orderId);
  const proofUrl = getOrderUrl(orderId, 'proof');

  return sendEmail({
    to: email,
    subject: `Your artwork proof is ready – Order ${orderId}`,
    text: `Hi ${customerName || 'Customer'}, your proof for order ${orderId} is ready. Review it here: ${proofUrl}`,
    html: `<p>Hi ${safeName},</p><p>Your proof for order <strong>${safeOrderId}</strong> is ready for review.</p><p><a href="${escapeHtml(proofUrl)}">Review your proof</a></p>`,
    metadata: { type: 'proof_ready', orderId, proofVersion },
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
    metadata: { type: 'status_update', orderId, status },
  });
}

async function sendThankYouEmail(email, customerName, orderId) {
  const safeName = escapeHtml(customerName || 'Customer');
  const safeOrderId = escapeHtml(orderId);
  const orderUrl = getOrderUrl(orderId);
  const supportEmail = (process.env.SUPPORT_EMAIL || process.env.SMTP_USER || '').trim();
  const reviewUrl = (process.env.REVIEW_URL || orderUrl).trim();
  const supportLine = supportEmail ? `If you have any questions, please contact ${supportEmail}.` : '';
  const reviewLine = reviewUrl ? `<p><a href="${escapeHtml(reviewUrl)}">Leave a review</a></p>` : '';

  if (db?.EmailDelivery) {
    const history = await db.EmailDelivery.findAll({
      where: { to: email },
      attributes: ['metadata', 'status'],
    });
    const duplicate = history.some((record) => {
      const metadata = record?.metadata || {};
      return metadata.type === 'thank_you' && metadata.orderId === orderId;
    });
    if (duplicate) {
      return { skipped: true, queued: false, reason: 'Duplicate thank-you email for completed order.' };
    }
  }

  return sendEmail({
    to: email,
    subject: `Thank you for your order – ${orderId}`,
    text: `Hi ${customerName || 'Customer'}, thank you for choosing us! Your order ${orderId} has been successfully completed. View details: ${orderUrl}${supportEmail ? ` ${supportLine}` : ''}`,
    html: `
      <p>Hi ${safeName},</p>
      <p>Thank you so much for your support! Your order <strong>${safeOrderId}</strong> has been successfully completed and delivered.</p>
      <p><a href="${escapeHtml(orderUrl)}">View order details</a></p>
      ${reviewLine}
      ${supportEmail ? `<p>${escapeHtml(supportLine)}</p>` : ''}
    `,
    metadata: {
      type: 'thank_you',
      orderId,
      eventKey: `order_done:${orderId}`,
      supportEmail: supportEmail || null,
    },
  });
}

module.exports = {
  sendEmail,
  enqueueEmailDelivery,
  processEmailQueue,
  startEmailQueueWorker,
  sendProofReadyEmail,
  sendStatusUpdateEmail,
  sendThankYouEmail,
  getEligibleAdminRecipients,
  sendRevisionRequestedAdminEmail,
};