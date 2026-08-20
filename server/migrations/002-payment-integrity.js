const { DataTypes } = require('sequelize');

module.exports = {
  name: '002-payment-integrity',
  async up({ sequelize }) {
    const queryInterface = sequelize.getQueryInterface();
    const columns = await queryInterface.describeTable('Payments');
    if (!columns.completedAt) {
      await queryInterface.addColumn('Payments', 'completedAt', { type: DataTypes.DATE, allowNull: true });
      await sequelize.query("UPDATE Payments SET completedAt = updatedAt WHERE status = 'completed' AND completedAt IS NULL");
    }
    const indexes = await queryInterface.showIndex('Payments');
    if (!indexes.some(index => index.name === 'payments_order_purpose_unique')) {
      await queryInterface.addIndex('Payments', ['order_id', 'paymentType'], {
        name: 'payments_order_purpose_unique',
        unique: true,
      });
    }
  },
};
