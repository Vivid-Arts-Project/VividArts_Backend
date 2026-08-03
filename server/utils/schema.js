const { DataTypes } = require('sequelize');

const CUSTOMER_PROFILE_COLUMNS = {
  profile_image_url: DataTypes.STRING,
  profile_image_public_id: DataTypes.STRING,
  cover_image_url: DataTypes.STRING,
  cover_image_public_id: DataTypes.STRING,
};

async function ensureCustomerProfileColumns(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  const columns = await queryInterface.describeTable('Customers');

  for (const [columnName, columnType] of Object.entries(CUSTOMER_PROFILE_COLUMNS)) {
    if (!columns[columnName]) {
      await queryInterface.addColumn('Customers', columnName, {
        type: columnType,
        allowNull: true,
      });
    }
  }
}

async function ensureOrderWorkflowColumns(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  let columns;
  try { columns = await queryInterface.describeTable('Orders'); }
  catch { return; }
  if (!columns.status) {
    await queryInterface.addColumn('Orders', 'status', {
      type: DataTypes.STRING(40), allowNull: false, defaultValue: 'in_queue',
    });
  }
}

module.exports = { ensureCustomerProfileColumns, ensureOrderWorkflowColumns };
