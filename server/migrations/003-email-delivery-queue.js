const { DataTypes } = require('sequelize');

module.exports = {
  name: '003-email-delivery-queue',
  async up({ sequelize }) {
    const queryInterface = sequelize.getQueryInterface();
    const tableName = 'EmailDeliveries';
    const exists = await queryInterface.showAllTables().then(tables =>
      tables.some(table => typeof table === 'string' ? table === tableName : (table.tableName || table.name) === tableName)
    );

    if (exists) return;

    await queryInterface.createTable(tableName, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      to: { type: DataTypes.STRING(255), allowNull: false },
      subject: { type: DataTypes.STRING(255), allowNull: false },
      text: { type: DataTypes.TEXT, allowNull: true },
      html: { type: DataTypes.TEXT, allowNull: true },
      metadata: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      lastError: { type: DataTypes.TEXT, allowNull: true },
      sentAt: { type: DataTypes.DATE, allowNull: true },
      nextAttemptAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    await queryInterface.addIndex(tableName, ['status', 'nextAttemptAt']);
  },
};
