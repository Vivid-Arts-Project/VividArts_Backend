// server/models/Payment.js
// FIXED: orderId now references Orders table (FK) instead of being a plain string
// ADDED: associate() so Payment belongs to Order
// ADDED: paymentType (advance/full) which the project description requires

module.exports = (sequelize, DataTypes) => {
  const Payment = sequelize.define('Payment', {
    paymentId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    // FK → Orders.order_id
    // The PayHere route also generates its own string orderId (e.g. "ORD-1718000000-123")
    // so we keep both: order_id links to our Orders table, payhereOrderId is the PayHere string
    order_id: {
      type: DataTypes.UUID,
      allowNull: true,          // null until an actual Order record is linked
      references: { model: 'Orders', key: 'order_id' },
    },
    // PayHere's own order ID string (e.g. "ORD-1718000000-123")
    payhereOrderId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'LKR',
    },

    // advance = 50% deposit,  full = 100% paid upfront
    paymentType: {
      type: DataTypes.ENUM('advance', 'full'),
      defaultValue: 'advance',
    },
    paymentMethod: {
      type: DataTypes.ENUM('card', 'bank'),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'completed', 'failed'),
      defaultValue: 'pending',
    },
    completedAt: { type: DataTypes.DATE, allowNull: true },

    transactionId:    { type: DataTypes.STRING, allowNull: true },
    payherePaymentId: { type: DataTypes.STRING, allowNull: true },
    payhereMd5sig:    { type: DataTypes.STRING, allowNull: true },
    cardLast4:        { type: DataTypes.STRING(4), allowNull: true },
    cardHolderName:   { type: DataTypes.STRING, allowNull: true },
    bankName:         { type: DataTypes.STRING, allowNull: true },
    bankReference:    { type: DataTypes.STRING, allowNull: true },
    metadata:         { type: DataTypes.JSON,   allowNull: true },
  }, {
    tableName: 'Payments',
    timestamps: true,
    indexes: [{ unique: true, fields: ['order_id', 'paymentType'], name: 'payments_order_purpose_unique' }],
  });

  // ── Associations ─────────────────────────────────────────────────────────────
  Payment.associate = (models) => {
    // Each payment record belongs to one order
    Payment.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order',
    });
  };

  return Payment;
};
