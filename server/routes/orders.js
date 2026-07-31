// server/routes/orders.js
// Handles order creation (customer side) and order management (admin side).
// Mount in index.js as:  app.use('/api/orders', ordersRouter);

const express  = require('express');
const router   = express.Router();
const db       = require('../models');
const { uploadReferences } = require('../middleware/upload');
const { calculatePrice }   = require('../middleware/pricingEngine');
const { sendProofReadyEmail, sendStatusUpdateEmail } = require('../middleware/email');

// ── Auth helpers ──────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

function getCustomerId(req) {
  // Customer auth: JWT in Authorization header
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.customerId;
  } catch { return null; }
}

function requireCustomer(req, res, next) {
  req.customerId = getCustomerId(req);
  if (!req.customerId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER — place and view their own orders
// ════════════════════════════════════════════════════════════════════════════

// POST /api/orders
// Customer places a new order. Accepts multipart/form-data so reference
// photos can be uploaded in the same request.
router.post('/', requireCustomer, (req, res) => {
  uploadReferences(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    try {
      const {
        paper_size, num_subjects, frame_type,
        pickup_option, is_urgent, urgent_deadline,
        customer_note, payment_type, currency,
      } = req.body;

      // 1. Calculate price from DB config
      const { total } = await calculatePrice({
        paperSize:    paper_size,
        subjectCount: num_subjects === '1' ? 'one' : num_subjects === '2' ? 'two' : 'more_than_two',
        frameType:    frame_type,
        pickupOption: pickup_option,
        isUrgent:     is_urgent === 'true' || is_urgent === true,
      });

      // 2. Create ProductOption row
      const productOption = await db.ProductOption.create({
        paper_size,
        num_subjects:    parseInt(num_subjects) || 1,
        frame_type:      frame_type      || 'without_frame',
        pickup_option:   pickup_option   || 'pickup',
        is_urgent:       is_urgent === 'true' || is_urgent === true,
        urgent_deadline: urgent_deadline || null,
        customer_note:   customer_note   || null,
      });

      // 3. Create Order row
      const order = await db.Order.create({
        customer_id:      req.customerId,
        product_id:       productOption.product_id,
        calculated_price: total,
        currency:         currency || 'LKR',
        payment_type:     payment_type || 'advance',
        is_urgent:        is_urgent === 'true' || is_urgent === true,
        status:           'in_queue',
      });

      // Update ProductOption with the order_id back-reference
      await productOption.update({ order_id: order.order_id });

      // 4. Save reference photos (uploaded to Cloudinary by multer middleware)
      if (req.files && req.files.length > 0) {
        const photoRows = req.files.map((file, idx) => ({
          order_id:             order.order_id,
          cloudinary_url:       file.path,      // full Cloudinary HTTPS URL
          cloudinary_public_id: file.filename,  // Cloudinary public_id
          original_filename:    file.originalname,
          file_size_bytes:      file.size,
          mime_type:            file.mimetype,
          sort_order:           idx,
        }));
        await db.ReferencePhoto.bulkCreate(photoRows);
      }

      // 5. Auto system message
      await db.Message.create({
        order_id:    order.order_id,
        sender_type: 'system',
        message_text: `Order #${order.order_id.slice(0,8)} received! We'll start working on it soon.`,
      });

      res.status(201).json({
        message: 'Order placed successfully',
        order_id: order.order_id,
        calculated_price: total,
        status: order.status,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });
});

// GET /api/orders/mine — customer views their own orders
router.get('/mine', requireCustomer, async (req, res) => {
  try {
    const orders = await db.Order.findAll({
      where: { customer_id: req.customerId },
      include: [
        { model: db.ProductOption,  as: 'productOption' },
        { model: db.ReferencePhoto, as: 'referencePhotos' },
        {
          model: db.ProofImage, as: 'proofImages',
          where: { is_current: true }, required: false,
        },
        { model: db.Message, as: 'messages', order: [['createdAt', 'ASC']] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/:order_id — single order detail (customer must own it)
router.get('/:order_id', requireCustomer, async (req, res) => {
  try {
    const order = await db.Order.findOne({
      where: { order_id: req.params.order_id, customer_id: req.customerId },
      include: [
        { model: db.ProductOption,  as: 'productOption'  },
        { model: db.ReferencePhoto, as: 'referencePhotos' },
        { model: db.ProofImage,     as: 'proofImages'     },
        { model: db.Payment,        as: 'payments'        },
        { model: db.Message,        as: 'messages', order: [['createdAt', 'ASC']] },
      ],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Mark admin messages as read when customer views the order
    await db.Message.update(
      { is_read: true, read_at: new Date() },
      { where: { order_id: order.order_id, sender_type: 'admin', is_read: false } }
    );

    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:order_id/approve — customer approves the proof
router.post('/:order_id/approve', requireCustomer, async (req, res) => {
  try {
    const order = await db.Order.findOne({
      where: { order_id: req.params.order_id, customer_id: req.customerId },
      include: [{ model: db.Customer, as: 'customer' }],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'waiting_for_feedback') {
      return res.status(400).json({ error: 'Order is not awaiting feedback' });
    }

    // Mark current proof as approved
    await db.ProofImage.update(
      { review_status: 'approved', reviewed_at: new Date() },
      { where: { order_id: order.order_id, is_current: true } }
    );

    const isFullyPaid = order.payment_type === 'full' ||
      parseFloat(order.amount_paid) >= parseFloat(order.calculated_price);

    if (isFullyPaid) {
      await order.update({ status: 'approved', approved_at: new Date() });
      await db.Message.create({
        order_id: order.order_id, sender_type: 'system',
        message_text: 'You approved the proof! Your order is now being finished.',
      });
      return res.json({ message: 'Proof approved', requiresPayment: false });
    } else {
      // Half-paid: needs remaining payment before moving forward
      const remaining = parseFloat(order.calculated_price) - parseFloat(order.amount_paid);
      return res.json({
        message: 'Proof approved. Please complete the remaining payment.',
        requiresPayment: true,
        remainingAmount: remaining.toFixed(2),
        currency: order.currency,
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:order_id/revision — customer requests changes
router.post('/:order_id/revision', requireCustomer, async (req, res) => {
  try {
    const { note } = req.body;
    const order = await db.Order.findOne({
      where: { order_id: req.params.order_id, customer_id: req.customerId },
      include: [{ model: db.Customer, as: 'customer' }],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Mark current proof as revision_requested
    await db.ProofImage.update(
      { review_status: 'revision_requested', revision_note: note, reviewed_at: new Date() },
      { where: { order_id: order.order_id, is_current: true } }
    );

    await order.update({ status: 'revision_requested' });

    await db.Message.create({
      order_id: order.order_id, sender_type: 'customer',
      sender_id: String(req.customerId),
      message_text: note ? `Revision request: ${note}` : 'Customer requested a revision.',
    });
    await db.Message.create({
      order_id: order.order_id, sender_type: 'system',
      message_text: 'Revision requested. The artist has been notified.',
    });

    res.json({ message: 'Revision request sent' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:order_id/messages — customer sends a chat message
router.post('/:order_id/messages', requireCustomer, async (req, res) => {
  try {
    const { message_text } = req.body;
    if (!message_text?.trim()) return res.status(400).json({ error: 'Message is required' });

    const order = await db.Order.findOne({
      where: { order_id: req.params.order_id, customer_id: req.customerId },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const msg = await db.Message.create({
      order_id: order.order_id,
      sender_type: 'customer',
      sender_id: String(req.customerId),
      message_text: message_text.trim(),
    });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — view and manage all orders
// ════════════════════════════════════════════════════════════════════════════

// GET /api/orders/admin/all — all orders for the dashboard table
router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const orders = await db.Order.findAll({
      include: [
        { model: db.Customer,      as: 'customer',      attributes: ['customer_id','full_name','email','phone_number'] },
        { model: db.ProductOption, as: 'productOption'  },
        { model: db.ProofImage,    as: 'proofImages', where: { is_current: true }, required: false },
      ],
      order: [['is_urgent','DESC'], ['createdAt','ASC']],
    });

    const stats = {
      total:           orders.length,
      inQueue:         orders.filter(o => o.status === 'in_queue').length,
      sketching:       orders.filter(o => o.status === 'sketching').length,
      waitingFeedback: orders.filter(o => o.status === 'waiting_for_feedback').length,
      urgentActive:    orders.filter(o => o.is_urgent && !['done','finished'].includes(o.status)).length,
    };

    res.json({ orders, stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/admin/:order_id — full order detail for the panel
router.get('/admin/:order_id', requireAdmin, async (req, res) => {
  try {
    const order = await db.Order.findByPk(req.params.order_id, {
      include: [
        { model: db.Customer,       as: 'customer'       },
        { model: db.ProductOption,  as: 'productOption'  },
        { model: db.ReferencePhoto, as: 'referencePhotos'},
        { model: db.ProofImage,     as: 'proofImages'    },
        { model: db.Payment,        as: 'payments'       },
        { model: db.Message,        as: 'messages', order:[['createdAt','ASC']] },
      ],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/orders/admin/:order_id/status — admin updates order status
router.patch('/admin/:order_id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['in_queue','sketching','waiting_for_feedback','revision_requested',
      'approved','finished','framed','shipped','done'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const order = await db.Order.findByPk(req.params.order_id, {
      include: [{ model: db.Customer, as: 'customer' }],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await order.update({ status });

    // Auto-post pickup location when order is shipped
    if (status === 'shipped' && order.productOption?.pickup_option === 'pickup') {
      const admin = await db.Admin.findByPk(req.session.adminId);
      const location = order.artist_location || admin?.businessAddress || 'Contact us for pickup address';
      await db.Message.create({
        order_id: order.order_id, sender_type: 'system',
        message_text: `📍 Your order is ready for pickup!\nLocation: ${location}`,
      });
    }

    await sendStatusUpdateEmail(order.customer.email, order.customer.full_name, order.order_id, status);
    res.json({ message: 'Status updated', order });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/admin/:order_id/proof — admin uploads proof image
const { uploadProof } = require('../middleware/upload');
router.post('/admin/:order_id/proof', requireAdmin, (req, res) => {
  uploadProof(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    try {
      const order = await db.Order.findByPk(req.params.order_id, {
        include: [{ model: db.Customer, as: 'customer' }],
      });
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // Mark all previous proofs as not current
      await db.ProofImage.update(
        { is_current: false },
        { where: { order_id: order.order_id } }
      );

      // Count existing proofs to set version number
      const proofCount = await db.ProofImage.count({ where: { order_id: order.order_id } });

      // Create new proof record
      const proof = await db.ProofImage.create({
        order_id:             order.order_id,
        cloudinary_url:       req.file.path,
        cloudinary_public_id: req.file.filename,
        original_filename:    req.file.originalname,
        file_size_bytes:      req.file.size,
        version:              proofCount + 1,
        is_current:           true,
        review_status:        'pending',
        artist_note:          req.body.artist_note || null,
      });

      await order.update({ status: 'waiting_for_feedback', proof_uploaded_at: new Date() });

      await db.Message.create({
        order_id: order.order_id, sender_type: 'system',
        message_text: 'Your proof image is ready! Please review and approve or request changes.',
      });

      await sendProofReadyEmail(order.customer.email, order.customer.full_name, order.order_id);
      res.json({ message: 'Proof uploaded, customer notified', proof });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// POST /api/orders/admin/:order_id/messages — admin sends chat message
router.post('/admin/:order_id/messages', requireAdmin, async (req, res) => {
  try {
    const { message_text } = req.body;
    if (!message_text?.trim()) return res.status(400).json({ error: 'Message required' });

    const msg = await db.Message.create({
      order_id:    req.params.order_id,
      sender_type: 'admin',
      sender_id:   req.session.adminId,
      message_text: message_text.trim(),
    });
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/orders/admin/:order_id/location — set pickup address
router.patch('/admin/:order_id/location', requireAdmin, async (req, res) => {
  try {
    const { artist_location } = req.body;
    const order = await db.Order.findByPk(req.params.order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await order.update({ artist_location });
    res.json({ message: 'Location saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;