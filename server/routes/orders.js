const express = require('express');
const router = express.Router();
const db = require('../models');
const { Notification } = db;
const { protect } = require('../middleware/authMiddleware');
const { createAdminNotification } = require('../utils/adminNotificationHelper');
const { paginationFrom, paginationMeta } = require('../utils/pagination');

router.get('/my-orders', protect, async (req, res) => {
  try {
    const { page, limit, offset } = paginationFrom(req.query);
    const { count, rows: orders } = await db.Order.findAndCountAll({
      where: { customer_id: req.user.customerId },
      include: [
        { model: db.ProductOption, as: 'productOption' },
        { model: db.ReferencePhoto, as: 'referencePhotos' },
        { model: db.ProofImage, as: 'proofImages' },
        { model: db.Payment, as: 'payments' },
        { model: db.Message, as: 'messages' },
      ],
      order: [
        ['createdAt', 'DESC'],
        [{ model: db.ReferencePhoto, as: 'referencePhotos' }, 'sort_order', 'ASC'],
        [{ model: db.ProofImage, as: 'proofImages' }, 'version', 'DESC'],
        [{ model: db.Message, as: 'messages' }, 'createdAt', 'ASC'],
      ],
      distinct: true,
      limit,
      offset,
    });

    res.set('X-Pagination', JSON.stringify(paginationMeta(count, page, limit)));
    res.json(orders.map(instance => {
      const order = instance.toJSON();
      const product = order.productOption || {};
      const completedPayments = (order.payments || []).filter(payment => payment.status === 'completed');
      const amountPaid = completedPayments.reduce((total, payment) => total + Number(payment.amount || 0), 0)
        || Number(order.amount_paid || 0);
      const currentProof = (order.proofImages || []).find(proof => proof.is_current);
      const checkoutDetails = (completedPayments[0] || order.payments?.[0])?.metadata?.order || {};

      return {
        id: order.order_id,
        // A revision returns to active drawing for the customer, while the
        // admin retains the actionable revision_requested state.
        status: order.status === 'revision_requested' ? 'sketching' : order.status,
        workflowStatus: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        sketchingStartedAt: order.sketching_started_at,
        estimatedCompletionAt: order.estimated_completion_at,
        completedAt: order.completed_at,
        approvedAt: order.approved_at,
        paperSize: product.paper_size,
        subjectCount: product.num_subjects,
        frameType: product.frame_type,
        pickupOption: product.pickup_option,
        deliveryAddress: checkoutDetails.deliveryAddress || null,
        isUrgent: Boolean(order.is_urgent || product.is_urgent),
        urgentDeadline: product.urgent_deadline,
        customerNote: product.customer_note,
        artistLocation: order.artist_location,
        currency: order.currency,
        totalPrice: Number(order.calculated_price || 0),
        amountPaid,
        balanceDue: Math.max(0, Number(order.calculated_price || 0) - amountPaid),
        paymentType: order.payment_type,
        payments: (order.payments || []).map(payment => ({
          id: payment.paymentId,
          providerOrderId: payment.payhereOrderId,
          amount: Number(payment.amount || 0),
          currency: payment.currency,
          method: payment.paymentMethod,
          status: payment.status,
          transactionId: payment.transactionId || payment.payherePaymentId,
          createdAt: payment.createdAt,
        })),
        referencePhotos: (order.referencePhotos || []).map(photo => ({
          id: photo.ref_id,
          url: photo.cloudinary_url,
          fileName: photo.original_filename,
        })),
        proof: currentProof ? {
          id: currentProof.proof_id,
          url: currentProof.cloudinary_url,
          version: currentProof.version,
          reviewStatus: currentProof.review_status,
          artistNote: currentProof.artist_note,
          revisionNote: currentProof.revision_note,
          uploadedAt: currentProof.createdAt,
          reviewedAt: currentProof.reviewed_at,
        } : null,
        // Kept for the existing profile screen while it transitions to the
        // dedicated My Orders page.
        proofImagePath: currentProof?.cloudinary_url || null,
        messages: (order.messages || []).map(message => ({
          id: message.message_id,
          senderType: message.sender_type,
          message: message.message_text,
          createdAt: message.createdAt,
        })),
      };
    }));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/messages', protect, async (req, res) => {
  try {
    const order = await db.Order.findOne({ where: { order_id: req.params.id, customer_id: req.user.customerId } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!req.body.message?.trim()) return res.status(400).json({ error: 'Message is required' });
    const message = await db.Message.create({ order_id: order.order_id, sender_type: 'customer', sender_id: String(req.user.customerId), message_text: req.body.message.trim() });
    await createAdminNotification({
      orderId: order.order_id,
      type: 'message',
      title: 'New customer message',
      message: `A customer sent a message about order #${order.order_id.slice(0, 8)}.`,
    });
    res.status(201).json(message);
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
    await createAdminNotification({
      orderId: order.order_id,
      type: approved ? 'approval' : 'revision',
      title: approved ? 'Proof approved' : 'Revision requested',
      message: approved
        ? `The customer approved the proof for order #${order.order_id.slice(0, 8)}.`
        : `The customer requested changes to order #${order.order_id.slice(0, 8)}.`,
    });
    res.json({ message: approved ? 'Proof approved' : 'Revision requested', status: order.status });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 1. For the customer to receive their notifications in real-time (GET /api/orders/notifications)
router.get('/notifications', protect, async (req, res) => {
  try {
    const customerId = req.user.customerId;
    const { page, limit, offset } = paginationFrom(req.query);

    const { count, rows: notifications } = await Notification.findAndCountAll({
      where: { customerId: customerId },
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    res.set('X-Pagination', JSON.stringify(paginationMeta(count, page, limit)));
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching notifications', error: error.message });
  }
});

router.patch('/notifications/read-all', protect, async (req, res) => {
  try {
    await Notification.update(
      { isRead: true },
      { where: { customerId: req.user.customerId, isRead: false } },
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/notifications/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findOne({
      where: { id: req.params.id, customerId: req.user.customerId },
    });
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    await notification.update({ isRead: true });
    res.json({ message: 'Notification marked as read', notification });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/notifications/:id', protect, async (req, res) => {
  try {
    const deleted = await Notification.destroy({
      where: { id: req.params.id, customerId: req.user.customerId },
    });
    if (!deleted) return res.status(404).json({ error: 'Notification not found' });
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
