// server/models/ProofImage.js
// Stores proof/approval images the artist uploads via the admin dashboard.
// One order can have multiple proof images (if the customer requests revisions,
// the artist uploads a new version each time).

module.exports = (sequelize, DataTypes) => {
  const ProofImage = sequelize.define('ProofImage', {
    proof_id: {
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
    // Full HTTPS URL — used directly in <img src="..."> on the customer's order page
    cloudinary_url: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    // Cloudinary public_id — used to delete old proofs when a revision is uploaded
    cloudinary_public_id: {
      type: DataTypes.STRING(300),
      allowNull: true,
    },

    // ── Version tracking ──────────────────────────────────────────────────────
    // v1 = first proof, v2 = after first revision, etc.
    version: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
    },
    // Is this the currently active proof (the one the customer should review)?
    is_current: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    // ── Review outcome ────────────────────────────────────────────────────────
    // Set when the customer acts on this proof
    review_status: {
      type: DataTypes.ENUM('pending', 'approved', 'revision_requested'),
      defaultValue: 'pending',
    },
    // If customer requests revision, their note goes here
    revision_note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    reviewed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // ── Artist notes ──────────────────────────────────────────────────────────
    artist_note: {
      type: DataTypes.TEXT,
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
  }, {
    tableName: 'ProofImages',
    timestamps: true,   // createdAt = when artist uploaded this version
    indexes: [{ unique: true, fields: ['order_id', 'version'], name: 'proof_images_order_version_unique' }],
  });

  // ── Associations ─────────────────────────────────────────────────────────────
  ProofImage.associate = (models) => {
    ProofImage.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order',
    });
  };

  return ProofImage;
};
