module.exports = (sequelize, DataTypes) => sequelize.define('EmailDelivery', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  to: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  subject: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  html: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {},
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'queued',
  },
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  maxAttempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 3,
  },
  lastError: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  sentAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  nextAttemptAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  lockedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  lockToken: {
    type: DataTypes.STRING(64),
    allowNull: true,
  },
}, {
  tableName: 'EmailDeliveries',
  timestamps: true,
  indexes: [
    { fields: ['status', 'nextAttemptAt'] },
    { fields: ['status', 'lockedAt'] },
    { fields: ['createdAt'] },
  ],
});
