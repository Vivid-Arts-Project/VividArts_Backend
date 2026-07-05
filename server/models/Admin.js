const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

module.exports = (sequelize) => {
  const Admin = sequelize.define('Admin', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    // ── Login credentials ───────────────────────────────────────────────────
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    // ── Profile info (shown in Settings → Profile tab) ──────────────────────
    firstName: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: '',
    },
    lastName: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: '',
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },

    // ── Business info (shown in Settings → Business tab) ────────────────────
    businessName: {
      type: DataTypes.STRING(120),
      defaultValue: 'Vivid Arts',
    },
    businessEmail: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isEmail: true },
    },
    businessAddress: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // ── Notification preferences (Settings → Notifications tab) ─────────────
    // Stored as JSON so we can add more flags later without a migration
    notifPreferences: {
      type: DataTypes.JSON,
      defaultValue: {
        newOrder:          true,
        revisionRequested: true,
        proofApproved:     true,
        paymentReceived:   true,
        deadlineReminders: false,
      },
    },
  }, {
    tableName: 'Admins',
    timestamps: true,
  });

  // ── Instance method: check password ────────────────────────────────────────
  Admin.prototype.checkPassword = async function (plainText) {
    return bcrypt.compare(plainText, this.passwordHash);
  };

  // ── Static helper: hash a password before saving ───────────────────────────
  Admin.hashPassword = async (plain) => bcrypt.hash(plain, 12);

  return Admin;
};