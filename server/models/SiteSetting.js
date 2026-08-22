module.exports = (sequelize, DataTypes) => sequelize.define('SiteSetting', {
  id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
  developmentMode: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  maintenanceMessage: { type: DataTypes.STRING(300), allowNull: false, defaultValue: 'The system is currently undergoing development. Please check back soon.' },
  updatedBy: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'SiteSettings', timestamps: true });
