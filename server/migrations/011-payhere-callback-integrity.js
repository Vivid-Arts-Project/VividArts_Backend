module.exports = {
  name: '011-payhere-callback-integrity',
  async up({ sequelize }) {
    const queryInterface = sequelize.getQueryInterface();
    const [duplicates] = await sequelize.query(`
      SELECT payhereOrderId
      FROM Payments
      WHERE payhereOrderId IS NOT NULL
      GROUP BY payhereOrderId
      HAVING COUNT(*) > 1
      LIMIT 1
    `);
    if (duplicates.length) {
      throw new Error('Cannot enforce unique PayHere order IDs while duplicate payment records exist');
    }

    const indexes = await queryInterface.showIndex('Payments');
    if (!indexes.some(index => index.name === 'payments_payhere_order_unique')) {
      await queryInterface.addIndex('Payments', ['payhereOrderId'], {
        name: 'payments_payhere_order_unique',
        unique: true,
      });
    }
  },
};
