const { DataTypes } = require('sequelize');

module.exports = {
  name: '010-customer-token-version',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const tableNames = (await queryInterface.showAllTables())
      .map(table => typeof table === 'string' ? table : (table.tableName || table.name));
    const customersTable = tableNames.find(name => String(name).toLowerCase() === 'customers');
    if (!customersTable) return;

    const columns = await queryInterface.describeTable(customersTable);
    if (!columns.token_version) {
      await queryInterface.addColumn(customersTable, 'token_version', {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      }, { transaction });
    }
  },
};
