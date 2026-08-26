const { DataTypes } = require('sequelize');

module.exports = {
  name: '016-payment-finished-order-status',
  async up({ sequelize, transaction }) {
    await sequelize.getQueryInterface().changeColumn('Orders', 'status', {
      type: DataTypes.ENUM(
        'in_queue', 'sketching', 'waiting_for_feedback', 'revision_requested',
        'approved', 'finished', 'payment_finished', 'framed', 'shipped', 'done', 'cancelled',
      ),
      allowNull: false,
      defaultValue: 'in_queue',
    }, { transaction });
  },
};
