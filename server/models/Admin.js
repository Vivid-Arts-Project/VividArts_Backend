const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

module.exports = (sequelize) => {
  const Admin = sequelize.define('Admin', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    firstName:       { type: DataTypes.STRING(80), defaultValue: '' },
    lastName:        { type: DataTypes.STRING(80), defaultValue: '' },
    email:           { type: DataTypes.STRING, allowNull: false, unique: true, validate: { isEmail: true } },
    phone:           { type: DataTypes.STRING(20), allowNull: true },
    isSuperAdmin:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    profileImageUrl: { type: DataTypes.STRING, allowNull: true },
    profileImagePublicId: { type: DataTypes.STRING, allowNull: true },
    businessName:    { type: DataTypes.STRING(120), defaultValue: 'Vivid Arts' },
    businessEmail:   { type: DataTypes.STRING, allowNull: true },
    businessAddress: { type: DataTypes.TEXT, allowNull: true },
    notifPreferences: {
      type: DataTypes.JSON,
      defaultValue: {
        newOrder: true, revisionRequested: true,
        proofApproved: true, paymentReceived: true, deadlineReminders: false,
      },
    },
  }, {
    tableName: 'Admins',
    timestamps: true,
  });

  Admin.prototype.checkPassword = async function (plain) {
    return bcrypt.compare(plain, this.passwordHash);
  };

  Admin.hashPassword = async (plain) => bcrypt.hash(plain, 12);

  return Admin;
};
