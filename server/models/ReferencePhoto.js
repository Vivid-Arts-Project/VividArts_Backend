// server/models/ReferencePhoto.js
// Stores the reference photos a customer uploads when placing an order.
// Uploaded to Cloudinary via upload.js middleware.
// One order can have up to 5 reference photos.

module.exports = (sequelize, DataTypes) => {
  const ReferencePhoto = sequelize.define('ReferencePhoto', {
    ref_id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    // FK → Orders.order_id
    order_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'Orders', key: 'order_id' },
    },

    // ── Cloudinary fields ─────────────────────────────────────────────────────
    // Full HTTPS URL from Cloudinary — used directly in <img src="...">
    cloudinary_url: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    // Cloudinary public_id — needed if you ever want to delete the image
    // e.g. "art-studio/references/ref_1718000000_photo1"
    cloudinary_public_id: {
      type: DataTypes.STRING(300),
      allowNull: true,
    },

    // ── File metadata ─────────────────────────────────────────────────────────
    original_filename: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    file_size_bytes: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // MIME type e.g. "image/jpeg"
    mime_type: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },

    // Display order in the UI (so customer can arrange photos 1, 2, 3…)
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
  }, {
    tableName: 'ReferencePhotos',
    timestamps: true,
  });

  // ── Associations ─────────────────────────────────────────────────────────────
  ReferencePhoto.associate = (models) => {
    ReferencePhoto.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order',
    });
  };

  return ReferencePhoto;
};