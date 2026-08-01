// server/models/Customer.js
// FIXED: removed manual created_at field (conflict with Sequelize timestamps)
// ADDED: associate() for Order relationship

module.exports = (sequelize, DataTypes) => {
  const Customer = sequelize.define('Customer', {
    customer_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    full_name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    address: {
      type: DataTypes.STRING,
      allowNull: true,          // relaxed — customer can fill this later
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
    },
    phone_number: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    username: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    password_hash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    // OAuth fields (for Google/Facebook login via passport.js)
    provider: {
      type: DataTypes.ENUM('local', 'google', 'facebook'),
      defaultValue: 'local',
    },
    providerId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Profile images stored on Cloudinary (optional)
    profile_image_url: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    profile_image_public_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    cover_image_url: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    cover_image_public_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  }, {
    tableName: 'Customers',
    // Let Sequelize manage createdAt and updatedAt automatically.
    // The old manual created_at field was removed — this replaces it.
    timestamps: true,
  });

  // ── Associations ─────────────────────────────────────────────────────────────
  Customer.associate = (models) => {
    // A customer can place many orders
    Customer.hasMany(models.Order, {
      foreignKey: 'customer_id',
      as: 'orders',
    });
  };

  return Customer;
};