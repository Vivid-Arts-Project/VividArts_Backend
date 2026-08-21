const express = require('express');
const router = express.Router();
const { Notification } = require('../models');
const { paginationFrom, paginationMeta } = require('../utils/pagination');
const { protect } = require('../middleware/authMiddleware');
const { realtimeNotificationHub } = require('../utils/notificationRealtime');

router.get('/stream', protect, (req, res) => {
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
    type: 'customer',
    userId: req.user.customerId,
    listener,
  });

  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 15000);

  sendEvent('connected', { status: 'connected', customerId: req.user.customerId });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// 1. Get all notifications for the customer
router.get('/', protect, async (req, res) => {
  try {
    const { page, limit, offset } = paginationFrom(req.query);
    const { count, rows: notifications } = await Notification.findAndCountAll({
      where: { customerId: req.user.customerId },
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    res.json({
      success: true,
      notifications,
      pagination: paginationMeta(count, page, limit),
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to fetch notifications.' });
  }
});

// 2. Mark specific notification as read (Using PATCH for consistency)
router.patch('/:id/read', protect, async (req, res) => {
  try {
    const updated = await Notification.update(
      { isRead: true },
      { where: { id: req.params.id, customerId: req.user.customerId } },
    );
    if (!updated[0]) return res.status(404).json({ message: 'Notification not found.' });

    const unreadCount = await Notification.count({
      where: { customerId: req.user.customerId, isRead: false },
    });
    realtimeNotificationHub.emit({
      type: 'customer',
      userId: req.user.customerId,
      event: { type: 'notification_count', unreadCount },
    });

    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to update notification status.' });
  }
});

// 3. Mark all notifications as read
router.patch('/read-all', protect, async (req, res) => {
  try {
    await Notification.update(
      { isRead: true },
      { where: { customerId: req.user.customerId, isRead: false } },
    );

    const unreadCount = await Notification.count({
      where: { customerId: req.user.customerId, isRead: false },
    });
    realtimeNotificationHub.emit({
      type: 'customer',
      userId: req.user.customerId,
      event: { type: 'notification_count', unreadCount },
    });

    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to update notifications.' });
  }
});

// 4. Delete a notification
router.delete('/:id', protect, async (req, res) => {
  try {
    const deleted = await Notification.destroy({
      where: { id: req.params.id, customerId: req.user.customerId },
    });
    if (!deleted) return res.status(404).json({ message: 'Notification not found.' });

    const unreadCount = await Notification.count({
      where: { customerId: req.user.customerId, isRead: false },
    });
    realtimeNotificationHub.emit({
      type: 'customer',
      userId: req.user.customerId,
      event: { type: 'notification_count', unreadCount },
    });

    res.json({ success: true, message: 'Notification deleted.' });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to delete notification.' });
  }
});

module.exports = router;