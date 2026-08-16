const db = require('../models');

async function createAdminNotification({ adminId, orderId = null, type = 'info', title, message }) {
  try {
    if (adminId) {
      return await db.AdminNotification.create({
        admin_id: adminId,
        order_id: orderId,
        type,
        title,
        message,
      });
    }

    const admins = await db.Admin.findAll({ attributes: ['id'] });
    if (!admins.length) return [];
    return await db.AdminNotification.bulkCreate(admins.map(admin => ({
      admin_id: admin.id,
      order_id: orderId,
      type,
      title,
      message,
    })));
  } catch (error) {
    console.error('Unable to create admin notification:', error.message);
    return null;
  }
}

module.exports = { createAdminNotification };
