const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const db       = require('../models');
const { uploadProof }          = require('../middleware/upload');
const { sendProofReadyEmail, sendStatusUpdateEmail } = require('../middleware/email');
const { calculatePrice, loadPrices }                = require('../middleware/pricingEngine');

// ─── Auth middleware ─────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════

// POST /admin/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await db.Admin.findOne({ where: { username } });
    if (!admin || !(await admin.checkPassword(password))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.adminId = admin.id;
    res.json({
      message: 'Logged in',
      admin: {
        id: admin.id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        businessName: admin.businessName,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/logout
router.post('/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

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

// PATCH /admin/profile  — update name, email, phone
router.patch('/profile', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const { firstName, lastName, email, phone } = req.body;
    await admin.update({ firstName, lastName, email, phone });

    res.json({
      message: 'Profile updated',
      admin: { firstName: admin.firstName, lastName: admin.lastName, email: admin.email, phone: admin.phone },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /admin/business  — update business name, email, address
router.patch('/business', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const { businessName, businessEmail, businessAddress } = req.body;
    await admin.update({ businessName, businessEmail, businessAddress });

    res.json({ message: 'Business info updated' });
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

// PATCH /admin/password  — change password
router.patch('/password', requireAdmin, async (req, res) => {
  try {
    const admin = await db.Admin.findByPk(req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const { currentPassword, newPassword } = req.body;
    if (!(await admin.checkPassword(currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    await admin.update({ passwordHash: await db.Admin.hashPassword(newPassword) });
    res.json({ message: 'Password updated successfully' });
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
      frameType: 'without_frame', pickupOption: 'pickup', isUrgent: false,
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

// POST /admin/pricing/calculate  — live price calculation for any option combo
// The frontend calls this when the customer order form changes so it can show
// an accurate price preview before submitting.
router.post('/pricing/calculate', async (req, res) => {
  try {
    const { paperSize, subjectCount, frameType, pickupOption, isUrgent } = req.body;
    const result = await calculatePrice({ paperSize, subjectCount, frameType, pickupOption, isUrgent });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ORDERS (unchanged from before — kept here so the file is complete)
// ════════════════════════════════════════════════════════════════════════════

router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await db.Order.findAll({
      include: [{ model: db.Customer, as: 'customer', attributes: ['fullName', 'email', 'phone'] }],
      order: [['isUrgent', 'DESC'], ['createdAt', 'ASC']],
    });
    const stats = {
      total:           orders.length,
      inQueue:         orders.filter(o => o.status === 'in_queue').length,
      sketching:       orders.filter(o => o.status === 'sketching').length,
      urgentActive:    orders.filter(o => o.isUrgent && !['finished','done'].includes(o.status)).length,
      waitingFeedback: orders.filter(o => o.status === 'waiting_for_feedback').length,
    };
    res.json({ orders, stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await db.Order.findByPk(req.params.id, {
      include: [
        { model: db.Customer, as: 'customer' },
        { model: db.Message,  as: 'messages', order: [['createdAt', 'ASC']] },
      ],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['in_queue','sketching','waiting_for_feedback','finished','framed','shipped','done'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const order = await db.Order.findByPk(req.params.id, {
      include: [{ model: db.Customer, as: 'customer' }],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await order.update({ status });

    if (status === 'shipped' && order.pickupOption === 'pickup') {
      const admin = await db.Admin.findByPk(req.session.adminId);
      const location = order.artistLocation || admin?.businessAddress || process.env.STUDIO_LOCATION || 'Contact admin for pickup address';
      await db.Message.create({ orderId: order.id, senderType: 'system', message: `📍 Your order is ready for pickup! Location: ${location}` });
    }

    await sendStatusUpdateEmail(order.customer.email, order.customer.fullName, order.id, status);
    res.json({ message: 'Status updated', order });
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
      await order.update({
        proofImagePath:     req.file.path,
        proofImagePublicId: req.file.filename,
        proofUploadedAt:    new Date(),
        status:             'waiting_for_feedback',
      });
      await db.Message.create({ orderId: order.id, senderType: 'system', message: 'The artist has uploaded your proof image. Please review and approve or request changes.' });
      await sendProofReadyEmail(order.customer.email, order.customer.fullName, order.id);
      res.json({ message: 'Proof uploaded, customer notified', proofUrl: order.proofImagePath });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

router.post('/orders/:id/messages', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    const msg = await db.Message.create({ orderId: req.params.id, senderType: 'admin', senderId: req.session.adminId, message: message.trim() });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/orders/:id/location', requireAdmin, async (req, res) => {
  try {
    const { artistLocation } = req.body;
    const order = await db.Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await order.update({ artistLocation });
    res.json({ message: 'Location saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;