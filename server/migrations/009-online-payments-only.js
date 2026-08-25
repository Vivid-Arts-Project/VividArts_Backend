const { DataTypes } = require('sequelize');

module.exports = {
  name: '009-online-payments-only',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const tableNames = (await queryInterface.showAllTables())
      .map(table => typeof table === 'string' ? table : (table.tableName || table.name));
    const paymentsTable = tableNames.find(name => String(name).toLowerCase() === 'payments');
    if (!paymentsTable) return;

    const columns = await queryInterface.describeTable(paymentsTable);
    if (!columns.paymentMethod) return;

    // Preserve historical bank records for audit purposes, but remove "bank"
    // as a selectable/current method. New application writes are card-only.
    if (sequelize.getDialect() === 'mysql') {
      await queryInterface.changeColumn(paymentsTable, 'paymentMethod', {
        type: DataTypes.ENUM('card', 'bank', 'legacy_bank'),
        allowNull: false,
      }, { transaction });
    }

    await sequelize.query(
      `UPDATE \`${paymentsTable}\` SET \`paymentMethod\` = 'legacy_bank' WHERE \`paymentMethod\` = 'bank'`,
      { transaction },
    );

    await queryInterface.changeColumn(paymentsTable, 'paymentMethod', {
      type: DataTypes.ENUM('card', 'legacy_bank'),
      allowNull: false,
      defaultValue: 'card',
    }, { transaction });
  },
};
