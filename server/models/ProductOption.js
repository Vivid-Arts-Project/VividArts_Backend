// server/models/ProductOption.js
// Stores the customisation choices the customer made when placing an order.
// Separated from Order so pricing logic can be re-run cleanly from these values.

module.exports = (sequelize, DataTypes) => {
  const ProductOption = sequelize.define('ProductOption', {
    product_id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    // ── Paper size ────────────────────────────────────────────────────────────
    paper_size: {
      type: DataTypes.ENUM('A4', 'A3'),
      allowNull: false,
    },

    // ── Number of subjects (people) in the portrait ───────────────────────────
    // Stored as the actual count (1, 2, 3 …) — easier to do arithmetic on
    num_subjects: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      validate: { min: 1, max: 10 },
    },

    // ── Frame type chosen by customer ─────────────────────────────────────────
    frame_type: {
      type: DataTypes.ENUM('without_frame', 'plastic_frame', 'wooden_frame'),
      allowNull: false,
      defaultValue: 'without_frame',
    },

    // ── Pickup or courier delivery ────────────────────────────────────────────
    pickup_option: {
      type: DataTypes.ENUM('pickup', 'courier'),
      allowNull: false,
      defaultValue: 'pickup',
    },

    // ── Urgent / rush order flag ──────────────────────────────────────────────
    is_urgent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Deadline set by customer when is_urgent = true (within the next 7 days)
    urgent_deadline: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    is_scheduled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    scheduled_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    scheduled_start_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },

    // ── Any special note or instruction from the customer ─────────────────────
    customer_note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    tableName: 'ProductOptions',
    timestamps: true,
  });

  // ── Associations ─────────────────────────────────────────────────────────────
  ProductOption.associate = (models) => {
    // Each set of product options belongs to exactly one order
    ProductOption.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order',
    });
  };

  return ProductOption;
};
