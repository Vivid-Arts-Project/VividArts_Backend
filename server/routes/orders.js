const express = require('express');
const router = express.Router();
const db = require('../models');
const { Notification } = db;
const { protect } = require('../middleware/authMiddleware');
const { createAdminNotification } = require('../utils/adminNotificationHelper');
const { createNotification, resolveNotificationCustomerId } = require('../utils/notificationHelper');
const { paginationFrom, paginationMeta } = require('../utils/pagination');
const { sendRevisionRequestedAdminEmail } = require('../middleware/email');
const { uploadReview, deleteImage } = require('../middleware/upload');

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
        { model: db.Review, as: 'review' },
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
      const paymentStatus = completedPayments.length ? 'paid' : 'payment_pending';

      return {
        id: order.order_id,
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
        paymentStatus,
        payments: (order.payments || []).map(payment => ({
          id: payment.paymentId,
          providerOrderId: payment.payhereOrderId,
          amount: Number(payment.amount || 0),
          currency: payment.currency,
          method: payment.paymentMethod,
          paymentType: payment.paymentType,
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
        proofImagePath: currentProof?.cloudinary_url || null,
        messages: (order.messages || []).map(message => ({
          id: message.message_id,
          senderType: message.sender_type,
          message: message.message_text,
          createdAt: message.createdAt,
        })),
        review: order.review ? {
          id: order.review.review_id,
          rating: order.review.rating,
          title: order.review.title,
          comment: order.review.comment,
          imageUrl: order.review.image_url,
          allowPublicImage: order.review.allow_public_image,
          status: order.review.status,
          adminReply: order.review.admin_reply,
          createdAt: order.review.createdAt,
          updatedAt: order.review.updatedAt,
        } : null,
      };
    }));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Customers may discard saved checkout drafts only while no payment has been
