// server/models/Order.js
// The central table. Every other table (ProductOption, ReferencePhoto,
// ProofImage, Payment, Message) links back to an Order row.

module.exports = (sequelize, DataTypes) => {
  const Order = sequelize.define('Order', {
    order_id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    // ── Foreign keys ──────────────────────────────────────────────────────────
    // Which customer placed this order
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Customers', key: 'customer_id' },
    },
    // The product options (paper size, frame, subjects etc.) for this order
    // One-to-one: one order has one set of product options
    product_id: {
      type: DataTypes.UUID,
      allowNull: true,          // set after ProductOption row is created
      references: { model: 'ProductOptions', key: 'product_id' },
    },

    // ── Pricing ───────────────────────────────────────────────────────────────
    // Price calculated by pricingEngine.js at order creation time.
    // Stored so it doesn't change if the admin later edits PriceConfig.
    calculated_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00,
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'LKR',
    },
    // advance = 50% paid now, full = 100% paid now
    payment_type: {
      type: DataTypes.ENUM('advance', 'full'),
      allowNull: false,
      defaultValue: 'advance',
    },
    // How much the customer has paid so far (updated after each payment)
    amount_paid: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00,
    },

    // ── Order status ──────────────────────────────────────────────────────────
    // Full lifecycle from queue to done
    status: {
      type: DataTypes.ENUM(
        'in_queue',             // just placed, waiting for artist to start
        'sketching',            // artist is working on it
        'waiting_for_feedback', // proof uploaded, waiting for customer approval
        'revision_requested',   // customer asked for changes
        'approved',             // customer approved the proof
        'finished',             // artwork is complete
        'framed',               // framing done (if frame was chosen)
        'shipped',              // sent via courier OR ready for pickup
        'done'                  // customer received, order complete
      ),
      defaultValue: 'in_queue',
    },

    // ── Urgent order ──────────────────────────────────────────────────────────
    is_urgent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    // ── Pickup location (filled by admin when order is ready for pickup) ──────
    artist_location: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // ── Timestamps for key events ─────────────────────────────────────────────
    proof_uploaded_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    approved_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName: 'Orders',
    timestamps: true,   // adds createdAt (= order placed date) and updatedAt
  });

  // ── Associations ─────────────────────────────────────────────────────────────
  Order.associate = (models) => {
    // Who placed it
    Order.belongsTo(models.Customer, {
      foreignKey: 'customer_id',
      as: 'customer',
    });

    // What they customised
    Order.belongsTo(models.ProductOption, {
      foreignKey: 'product_id',
      as: 'productOption',
    });

    // Reference photos the customer uploaded at order time
    Order.hasMany(models.ReferencePhoto, {
      foreignKey: 'order_id',
      as: 'referencePhotos',
    });

    // Proof images the artist uploaded
    Order.hasMany(models.ProofImage, {
      foreignKey: 'order_id',
      as: 'proofImages',
    });

    // Payment records for this order
    Order.hasMany(models.Payment, {
      foreignKey: 'order_id',
      as: 'payments',
    });

    // Chat messages between customer and artist
    Order.hasMany(models.Message, {
      foreignKey: 'order_id',
      as: 'messages',
    });
  };

  return Order;
};
