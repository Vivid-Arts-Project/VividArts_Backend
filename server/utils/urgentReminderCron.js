const cron = require('node-cron');
const db = require('../models');
const { createAdminNotification } = require('./adminNotificationHelper');
const { sendEmail } = require('../middleware/email');
const { Op } = require('sequelize');

let reminderJob = null;

const resolveUrgentReminder = (order, today) => {
  const deadline = order?.estimated_completion_at || order?.productOption?.urgent_deadline;
  if (!deadline) return null;

  const dueDate = new Date(deadline);
  dueDate.setHours(0, 0, 0, 0);

  const diffTime = dueDate.getTime() - today.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 2) {
    return {
      reminderType: 'reminder_2_days',
      messageText: `Urgent order #${String(order.order_id || '').slice(0, 8)} is due in 2 days (${deadline}).`,
    };
  }

  if (diffDays === 1) {
    return {
      reminderType: 'reminder_1_day',
      messageText: `Urgent order #${String(order.order_id || '').slice(0, 8)} is due tomorrow (${deadline})!`,
    };
  }

  if (diffDays === 0) {
    return {
      reminderType: 'reminder_due_today',
      messageText: `URGENT: Order #${String(order.order_id || '').slice(0, 8)} is due TODAY!`,
    };
  }

  return null;
};

async function processUrgentDeadlineReminders({ orders = null, dbInstance = db, sendEmailFn = sendEmail, createNotificationFn = createAdminNotification, now = () => new Date() } = {}) {
  const today = new Date(now());
  today.setHours(0, 0, 0, 0);

  const sourceOrders = (orders || await dbInstance.Order.findAll({
    include: [{ model: dbInstance.ProductOption, as: 'productOption' }],
    where: {
      status: { [dbInstance.Sequelize.Op.notIn]: ['completed', 'cancelled', 'delivered', 'approved', 'done'] },
    },
  })).filter((order) => {
    const status = String(order?.status || '').toLowerCase();
    return !['completed', 'cancelled', 'delivered', 'approved', 'done'].includes(status);
  });

  let processed = 0;

  for (const order of sourceOrders) {
    const reminder = resolveUrgentReminder(order, today);
    if (!reminder) continue;

    const existingNotification = await dbInstance.AdminNotification.findOne({
      where: {
        order_id: order.order_id,
        type: reminder.reminderType,
        createdAt: { [dbInstance.Sequelize.Op.gte]: today },
      },
    });

    if (existingNotification) continue;

    const admins = await dbInstance.Admin.findAll();
    const eligibleAdmins = admins.filter((admin) => Boolean(admin.email) && (admin.notifPreferences || {}).deadlineReminders !== false);

    for (const admin of eligibleAdmins) {
      await createNotificationFn({
        adminId: admin.id,
        orderId: order.order_id,
        type: reminder.reminderType,
        title: `Urgent Deadline Alert (${reminder.reminderType === 'reminder_due_today' ? 'Today' : 'Due soon'})`,
        message: reminder.messageText,
      });

      await sendEmailFn({
        to: admin.email,
        subject: `Urgent deadline alert for order ${order.order_id}`,
        text: `${reminder.messageText} Review: ${process.env.FRONTEND_URL || 'http://localhost:3000'}/orders/${encodeURIComponent(order.order_id)}`,
        html: `<p>${reminder.messageText}</p><p><a href="${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/orders/${encodeURIComponent(order.order_id)}">Open order</a></p>`,
        metadata: { type: 'deadline_reminder', orderId: order.order_id, reminderType: reminder.reminderType },
      });
    }

    processed += 1;
  }

  return processed;
}

function startUrgentReminderCron() {
  if (process.env.NODE_ENV === 'test') return null;
  if (reminderJob) return reminderJob;

  reminderJob = cron.schedule('0 8 * * *', async () => {
    try {
      const processed = await processUrgentDeadlineReminders();
      console.log(`Automated urgent reminders processed successfully (${processed} orders).`);
    } catch (error) {
      console.error('Error in urgent reminder cron job:', error);
    }
  });

  return reminderJob;
}

module.exports = {
  resolveUrgentReminder,
  processUrgentDeadlineReminders,
  startUrgentReminderCron,
};