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
  if (!columns.sketching_started_at) {
    await queryInterface.addColumn('Orders', 'sketching_started_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
  }
  if (!columns.estimated_completion_at) {
    await queryInterface.addColumn('Orders', 'estimated_completion_at', {
      type: DataTypes.DATEONLY,
      allowNull: true,
    });
  }
}

async function ensureAdminProfileColumns(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  let columns;
  try { columns = await queryInterface.describeTable('Admins'); }
  catch { return; }
  if (!columns.profileImageUrl) {
    await queryInterface.addColumn('Admins', 'profileImageUrl', {
      type: DataTypes.STRING,
      allowNull: true,
    });
  }
  if (!columns.profileImagePublicId) {
    await queryInterface.addColumn('Admins', 'profileImagePublicId', {
      type: DataTypes.STRING,
      allowNull: true,
    });
  }
}

async function ensureNotificationOrderIdColumn(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  let columns;
  try { columns = await queryInterface.describeTable('Notifications'); }
  catch { return; }
  const currentType = String(columns.orderId?.type || '').toUpperCase();
  if (columns.orderId && !currentType.includes('CHAR') && !currentType.includes('UUID')) {
    await queryInterface.changeColumn('Notifications', 'orderId', {
      type: DataTypes.UUID,
      allowNull: true,
    });
  }
}

module.exports = { ensureAdminProfileColumns, ensureCustomerProfileColumns, ensureOrderWorkflowColumns, ensureNotificationOrderIdColumn };
