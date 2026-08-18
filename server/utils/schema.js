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

async function removeDuplicateUniqueIndexes(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  for (const [tableName, columnNames] of Object.entries({
    Admins: ['username', 'email'],
    Customers: ['username', 'email'],
  })) {
    let indexes;
    try { indexes = await queryInterface.showIndex(tableName); }
    catch { continue; }

    for (const columnName of columnNames) {
      const matching = indexes.filter(index =>
        index.unique
        && index.name !== 'PRIMARY'
        && index.fields?.length === 1
        && (index.fields[0].attribute || index.fields[0].name) === columnName
      );
      if (matching.length <= 1) continue;
      const keep = matching.find(index => index.name === columnName) || matching[0];
      for (const index of matching) {
        if (index.name === keep.name) continue;
        try { await queryInterface.removeIndex(tableName, index.name); }
        catch (error) {
          // A second dev watcher may be running the same idempotent cleanup.
          if (error.original?.code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw error;
        }
      }
    }
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

module.exports = { ensureAdminProfileColumns, removeDuplicateUniqueIndexes, ensureCustomerProfileColumns, ensureOrderWorkflowColumns, ensureNotificationOrderIdColumn };
