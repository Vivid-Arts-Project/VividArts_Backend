const db = require('../models');
const { emitRealtimeNotification } = require('./notificationRealtime');

async function createAdminNotification({ adminId, orderId = null, type = 'info', title, message }) {
  try {
    if (adminId) {
      const notification = await db.AdminNotification.create({
        admin_id: adminId,
        order_id: orderId,
        type,
        title,
        message,
      });

      const unreadCount = await db.AdminNotification.count({
        where: { admin_id: adminId, is_read: false },
      });

      emitRealtimeNotification({
        type: 'admin',
        userId: adminId,
        event: {
          type: 'admin_notification',
          notification: notification.toJSON ? notification.toJSON() : notification,
          unreadCount,
        },
      });

      return notification;
    }

    const admins = await db.Admin.findAll({ attributes: ['id'] });
    if (!admins.length) return [];
    const notifications = await db.AdminNotification.bulkCreate(admins.map(admin => ({
      admin_id: admin.id,
      order_id: orderId,
      type,
      title,
      message,
    })));

    for (const admin of admins) {
      const unreadCount = await db.AdminNotification.count({
        where: { admin_id: admin.id, is_read: false },
      });
      const adminNotification = notifications.find(note => note.admin_id === admin.id);
      emitRealtimeNotification({
        type: 'admin',
        userId: admin.id,
        event: {
          type: 'admin_notification',
          notification: adminNotification ? (adminNotification.toJSON ? adminNotification.toJSON() : adminNotification) : null,
          unreadCount,
        },
      });
    }

    return notifications;
  } catch (error) {
    console.error('Unable to create admin notification:', error.message);
    return null;
  }
}

module.exports = { createAdminNotification };
