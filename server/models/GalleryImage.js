module.exports = (sequelize, DataTypes) => sequelize.define('GalleryImage', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  placement: { type: DataTypes.ENUM('home', 'gallery', 'both'), allowNull: false, defaultValue: 'gallery' },
  title: { type: DataTypes.STRING(120), allowNull: false },
  subtitle: { type: DataTypes.STRING(120), allowNull: true },
  imageUrl: { type: DataTypes.STRING(500), allowNull: false },
  publicId: { type: DataTypes.STRING(300), allowNull: true },
  altText: { type: DataTypes.STRING(180), allowNull: true },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { tableName: 'GalleryImages', timestamps: true });
