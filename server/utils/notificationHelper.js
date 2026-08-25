const db = require('../models');
const { emitRealtimeNotification } = require('./notificationRealtime');

const runAfterCommit = (transaction, callback) => {
  if (transaction?.afterCommit) transaction.afterCommit(callback);
  else callback();
};

const resolveNotificationCustomerId = ({ requestCustomerId, orderCustomerId, trustedBackend = false } = {}) => {
  const normalizedRequestCustomerId = requestCustomerId == null ? null : String(requestCustomerId);
  const normalizedOrderCustomerId = orderCustomerId == null ? null : String(orderCustomerId);

  if (!normalizedOrderCustomerId) {
    throw new Error('Order owner customer ID is required.');
  }

  if (!trustedBackend && normalizedRequestCustomerId && normalizedRequestCustomerId !== normalizedOrderCustomerId) {
    throw new Error('Customer-controlled notification targets are not allowed. Use the order owner.');
  }

  return normalizedOrderCustomerId;
};

// A helper function that saves the notification to the database after the administrator status is changed.
const createNotification = async (customerId, orderId, title, message, status, options = {}) => {
  try {
    const { trustedBackend = false, orderCustomerId = customerId, transaction } = options;
    const safeCustomerId = resolveNotificationCustomerId({
      requestCustomerId: customerId,
      orderCustomerId,
      trustedBackend,
    }, { transaction });

    const notification = await db.Notification.create({
      customerId: safeCustomerId,
      orderId,
      title,
      message,
      status,
    });

    const unreadCount = await db.Notification.count({
      where: { customerId: safeCustomerId, isRead: false },
      transaction,
    });

    runAfterCommit(transaction, () => {
      emitRealtimeNotification({
        type: 'customer',
        userId: safeCustomerId,
        event: {
          type: 'notification',
          notification: notification.toJSON ? notification.toJSON() : notification,
          unreadCount,
        },
      });
    });

    return notification;
  } catch (error) {
    console.error('Error saving notification to DB:', error);
    throw error;
  }
};

module.exports = { createNotification, resolveNotificationCustomerId, runAfterCommit };
