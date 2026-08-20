const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('AdminSession', {
  sid: { type: DataTypes.STRING(128), primaryKey: true },
  expiresAt: { type: DataTypes.DATE, allowNull: false },
  data: { type: DataTypes.TEXT('long'), allowNull: false },
}, {
  tableName: 'AdminSessions',
  timestamps: true,
  indexes: [{ fields: ['expiresAt'] }],
});
