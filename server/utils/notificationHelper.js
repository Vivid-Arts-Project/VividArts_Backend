const Notification = require('../models/Notification');

// A helper function that saves the notification to the database after the administrator status is changed.
const createNotification = async (customerId, orderId, title, message, status) => {
  try {
    const notification = new Notification({
      customerId,
      orderId,
      title,
      message,
      status
    });

    await notification.save();
    return notification;
  } catch (error) {
    console.error('Error saving notification to DB:', error);
  }
};

module.exports = { createNotification };