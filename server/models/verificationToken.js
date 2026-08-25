module.exports = (sequelize, DataTypes) => {
  const VerificationToken = sequelize.define('VerificationToken', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    identifier: {
      type: DataTypes.STRING, // Email or user identifier
      allowNull: false,
    },
    otp: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING, // Purpose type e.g., 'register', 'password_reset'
      defaultValue: 'register',
    },
    attempts: {
      type: DataTypes.INTEGER,
      defaultValue: 0, // Track incorrect verification attempts
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    lastResentAt: {
      type: DataTypes.DATE, // Track time for resend cooldown
      allowNull: true,
    },
    requestWindowStartedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    requestCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    context: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  }, {
    tableName: 'verification_tokens',
    timestamps: true,
    indexes: [{ unique: true, fields: ['identifier', 'type'], name: 'verification_tokens_identifier_type_unique' }],
  });

  return VerificationToken;
};
