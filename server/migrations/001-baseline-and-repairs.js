const {
  ensureAdminProfileColumns,
  removeDuplicateUniqueIndexes,
  ensureCustomerProfileColumns,
  ensureOrderWorkflowColumns,
  ensureNotificationOrderIdColumn,
  ensureVerificationTokenTable,
} = require('../utils/schema');

module.exports = {
  name: '001-baseline-and-repairs',
  async up({ db, sequelize }) {
    const existingTables = (await sequelize.getQueryInterface().showAllTables())
      .map(table => typeof table === 'string' ? table : (table.tableName || table.name));
    if (!existingTables.includes('Customers')) {
      for (const model of Object.values(db.sequelize.models)) {
        await model.sync({ withoutForeignKeyConstraints: true });
      }
      return;
    }
    await removeDuplicateUniqueIndexes(sequelize);
    await ensureCustomerProfileColumns(sequelize);
    await ensureAdminProfileColumns(sequelize);
    await ensureOrderWorkflowColumns(sequelize);
    await ensureNotificationOrderIdColumn(sequelize);
    await ensureVerificationTokenTable(sequelize);
    for (const model of Object.values(db.sequelize.models)) {
      await model.sync({ withoutForeignKeyConstraints: true });
    }
  },
};
