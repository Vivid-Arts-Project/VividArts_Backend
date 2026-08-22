const crypto = require('crypto');

module.exports = (sequelize, DataTypes) => sequelize.define('AdminRegistrationRequest', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
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
  requestToken: { type: DataTypes.STRING(64), allowNull: false, defaultValue: () => crypto.randomBytes(32).toString('hex') },
}, {
  tableName: 'AdminRegistrationRequests', timestamps: true,
  indexes: [{ fields: ['status', 'createdAt'] }, { fields: ['username'] }, { fields: ['email'] }],
});