// completed. Paid orders remain part of the permanent order and invoice record.
router.delete('/:id', protect, async (req, res) => {
  let publicIds = [];
  try {
    await db.sequelize.transaction(async transaction => {
      const order = await db.Order.findOne({
        where: { order_id: req.params.id, customer_id: req.user.customerId },
        include: [
          { model: db.ReferencePhoto, as: 'referencePhotos' },
          { model: db.ProofImage, as: 'proofImages' },
          { model: db.Payment, as: 'payments' },
          { model: db.Review, as: 'review' },
        ],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

      const hasCompletedPayment = Number(order.amount_paid || 0) > 0
        || (order.payments || []).some(payment => payment.status === 'completed');
      if (hasCompletedPayment) {
        throw Object.assign(new Error('Paid orders cannot be deleted. Please contact the studio if you need to cancel.'), { status: 409 });
      }

      publicIds = [
        ...(order.referencePhotos || []).map(photo => photo.cloudinary_public_id),
        ...(order.proofImages || []).map(proof => proof.cloudinary_public_id),
        order.review?.image_public_id,
      ].filter(Boolean);
      const productId = order.product_id;

      await db.Review.destroy({ where: { order_id: order.order_id }, transaction });
      await db.Message.destroy({ where: { order_id: order.order_id }, transaction });
      await db.ReferencePhoto.destroy({ where: { order_id: order.order_id }, transaction });
      await db.ProofImage.destroy({ where: { order_id: order.order_id }, transaction });
      await db.Payment.destroy({ where: { order_id: order.order_id }, transaction });
      await db.AdminNotification.destroy({ where: { order_id: order.order_id }, transaction });
      await order.destroy({ transaction });
      if (productId) await db.ProductOption.destroy({ where: { product_id: productId }, transaction });
    });

    await Promise.allSettled(publicIds.map(deleteImage));
    res.json({ message: 'Incomplete order deleted.' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

const reviewPayload = body => {
  const rating = Number(body.rating);
  const title = String(body.title || '').trim();
  const comment = String(body.comment || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'Choose a rating from 1 to 5 stars' };
  if (title.length < 3 || title.length > 120) return { error: 'Review title must be between 3 and 120 characters' };
  if (comment.length < 10 || comment.length > 2000) return { error: 'Review must be between 10 and 2000 characters' };
  return { rating, title, comment, allow_public_image: String(body.allowPublicImage) === 'true' };
};

const ownedCompletedOrder = (orderId, customerId) => db.Order.findOne({
  where: { order_id: orderId, customer_id: customerId, status: 'done' },
  include: [{ model: db.Review, as: 'review' }],
});

router.post('/:id/review', protect, (req, res) => uploadReview(req, res, async uploadError => {
  if (uploadError) return res.status(400).json({ error: uploadError.message });
  const payload = reviewPayload(req.body);
  if (payload.error) {
    if (req.file) await deleteImage(req.file.filename).catch(() => {});
    return res.status(400).json({ error: payload.error });
  }
  try {
    const order = await ownedCompletedOrder(req.params.id, req.user.customerId);
    if (!order) {
      if (req.file) await deleteImage(req.file.filename).catch(() => {});
      return res.status(400).json({ error: 'Reviews are available after an order is completed' });
    }
    if (order.review) {
      if (req.file) await deleteImage(req.file.filename).catch(() => {});
      return res.status(409).json({ error: 'You already reviewed this order' });
    }
    const review = await db.Review.create({
      order_id: order.order_id,
      customer_id: req.user.customerId,
      ...payload,
      image_url: req.file?.path || null,
      image_public_id: req.file?.filename || null,
    });
    await createAdminNotification({
      orderId: order.order_id,
      type: 'review',
      title: 'New customer review',
      message: `A verified ${payload.rating}-star review is waiting for approval.`,
    });
    res.status(201).json({ message: 'Review submitted for approval', review });
  } catch (error) {
    if (req.file) await deleteImage(req.file.filename).catch(() => {});
    res.status(500).json({ error: error.message });
  }
}));

router.patch('/:id/review', protect, (req, res) => uploadReview(req, res, async uploadError => {
  if (uploadError) return res.status(400).json({ error: uploadError.message });
  const payload = reviewPayload(req.body);
  if (payload.error) {
    if (req.file) await deleteImage(req.file.filename).catch(() => {});
    return res.status(400).json({ error: payload.error });
  }
  try {
    const order = await ownedCompletedOrder(req.params.id, req.user.customerId);
    if (!order?.review) {
      if (req.file) await deleteImage(req.file.filename).catch(() => {});
      return res.status(404).json({ error: 'Review not found' });
    }
    const oldPublicId = order.review.image_public_id;
    await order.review.update({
      ...payload,
      status: 'pending',
      admin_reply: null,
      ...(req.file ? { image_url: req.file.path, image_public_id: req.file.filename } : {}),
    });
    if (req.file && oldPublicId) await deleteImage(oldPublicId).catch(() => {});
    await createAdminNotification({
      orderId: order.order_id,
      type: 'review',
      title: 'Customer review updated',
      message: `An updated ${payload.rating}-star review is waiting for approval.`,
    });
    res.json({ message: 'Review updated and sent for approval', review: order.review });
  } catch (error) {
    if (req.file) await deleteImage(req.file.filename).catch(() => {});
    res.status(500).json({ error: error.message });
  }
}));

router.delete('/:id/review', protect, async (req, res) => {
  try {
    const order = await db.Order.findOne({
      where: { order_id: req.params.id, customer_id: req.user.customerId },
      include: [{ model: db.Review, as: 'review' }],
    });
    if (!order?.review) return res.status(404).json({ error: 'Review not found' });
    const publicId = order.review.image_public_id;
    await order.review.destroy();
    if (publicId) await deleteImage(publicId).catch(() => {});
    res.json({ message: 'Review deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/messages', protect, async (req, res) => {
  try {
    const order = await db.Order.findOne({ where: { order_id: req.params.id, customer_id: req.user.customerId } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (Number(order.amount_paid || 0) <= 0) return res.status(409).json({ error: 'Complete the deposit payment before messaging the artist' });
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
    const order = await db.Order.findOne({ 
      where: { order_id: req.params.id, customer_id: req.user.customerId }, 
      include: [
        { model: db.ProofImage, as: 'proofImages' },
        { model: db.Customer, as: 'customer' }
      ] 
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (Number(order.amount_paid || 0) <= 0) return res.status(409).json({ error: 'Complete the deposit payment before reviewing a proof' });
    const proof = order.proofImages.find(p => p.is_current);
    if (!proof) return res.status(400).json({ error: 'No proof is awaiting review' });
    const approved = req.body.action === 'approve';
    if (!approved && !req.body.note?.trim()) return res.status(400).json({ error: 'Please describe the requested changes' });
    
    const revisionNote = req.body.note?.trim() || '';

    await proof.update({ 
      review_status: approved ? 'approved' : 'revision_requested', 
      revision_note: approved ? null : revisionNote, 
      reviewed_at: new Date() 
    });
    
    await order.update({ 
      status: approved ? 'approved' : 'revision_requested', 
      ...(approved ? { approved_at: new Date() } : {}) 
    });

    await db.Message.create({ 
      order_id: order.order_id, 
      sender_type: 'system', 
      message_text: approved ? 'Customer approved the proof.' : `Customer requested changes: ${revisionNote}` 
    });
    
    // In-app notification with revision note
    await createAdminNotification({
      orderId: order.order_id,
      type: approved ? 'approval' : 'revision',
      title: approved ? 'Proof approved' : 'Revision requested',
      message: approved
        ? `The customer approved the proof for order #${order.order_id.slice(0, 8)}.`
        : `Customer requested changes for order #${order.order_id.slice(0, 8)}. Note: "${revisionNote}"`,
    });

    if (!approved) {
      try {
        const admins = await db.Admin.findAll();
        await sendRevisionRequestedAdminEmail({
          order,
          customerName: order.customer?.full_name || order.customer?.username || 'Customer',
          revisionNote,
          admins,
          createInAppNotification: createAdminNotification,
        });
      } catch (emailErr) {
        console.error('Failed to send admin revision email:', emailErr);
      }
    }

    res.json({ message: approved ? 'Proof approved' : 'Revision requested', status: order.status });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

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

router.post('/update-status', async (req, res) => {
  try {
    if (!req.session?.adminId) {
      return res.status(403).json({
        message: 'Only trusted admin/backend workflows may update order status notifications.',
      });
    }

    const { orderId, status, customerId } = req.body;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });
    if (!status) return res.status(400).json({ message: 'status is required' });

    const order = await db.Order.findByPk(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const targetCustomerId = resolveNotificationCustomerId({
      requestCustomerId: customerId,
      orderCustomerId: order.customer_id,
      trustedBackend: true,
    });

    let title = 'Order Update 🔔';
    let message = `Your order #${orderId} status is now: ${status}`;

    switch (String(status).toUpperCase()) {
      case 'CONFIRMED':
        title = 'Order Confirmed!';
        message = `Your order #${orderId} has been confirmed. The artist is getting ready!`;
        break;
      case 'SKETCHING_HALF':
      case 'IN_PROGRESS':
        title = 'Drawing in Progress (50%)';
        message = `Your portrait #${orderId} is half-way done! Outline & basic shading completed.`;
        break;
      case 'COMPLETED':
      case 'DRAWING_FINISHED':
        title = 'Drawing Fully Completed!';
        message = `Great news! The artist finished your portrait #${orderId}.`;
        break;
      case 'PACKED':
        title = 'Framed & Packed';
        message = `Your portrait #${orderId} has been safely framed and packed for delivery.`;
        break;
      case 'DISPATCHED':
      case 'OUT_FOR_DELIVERY':
        title = 'Out for Delivery!';
        message = `Your package #${orderId} is now with the courier and on its way to you!`;
        break;
      case 'DELIVERED':
        title = 'Delivered!';
        message = `Your order #${orderId} has been delivered successfully. Thank you!`;
        break;
      default:
        title = `Order Update: ${status}`;
        message = `Order #${orderId} has been updated to ${status}.`;
    }

    const newNotification = await createNotification(
      targetCustomerId,
      orderId,
      title,
      message,
      status,
      { trustedBackend: true, orderCustomerId: order.customer_id },
    );

    res.status(200).json({
      message: 'Status updated and live notification sent to user!',
      notification: newNotification,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update order status', error: error.message });
  }
});

module.exports = router;