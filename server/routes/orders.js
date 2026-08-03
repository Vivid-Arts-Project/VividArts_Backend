const express = require('express');
const router = express.Router();
const db = require('../models');
const { Notification } = db;
const { protect } = require('../middleware/authMiddleware');

router.get('/my-orders', protect, async (req, res) => {
  try {
    const orders = await db.Order.findAll({ where: { customer_id: req.user.customerId },
      include: [{ model: db.ProductOption, as: 'productOption' }, { model: db.ProofImage, as: 'proofImages' }, { model: db.Message, as: 'messages' }],
      order: [['createdAt', 'DESC']] });
    res.json(orders.map(instance => { const o = instance.toJSON(); return { ...o, id: o.order_id,
      totalPrice: o.calculated_price, amountPaid: o.amount_paid, isUrgent: o.is_urgent,
      paperSize: o.productOption?.paper_size, pickupOption: o.productOption?.pickup_option,
      proofImagePath: o.proofImages?.find(p => p.is_current)?.cloudinary_url || null,
      messages: (o.messages || []).map(m => ({ ...m, senderType: m.sender_type, message: m.message_text })) }; }));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/messages', protect, async (req, res) => {
  try {
    const order = await db.Order.findOne({ where: { order_id: req.params.id, customer_id: req.user.customerId } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!req.body.message?.trim()) return res.status(400).json({ error: 'Message is required' });
    res.status(201).json(await db.Message.create({ order_id: order.order_id, sender_type: 'customer', sender_id: String(req.user.customerId), message_text: req.body.message.trim() }));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/proof-review', protect, async (req, res) => {
  try {
    const order = await db.Order.findOne({ where: { order_id: req.params.id, customer_id: req.user.customerId }, include: [{ model: db.ProofImage, as: 'proofImages' }] });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const proof = order.proofImages.find(p => p.is_current);
    if (!proof) return res.status(400).json({ error: 'No proof is awaiting review' });
    const approved = req.body.action === 'approve';
    if (!approved && !req.body.note?.trim()) return res.status(400).json({ error: 'Please describe the requested changes' });
    await proof.update({ review_status: approved ? 'approved' : 'revision_requested', revision_note: approved ? null : req.body.note.trim(), reviewed_at: new Date() });
    await order.update({ status: approved ? 'approved' : 'revision_requested', ...(approved ? { approved_at: new Date() } : {}) });
    await db.Message.create({ order_id: order.order_id, sender_type: 'system', message_text: approved ? 'Customer approved the proof.' : `Customer requested changes: ${req.body.note.trim()}` });
    res.json({ message: approved ? 'Proof approved' : 'Revision requested', status: order.status });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 1. For the customer to receive their notifications in real-time (GET /api/orders/notifications)
router.get('/notifications', protect, async (req, res) => {
  try {
    const customerId = req.user.customerId;

    const notifications = await Notification.findAll({
      where: { customerId: customerId },
      order: [['createdAt', 'DESC']],
    });

    res.json(notifications);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching notifications', error: error.message });
  }
});

// 2. An API that automatically generates messages as the status changes from one stage to another—similar to the systems used by AliExpress or Temu.
router.post('/update-status', protect, async (req, res) => {
  try {
    const { customerId, orderId, status } = req.body;

    let title = "Order Update 🔔";
    let message = `Your order #${orderId} status is now: ${status}`;

    // Configuring auto-messages based on the status set by the admin.
    switch (status.toUpperCase()) {
      case 'CONFIRMED':
        title = "Order Confirmed! 🎉";
        message = `Your order #${orderId} has been confirmed. The artist is getting ready!`;
        break;
      case 'SKETCHING_HALF':
      case 'IN_PROGRESS':
        title = "Drawing in Progress (50%) ✏️";
        message = `Your portrait #${orderId} is half-way done! Outline & basic shading completed.`;
        break;
      case 'COMPLETED':
      case 'DRAWING_FINISHED':
        title = "Drawing Fully Completed! 🎨";
        message = `Great news! The artist finished your portrait #${orderId}.`;
        break;
      case 'PACKED':
        title = "Framed & Packed 📦";
        message = `Your portrait #${orderId} has been safely framed and packed for delivery.`;
        break;
      case 'DISPATCHED':
      case 'OUT_FOR_DELIVERY':
        title = "Out for Delivery! 🚚";
        message = `Your package #${orderId} is now with the courier and on its way to you!`;
        break;
      case 'DELIVERED':
        title = "Delivered! 🎁";
        message = `Your order #${orderId} has been delivered successfully. Thank you!`;
        break;
      default:
        title = `Order Update: ${status}`;
        message = `Order #${orderId} has been updated to ${status}.`;
    }

    // Saving the notification to the database
    const newNotification = await Notification.create({
      customerId: customerId,
      orderId: orderId,
      title: title,
      message: message,
      status: status,
      isRead: false
    });

    res.status(200).json({
      message: 'Status updated and live notification sent to user!',
      notification: newNotification
    });

  } catch (error) {
    res.status(500).json({ message: 'Failed to update order status', error: error.message });
  }
});

module.exports = router;
