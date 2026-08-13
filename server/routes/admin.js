const express  = require('express');
const router   = express.Router();
const db       = require('../models');
const { uploadProof }          = require('../middleware/upload');
const { sendProofReadyEmail, sendStatusUpdateEmail } = require('../middleware/email');
const { calculatePrice, loadPrices }                = require('../middleware/pricingEngine');

// 💡 Importing the Notification Helper
const { createNotification } = require('../utils/notificationHelper');

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
  return { ...o, customer, id: o.order_id, customerId: o.customer_id, totalPrice: o.calculated_price,
    amountPaid: completedPaid || Number(o.amount_paid || 0), paymentType: o.payment_type, isUrgent: o.is_urgent,
    artistLocation: o.artist_location, paperSize: p.paper_size,
    subjectCount: p.num_subjects ? `${p.num_subjects}_subjects` : null,
    frameType: p.frame_type, pickupOption: p.pickup_option, urgentDeadline: p.urgent_deadline,
    customerNote: p.customer_note,
    referencePhotos: (o.referencePhotos || []).map(photo => photo.cloudinary_url),
    proofImagePath: o.proofImages?.find(proof => proof.is_current)?.cloudinary_url || null,
    messages: (o.messages || []).map(m => ({ ...m, senderType: m.sender_type, message: m.message_text })),
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
// ADMIN PROFILE  (Settings page reads and writes these)
// ════════════════════════════════════════════════════════════════════════════

// GET /admin/profile  — returns everything the Settings page needs
router.get('/profile', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId, {
      attributes: { exclude: ['passwordHash'] }, // never send the hash to the frontend
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json(admin);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /admin/notifications  — toggle email notification preferences
router.patch('/notifications', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    // Merge incoming prefs with existing ones
    const updated = { ...admin.notifPreferences, ...req.body };
    await admin.update({ notifPreferences: updated });

    res.json({ message: 'Notification preferences saved', notifPreferences: admin.notifPreferences });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// PRICING CONFIG  (Settings page reads and writes the price table)
// ════════════════════════════════════════════════════════════════════════════

// GET /admin/pricing  — returns all price rows + a live preview calculation
router.get('/pricing', requireAdmin, async (req, res) => {
  try {
    const rows = await db.PriceConfig.findAll({ order: [['id', 'ASC']] });

    // Also send a live preview of a typical order so the admin can see impact of changes
    const preview = await calculatePrice({
      paperSize: 'A3', subjectCount: 'one',
      frameType: 'without_frame', pickupOption: 'courier', isUrgent: false,
    });

    res.json({ rows, preview });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /admin/pricing/:id  — update a single price row
router.patch('/pricing/:id', requireAdmin, async (req, res) => {
  try {
    const row = await db.PriceConfig.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Price config not found' });

    const { price, description, isActive } = req.body;

    // Validate price
    if (price !== undefined && (isNaN(price) || parseFloat(price) < 0)) {
      return res.status(400).json({ error: 'Price must be a non-negative number' });
    }

    await row.update({
      ...(price       !== undefined && { price: parseFloat(price) }),
      ...(description !== undefined && { description }),
      ...(isActive    !== undefined && { isActive }),
    });

    res.json({ message: 'Price updated', row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/pricing/calculate
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
    const orders = await db.Order.findAll({
      include: [{ model: db.Customer, as: 'customer' }, { model: db.ProductOption, as: 'productOption' }, { model: db.ReferencePhoto, as: 'referencePhotos' }, { model: db.ProofImage, as: 'proofImages' }, { model: db.Payment, as: 'payments' }],
      order: [['is_urgent', 'DESC'], ['createdAt', 'ASC']],
    });
    const stats = {
      total:           orders.length,
      inQueue:         orders.filter(o => o.status === 'in_queue').length,
      sketching:       orders.filter(o => o.status === 'sketching').length,
      urgentActive:    orders.filter(o => o.isUrgent && !['finished','done'].includes(o.status)).length,
      waitingFeedback: orders.filter(o => o.status === 'waiting_for_feedback').length,
      totalValue:      orders.reduce((sum, o) => sum + Number(o.calculated_price || 0), 0),
      totalCollected:  orders.reduce((sum, o) => sum + Number(o.amount_paid || 0), 0),
    };
    res.json({ orders: orders.map(orderJson), stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const customers = await db.Customer.findAll({
      include: [{
        model: db.Order,
        as: 'orders',
        include: [{ model: db.ProductOption, as: 'productOption' }, { model: db.Payment, as: 'payments' }],
      }],
      order: [['createdAt', 'DESC']],
    });
    res.json({ customers: customers.map(customerJson) });
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

// 💡 status update වෙන තැනට Notification හදන කෑල්ල එකතු කර ඇත
router.patch('/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, customMessage } = req.body;
    const valid = ['in_queue','sketching','waiting_for_feedback','finished','framed','shipped','done'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const order = await db.Order.findByPk(req.params.id, {
      include: [{ model: db.Customer, as: 'customer' }],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const product = await order.getProductOption();
    if (status === 'framed' && (!product?.frame_type || product.frame_type === 'without_frame')) {
      return res.status(400).json({ error: 'Framed status is only available for framed orders' });
    }
    if (status === 'shipped' && product?.pickup_option !== 'courier') {
      return res.status(400).json({ error: 'Shipped status is only available for courier orders' });
    }

    await order.update({ status });

    if (status === 'shipped' && order.pickupOption === 'pickup') {
      const admin = await db.Admin.findByPk(req.session.adminId);
      const location = order.artistLocation || admin?.businessAddress || process.env.STUDIO_LOCATION || 'Contact admin for pickup address';
      await db.Message.create({ order_id: order.order_id, sender_type: 'system', message_text: `Your order is ready for pickup. Location: ${location}` });
    }

    // Email යැවීම
    await sendStatusUpdateEmail(order.customer.email, order.customer.full_name || order.customer.username, order.order_id, status);

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

    // Database එකේ Notification එක Save කිරීම
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
      await db.ProofImage.update({ is_current: false }, { where: { order_id: order.order_id } });
      const version = await db.ProofImage.count({ where: { order_id: order.order_id } }) + 1;
      const proof = await db.ProofImage.create({ order_id: order.order_id, cloudinary_url: req.file.path, cloudinary_public_id: req.file.filename, version, is_current: true, original_filename: req.file.originalname, file_size_bytes: req.file.size });
      await order.update({ proof_uploaded_at: new Date(), status: 'waiting_for_feedback' });
      await db.Message.create({ order_id: order.order_id, sender_type: 'system', message_text: 'The artist has uploaded your proof image. Please review and approve or request changes.' });
      await sendProofReadyEmail(order.customer.email, order.customer.fullName, order.id);

      // 💡 Proof එක Upload කළාමත් Customer ට Notification එකක් යනවා
      await createNotification(
        order.customer_id,
        order.order_id,
        '🖼️ New Proof Image Uploaded', 
        'The artist has uploaded a proof of your portrait! Please check and give feedback.', 
        'waiting_for_feedback'
      );

      res.json({ message: 'Proof uploaded, customer notified', proofUrl: proof.cloudinary_url });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
