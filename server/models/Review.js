module.exports = (sequelize, DataTypes) => {
  const Review = sequelize.define('Review', {
    review_id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    order_id: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: { model: 'Orders', key: 'order_id' },
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Customers', key: 'customer_id' },
    },
    rating: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(120), allowNull: false },
    comment: { type: DataTypes.TEXT, allowNull: false },
    image_url: { type: DataTypes.STRING(500), allowNull: true },
    image_public_id: { type: DataTypes.STRING(300), allowNull: true },
    allow_public_image: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
    },
    is_featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    admin_reply: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'Reviews',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['order_id'] },
      { fields: ['status', 'is_featured'] },
      { fields: ['customer_id'] },
    ],
  });

  Review.associate = models => {
    Review.belongsTo(models.Order, { foreignKey: 'order_id', as: 'order' });
    Review.belongsTo(models.Customer, { foreignKey: 'customer_id', as: 'customer' });
  };

  return Review;
};
