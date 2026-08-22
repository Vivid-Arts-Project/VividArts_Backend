const { DataTypes } = require('sequelize');

module.exports = {
  name: '007-admin-account-status',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const tableNames = (await queryInterface.showAllTables())
      .map(table => typeof table === 'string' ? table : (table.tableName || table.name));
    const adminsTable = tableNames.find(name => String(name).toLowerCase() === 'admins');
    if (!adminsTable) return;
    const columns = await queryInterface.describeTable(adminsTable);
    if (!columns.isActive) {
      await queryInterface.addColumn(adminsTable, 'isActive', {
        type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
      }, { transaction });
    }
  },
};
