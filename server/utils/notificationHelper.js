const db = require('../models');

// A helper function that saves the notification to the database after the administrator status is changed.
const createNotification = async (customerId, orderId, title, message, status) => {
  try {
    const notification = await db.Notification.create({
      customerId,
      orderId,
      title,
      message,
      status
    });
    return notification;
  } catch (error) {
    console.error('Error saving notification to DB:', error);
  }
};

module.exports = { createNotification };
