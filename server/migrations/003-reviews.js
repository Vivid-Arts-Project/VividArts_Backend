const { DataTypes } = require('sequelize');

module.exports = {
  name: '003-reviews',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const tables = (await queryInterface.showAllTables())
      .map(table => typeof table === 'string' ? table : (table.tableName || table.name));
    if (tables.includes('Reviews')) return;

    await queryInterface.createTable('Reviews', {
      review_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        references: { model: 'Orders', key: 'order_id' },
        onDelete: 'CASCADE',
      },
      customer_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'Customers', key: 'customer_id' },
        onDelete: 'CASCADE',
      },
      rating: { type: DataTypes.INTEGER, allowNull: false },
      title: { type: DataTypes.STRING(120), allowNull: false },
      comment: { type: DataTypes.TEXT, allowNull: false },
      image_url: { type: DataTypes.STRING(500), allowNull: true },
      image_public_id: { type: DataTypes.STRING(300), allowNull: true },
      allow_public_image: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },
      is_featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      admin_reply: { type: DataTypes.TEXT, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    }, { transaction });
    await queryInterface.addIndex('Reviews', ['status', 'is_featured'], { transaction });
    await queryInterface.addIndex('Reviews', ['customer_id'], { transaction });
  },
};
