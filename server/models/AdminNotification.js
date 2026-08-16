module.exports = (sequelize, DataTypes) => sequelize.define('AdminNotification', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  admin_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  order_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  type: {
    type: DataTypes.STRING(40),
    allowNull: false,
    defaultValue: 'info',
  },
  title: {
    type: DataTypes.STRING(160),
    allowNull: false,
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  is_read: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
}, {
  tableName: 'AdminNotifications',
  timestamps: true,
  indexes: [
    { fields: ['admin_id', 'is_read'] },
    { fields: ['createdAt'] },
  ],
});
