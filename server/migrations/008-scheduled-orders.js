const { DataTypes } = require('sequelize');

module.exports = {
  name: '008-scheduled-orders',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const addMissing = async (table, column, definition) => {
      const columns = await queryInterface.describeTable(table);
      if (!columns[column]) await queryInterface.addColumn(table, column, definition, { transaction });
    };
    await addMissing('Orders', 'is_scheduled', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await addMissing('ProductOptions', 'is_scheduled', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await addMissing('ProductOptions', 'scheduled_date', { type: DataTypes.DATEONLY, allowNull: true });
    await addMissing('ProductOptions', 'scheduled_start_date', { type: DataTypes.DATEONLY, allowNull: true });
  },
};
