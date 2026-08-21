const express  = require('express');
const router   = express.Router();
const db       = require('../models');
const { uploadProof, deleteImage } = require('../middleware/upload');
const { sendProofReadyEmail, sendStatusUpdateEmail, sendThankYouEmail } = require('../middleware/email');
const { calculatePrice, loadPrices }                     = require('../middleware/pricingEngine');

// 💡 Importing the Notification Helper
const { createNotification } = require('../utils/notificationHelper');
const { createAdminNotification } = require('../utils/adminNotificationHelper');
const { realtimeNotificationHub } = require('../utils/notificationRealtime');
const { calculateCompletionFromSketchingStart, sortProductionQueue } = require('../utils/scheduling');
const { paginationFrom, paginationMeta } = require('../utils/pagination');
const { ORDER_STATUSES, normalizeStatus, allowedTransitions, canTransition } = require('../utils/orderWorkflow');

const ensureUrgentDeadlineNotifications = async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const deadline = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const urgentOrders = await db.Order.findAll({
    where: { status: { [db.Sequelize.Op.notIn]: ['done'] } },
    include: [{
      model: db.ProductOption,
      as: 'productOption',
      required: true,
      where: { is_urgent: true, urgent_deadline: deadline },
    }],
  });
  if (!urgentOrders.length) return;
  const admins = await db.Admin.findAll({ attributes: ['id'] });
  await Promise.all(admins.flatMap(admin => urgentOrders.map(async order => {
    const exists = await db.AdminNotification.findOne({ where: {
      admin_id: admin.id,
      order_id: order.order_id,
      type: 'urgent_deadline',
    } });
    if (!exists) await createAdminNotification({
      adminId: admin.id,
      orderId: order.order_id,
      type: 'urgent_deadline',
      title: 'Urgent order due tomorrow',
      message: `Urgent order #${order.order_id.slice(0, 8)} is due tomorrow (${deadline}).`,
    });
  })));
};

const orderJson = (instance) => {
  const o = typeof instance?.toJSON === 'function' ? instance.toJSON() : instance;
  if (!o) return null;
  const p = o.productOption || {};
  const customer = o.customer ? {
    ...o.customer,
    fullName: o.customer.full_name || o.customer.username,
    phone: o.customer.phone_number,
  } : null;
  const completedPaid = (o.payments || []).filter(payment => payment.status === 'completed').reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const checkoutDetails = ((o.payments || []).find(payment => payment.metadata?.order)?.metadata?.order) || {};
  return { ...o, customer, id: o.order_id, customerId: o.customer_id, totalPrice: o.calculated_price,
    amountPaid: completedPaid || Number(o.amount_paid || 0), paymentType: o.payment_type, isUrgent: o.is_urgent,
    artistLocation: o.artist_location, paperSize: p.paper_size,
    subjectCount: p.num_subjects ? `${p.num_subjects}_subjects` : null,
    frameType: p.frame_type, pickupOption: p.pickup_option, deliveryAddress: checkoutDetails.deliveryAddress || null, urgentDeadline: p.urgent_deadline,
    customerNote: p.customer_note,
    referencePhotos: (o.referencePhotos || []).map(photo => photo.cloudinary_url),
    proofImagePath: o.proofImages?.find(proof => proof.is_current)?.cloudinary_url || null,
    messages: [...(o.messages || [])]
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(m => ({ ...m, senderType: m.sender_type, message: m.message_text })),
    allowedTransitions: allowedTransitions(o.status, p),
  };
};

const customerJson = (instance) => {
  const customer = instance.toJSON();
  const orders = (customer.orders || []).map(orderJson).filter(Boolean).map(order => ({
    id: order.id,
    currency: order.currency,
    totalPrice: order.totalPrice,
    amountPaid: order.amountPaid,
    status: order.status,
    paperSize: order.paperSize,
    frameType: order.frameType,
    pickupOption: order.pickupOption,
    createdAt: order.createdAt,
  }));
  return {
    id: customer.customer_id,
    username: customer.username,
    fullName: customer.full_name || customer.username,
    email: customer.email,
    phone: customer.phone_number,
    address: customer.address,
    profileImageUrl: customer.profile_image_url,
    createdAt: customer.createdAt,
    orders,
    lastOrderAt: orders.reduce((latest, order) => {
      const created = order.createdAt ? new Date(order.createdAt).getTime() : 0;
      return created > latest ? created : latest;
    }, 0) || null,
  };
};

