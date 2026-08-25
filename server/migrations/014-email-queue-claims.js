const { DataTypes } = require('sequelize');

module.exports = {
  name: '014-email-queue-claims',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const columns = await queryInterface.describeTable('EmailDeliveries');
    if (!columns.lockedAt) {
      await queryInterface.addColumn('EmailDeliveries', 'lockedAt', {
        type: DataTypes.DATE,
        allowNull: true,
      }, { transaction });
    }
    if (!columns.lockToken) {
      await queryInterface.addColumn('EmailDeliveries', 'lockToken', {
        type: DataTypes.STRING(64),
        allowNull: true,
      }, { transaction });
    }
    const indexes = await queryInterface.showIndex('EmailDeliveries');
    if (!indexes.some(index => index.name === 'email_deliveries_status_locked_at')) {
      await queryInterface.addIndex('EmailDeliveries', ['status', 'lockedAt'], {
        name: 'email_deliveries_status_locked_at',
        transaction,
      });
    }
  },
};
