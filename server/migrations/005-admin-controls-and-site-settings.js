const { DataTypes } = require('sequelize');

module.exports = {
  name: '005-admin-controls-and-site-settings',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const tableNames = (await queryInterface.showAllTables())
      .map(table => typeof table === 'string' ? table : (table.tableName || table.name));

    if (tableNames.includes('Admins')) {
      const columns = await queryInterface.describeTable('Admins');
      if (!columns.isSuperAdmin) {
        await queryInterface.addColumn('Admins', 'isSuperAdmin', {
          type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
        }, { transaction });
      }
      const [admins] = await sequelize.query('SELECT `id` FROM `Admins` ORDER BY `createdAt` ASC LIMIT 1', { transaction });
      if (admins[0]) {
        await sequelize.query('UPDATE `Admins` SET `isSuperAdmin` = 1 WHERE `id` = :id', {
          replacements: { id: admins[0].id }, transaction,
        });
      }
    }

    if (!tableNames.includes('AdminRegistrationRequests')) {
      await queryInterface.createTable('AdminRegistrationRequests', {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        username: { type: DataTypes.STRING(50), allowNull: false },
        passwordHash: { type: DataTypes.STRING, allowNull: false },
        firstName: { type: DataTypes.STRING(80), allowNull: true },
        lastName: { type: DataTypes.STRING(80), allowNull: true },
        email: { type: DataTypes.STRING, allowNull: false },
        phone: { type: DataTypes.STRING(20), allowNull: true },
        status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },
        decisionNote: { type: DataTypes.STRING(500), allowNull: true },
        reviewedBy: { type: DataTypes.UUID, allowNull: true },
        reviewedAt: { type: DataTypes.DATE, allowNull: true },
        requestToken: { type: DataTypes.STRING(64), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }, { transaction });
      await queryInterface.addIndex('AdminRegistrationRequests', ['status', 'createdAt'], { transaction });
    }

    if (!tableNames.includes('SiteSettings')) {
      await queryInterface.createTable('SiteSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false, defaultValue: 1 },
        developmentMode: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        maintenanceMessage: { type: DataTypes.STRING(300), allowNull: false },
        updatedBy: { type: DataTypes.UUID, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      }, { transaction });
    }

    if (tableNames.includes('GalleryImages')) {
      await queryInterface.changeColumn('GalleryImages', 'placement', {
        type: DataTypes.ENUM('home', 'gallery', 'both'), allowNull: false, defaultValue: 'gallery',
      }, { transaction });
    }
  },
};