// ─── Auth middleware ─────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ACTIVITY NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

router.get('/activity-notifications/stream', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const listener = (event) => sendEvent('notification', event);
  const unsubscribe = realtimeNotificationHub.subscribe({
    type: 'admin',
    userId: req.session.adminId,
    listener,
  });

  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 15000);

  sendEvent('connected', { status: 'connected', adminId: req.session.adminId });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.get('/activity-notifications', requireAdmin, async (req, res) => {
  try {
    await ensureUrgentDeadlineNotifications();
    const { page, limit, offset } = paginationFrom(req.query);
    const [result, unreadCount] = await Promise.all([
      db.AdminNotification.findAndCountAll({
        where: { admin_id: req.session.adminId },
        order: [['createdAt', 'DESC']],
        limit,
        offset,
      }),
      db.AdminNotification.count({ where: { admin_id: req.session.adminId, is_read: false } }),
    ]);
    const { count, rows: notifications } = result;
    res.json({
      notifications,
      unreadCount,
      pagination: paginationMeta(count, page, limit),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/email-deliveries', requireAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginationFrom(req.query);
    const status = req.query.status ? String(req.query.status).trim() : null;
    const where = status ? { status } : {};

    const { count, rows } = await db.EmailDelivery.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    res.json({
      deliveries: rows,
      pagination: paginationMeta(count, page, limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/activity-notifications/read-all', requireAdmin, async (req, res) => {
  try {
    await db.AdminNotification.update(
      { is_read: true },
      { where: { admin_id: req.session.adminId, is_read: false } },
    );
    const unreadCount = await db.AdminNotification.count({
      where: { admin_id: req.session.adminId, is_read: false },
    });
    realtimeNotificationHub.emit({
      type: 'admin',
      userId: req.session.adminId,
      event: { type: 'admin_notification_count', unreadCount },
    });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/activity-notifications/:id/read', requireAdmin, async (req, res) => {
  try {
    const notification = await db.AdminNotification.findOne({
      where: { id: req.params.id, admin_id: req.session.adminId },
    });
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    await notification.update({ is_read: true });
    const unreadCount = await db.AdminNotification.count({
      where: { admin_id: req.session.adminId, is_read: false },
    });
    realtimeNotificationHub.emit({
      type: 'admin',
      userId: req.session.adminId,
      event: { type: 'admin_notification_count', unreadCount },
    });
    res.json({ message: 'Notification marked as read', notification });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/activity-notifications/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await db.AdminNotification.destroy({
      where: { id: req.params.id, admin_id: req.session.adminId },
    });
    if (!deleted) return res.status(404).json({ error: 'Notification not found' });
    const unreadCount = await db.AdminNotification.count({
      where: { admin_id: req.session.adminId, is_read: false },
    });
    realtimeNotificationHub.emit({
      type: 'admin',
      userId: req.session.adminId,
      event: { type: 'admin_notification_count', unreadCount },
    });
    res.json({ message: 'Notification deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN PROFILE  (Settings page reads and writes these)
// ════════════════════════════════════════════════════════════════════════════

router.get('/profile', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId, {
      attributes: { exclude: ['passwordHash'] },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json(admin);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/notifications', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const updated = { ...admin.notifPreferences, ...req.body };
    await admin.update({ notifPreferences: updated });

    res.json({ message: 'Notification preferences saved', notifPreferences: admin.notifPreferences });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRICING CONFIG
// ════════════════════════════════════════════════════════════════════════════

router.get('/pricing', requireAdmin, async (req, res) => {
  try {
    const rows = await db.PriceConfig.findAll({ order: [['id', 'ASC']] });
    const preview = await calculatePrice({
      paperSize: 'A3', subjectCount: 'one',
      frameType: 'without_frame', pickupOption: 'courier', isUrgent: false,
    });

    res.json({ rows, preview });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/pricing/:id', requireAdmin, async (req, res) => {
  try {
    const row = await db.PriceConfig.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Price config not found' });

    const { price, description, isActive } = req.body;
    if (price !== undefined && (isNaN(price) || parseFloat(price) < 0)) {
      return res.status(400).json({ error: 'Price must be a non-negative number' });
    }

    await row.update({
      ...(price     !== undefined && { price: parseFloat(price) }),
      ...(description !== undefined && { description }),
      ...(isActive    !== undefined && { isActive }),
    });

    res.json({ message: 'Price updated', row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/pricing/calculate', async (req, res) => {
  try {
    const { paperSize, subjectCount, frameType, pickupOption, isUrgent } = req.body;
    const result = await calculatePrice({ paperSize, subjectCount, frameType, pickupOption, isUrgent });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════════════════

router.get('/orders', requireAdmin, async (req, res) => {
  try {
    await ensureUrgentDeadlineNotifications();
    const { page, limit, offset } = paginationFrom(req.query);
    const queueRows = await db.Order.findAll({
      attributes: ['order_id', 'status', 'is_urgent', 'calculated_price', 'amount_paid', 'createdAt'],
      include: [{ model: db.ProductOption, as: 'productOption', attributes: ['urgent_deadline', 'num_subjects'] }],
    });
    const stats = {
      total:       queueRows.filter(o => o.status !== 'done').length,
      inQueue:     queueRows.filter(o => o.status === 'in_queue').length,
      sketching:     queueRows.filter(o => o.status === 'sketching').length,
      urgentActive:   queueRows.filter(o => o.is_urgent && o.status !== 'done').length,
      waitingFeedback: queueRows.filter(o => o.status === 'waiting_for_feedback').length,
      revisionRequested: queueRows.filter(o => o.status === 'revision_requested').length,
      approved:     queueRows.filter(o => ['approved', 'finished'].includes(o.status)).length,
      totalValue:    queueRows.reduce((sum, o) => sum + Number(o.calculated_price || 0), 0),
      totalCollected:  queueRows.reduce((sum, o) => sum + Number(o.amount_paid || 0), 0),
    };
    const orderedIds = sortProductionQueue(queueRows).slice(offset, offset + limit).map(order => order.order_id);
    const pageRows = orderedIds.length ? await db.Order.findAll({
      where: { order_id: orderedIds },
      include: [
        { model: db.Customer, as: 'customer', attributes: ['customer_id', 'username', 'full_name', 'email', 'phone_number'] },
        { model: db.ProductOption, as: 'productOption' },
        { model: db.Payment, as: 'payments', attributes: ['paymentId', 'amount', 'status', 'currency', 'createdAt'] },
        { model: db.Message, as: 'messages', attributes: ['message_id', 'sender_type', 'message_text', 'createdAt'], separate: true, limit: 1, order: [['createdAt', 'DESC']] },
      ],
    }) : [];
    const byId = new Map(pageRows.map(order => [order.order_id, order]));
    const orders = orderedIds.map(id => byId.get(id)).filter(Boolean).map(orderJson);
    res.json({ orders, stats, pagination: paginationMeta(queueRows.length, page, limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const { page, limit, offset } = paginationFrom(req.query);
    const { count, rows: customers } = await db.Customer.findAndCountAll({
      attributes: ['customer_id', 'username', 'full_name', 'email', 'phone_number', 'address', 'profile_image_url', 'createdAt'],
      include: [{
        model: db.Order,
        as: 'orders',
        attributes: ['order_id', 'currency', 'calculated_price', 'amount_paid', 'status', 'createdAt'],
      }],
      order: [['createdAt', 'DESC']],
      distinct: true,
      limit,
      offset,
    });
    res.json({ customers: customers.map(customerJson), pagination: paginationMeta(count, page, limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await db.Order.findByPk(req.params.id, {
      include: [
        { model: db.Customer, as: 'customer' },
        { model: db.Message,  as: 'messages', order: [['createdAt', 'ASC']] },
        { model: db.ProductOption, as: 'productOption' },
        { model: db.ReferencePhoto, as: 'referencePhotos' },
        { model: db.ProofImage, as: 'proofImages' },
        { model: db.Payment, as: 'payments' },
      ],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(orderJson(order));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/orders/:id/reference-photos/:index/download', requireAdmin, async (req, res) => {
  try {
    const index = Number.parseInt(req.params.index, 10);
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid photo index' });

    const order = await db.Order.findByPk(req.params.id, {
      include: [{ model: db.ReferencePhoto, as: 'referencePhotos' }],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const photo = order.referencePhotos?.[index];
    if (!photo?.cloudinary_url) return res.status(404).json({ error: 'Reference photo not found' });

    const url = new URL(photo.cloudinary_url);
    if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com') {
      return res.status(400).json({ error: 'Unsupported reference photo source' });
    }

    const filename = `order-${order.order_id.slice(0, 8)}-reference-${index + 1}`;
    const downloadUrl = photo.cloudinary_url.replace('/upload/', `/upload/fl_attachment:${filename}/`);
    return res.redirect(downloadUrl);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await db.Order.findByPk(req.params.id, {
      include: [
        { model: db.ReferencePhoto, as: 'referencePhotos' },
        { model: db.ProofImage, as: 'proofImages' },
      ],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const productId = order.product_id;
    const publicIds = [
      ...(order.referencePhotos || []).map(photo => photo.cloudinary_public_id),
      ...(order.proofImages || []).map(proof => proof.cloudinary_public_id),
    ].filter(Boolean);

    await db.sequelize.transaction(async transaction => {
      await db.Message.destroy({ where: { order_id: order.order_id }, transaction });
      await db.ReferencePhoto.destroy({ where: { order_id: order.order_id }, transaction });
      await db.ProofImage.destroy({ where: { order_id: order.order_id }, transaction });
      await db.Payment.destroy({ where: { order_id: order.order_id }, transaction });
      await order.destroy({ transaction });
      if (productId) await db.ProductOption.destroy({ where: { product_id: productId }, transaction });
    });

    await Promise.allSettled(publicIds.map(deleteImage));
    const cancellationReason = req.body?.reason?.trim();
    await createNotification(
      order.customer_id,
      null,
      'Order cancelled',
      cancellationReason
        ? `Your portrait order was cancelled by the studio. Reason: ${cancellationReason}`
        : 'Your portrait order was cancelled by the studio.',
      'cancelled',
    );
    await createAdminNotification({
      adminId: req.session.adminId,
      type: 'order',
      title: 'Order cancelled',
      message: `Order #${order.order_id.slice(0, 8)} was permanently deleted${cancellationReason ? `: ${cancellationReason}` : '.'}`,
    });

    res.json({ message: 'Order cancelled and deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, customMessage } = req.body;
    if (!ORDER_STATUSES.includes(normalizeStatus(status))) return res.status(400).json({ error: 'Invalid status' });

    const order = await db.Order.findByPk(req.params.id, {
      include: [{ model: db.Customer, as: 'customer' }],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const product = await order.getProductOption();
    const requested = normalizeStatus(status);
    if (!canTransition(order.status, requested, product)) {
      return res.status(400).json({ error: 'This status change is not available at the current workflow stage' });
    }
    if (status === 'framed' && (!product?.frame_type || product.frame_type === 'without_frame')) {
      return res.status(400).json({ error: 'Framed status is only available for framed orders' });
    }
    if (status === 'shipped' && product?.pickup_option !== 'courier') {
      return res.status(400).json({ error: 'Shipped status is only available for courier orders' });
    }

    const statusUpdate = {
      status: requested,
      ...(requested === 'done' ? { completed_at: new Date() } : {}),
    };
    if (requested === 'sketching' && !order.sketching_started_at) {
      const sketchingStartedAt = new Date();
      statusUpdate.sketching_started_at = sketchingStartedAt;
      statusUpdate.estimated_completion_at = calculateCompletionFromSketchingStart({
        start: sketchingStartedAt,
        isUrgent: Boolean(order.is_urgent || product?.is_urgent),
        urgentDeadline: product?.urgent_deadline,
        people: product?.num_subjects,
      });
    }

    // 💡 duplicate ඊමේල් වළක්වමින් සහ Done නම් Thank You ඊමේල් එක යවමින් ස්ටේටස් අප්ඩේට් කිරීම
    if (order.status !== requested) {
      await order.update(statusUpdate);

      if (requested === 'done') {
        await sendThankYouEmail(order.customer.email, order.customer.full_name || order.customer.username, order.order_id);
      } else {
        await sendStatusUpdateEmail(order.customer.email, order.customer.full_name || order.customer.username, order.order_id, requested);
      }
    } else {
      await order.update(statusUpdate);
    }

    if (status === 'shipped' && order.pickupOption === 'pickup') {
      const admin = await db.Admin.findByPk(req.session.adminId);
      const location = order.artistLocation || admin?.businessAddress || process.env.STUDIO_LOCATION || 'Contact admin for pickup address';
      await db.Message.create({ order_id: order.order_id, sender_type: 'system', message_text: `Your order is ready for pickup. Location: ${location}` });
    }

    // Notification එක සෑදීම
    let title = '📌 Order Status Updated';
    let message = customMessage || `Your order status has been updated to ${status}.`;

    if (status === 'sketching') {
      title = '🎨 Artist Started Sketching!';
      message = customMessage || 'Our artist has started working on your pencil portrait!';
    } else if (status === 'waiting_for_feedback') {
      title = '🖼️ Portrait Proof Ready!';
      message = customMessage || 'Your portrait drawing is complete! Please review the proof image.';
    } else if (status === 'finished' || status === 'framed') {
      title = '✨ Portrait Finished & Framed!';
      message = customMessage || 'Your portrait drawing is completed and framed perfectly.';
    } else if (status === 'shipped') {
      title = '📦 Order Dispatched / Ready!';
      message = customMessage || 'Your portrait package is on its way or ready for pickup!';
    } else if (status === 'done') {
      title = '🎉 Order Completed!';
      message = customMessage || 'Your portrait order has been delivered and completed!';
    }

    await createNotification(order.customer_id, order.order_id, title, message, status);

    res.json({ message: 'Status updated and notification created', order });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/orders/:id/proof', requireAdmin, (req, res) => {
  uploadProof(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    try {
      const order = await db.Order.findByPk(req.params.id, {
        include: [{ model: db.Customer, as: 'customer' }],
      });
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const transaction = await db.sequelize.transaction();
      try {
        const version = (await db.ProofImage.count({ where: { order_id: order.order_id }, transaction })) + 1;
        const duplicateVersion = await db.ProofImage.findOne({
          where: { order_id: order.order_id, version },
          transaction,
        });

        if (duplicateVersion) {
          await transaction.rollback();
          return res.status(409).json({ error: 'This proof version already exists.' });
        }

        await db.ProofImage.update({ is_current: false }, {
          where: { order_id: order.order_id },
          transaction,
        });

        const proof = await db.ProofImage.create({
          order_id: order.order_id,
          cloudinary_url: req.file.path,
          cloudinary_public_id: req.file.filename,
          version,
          is_current: true,
          original_filename: req.file.originalname,
          file_size_bytes: req.file.size,
        }, { transaction });

        await order.update({
          proof_uploaded_at: new Date(),
          status: 'waiting_for_feedback',
        }, { transaction });

        await db.Message.create({
          order_id: order.order_id,
          sender_type: 'system',
          message_text: 'The artist has uploaded your proof image. Please review and approve or request changes.',
        }, { transaction });

        await createNotification(
          order.customer_id,
          order.order_id,
          '🖼️ New Proof Image Uploaded',
          'The artist has uploaded a proof of your portrait! Please check and give feedback.',
          'waiting_for_feedback',
          { transaction }
        );

        await transaction.commit();

        const customerName = order.customer?.full_name || order.customer?.username || 'Customer';
        await sendProofReadyEmail(order.customer.email, customerName, order.order_id, version);

        res.json({ message: 'Proof uploaded, customer notified', proofUrl: proof.cloudinary_url });
      } catch (transactionError) {
        await transaction.rollback();
        throw transactionError;
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

router.post('/orders/:id/messages', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    const msg = await db.Message.create({ order_id: req.params.id, sender_type: 'admin', sender_id: req.session.adminId, message_text: message.trim() });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/orders/:id/location', requireAdmin, async (req, res) => {
  try {
    const { artistLocation } = req.body;
    const order = await db.Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await order.update({ artist_location: artistLocation });
    res.json({ message: 'Location saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;