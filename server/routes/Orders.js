const express = require('express');
const router = express.Router();
const { Notification } = require('../models');
const { protect } = require('../middleware/authMiddleware');

// 1. For the customer to receive their notifications in real-time (GET /api/orders/notifications)
router.get('/notifications', protect, async (req, res) => {
  try {
    const customerId = req.user.id || req.user.customer_id;

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