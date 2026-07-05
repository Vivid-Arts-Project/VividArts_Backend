const { DataTypes } = require('sequelize');

// This table stores every row from the Price_Config_Table PDF.
// The admin can update prices from the Settings page and they take effect
// immediately for all new orders — no code change needed.

module.exports = (sequelize) => {
  const PriceConfig = sequelize.define('PriceConfig', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    // ── Matches the columns in the PDF exactly ───────────────────────────────
    category: {
      // BASE_PRICE | SUBJECT_ADDON | FRAME | SERVICE
      type: DataTypes.ENUM('BASE_PRICE', 'SUBJECT_ADDON', 'FRAME', 'SERVICE'),
      allowNull: false,
    },
    itemKey: {
      // e.g. "BASE_A4_1_SUBJ", "ADDON_A3_2_SUBJ", "FRAME_CLASSIC_A4"
      // Must be unique — the pricing engine looks up by this key
      type: DataTypes.STRING(60),
      allowNull: false,
      unique: true,
    },
    description: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    price: {
      // Stored in LKR (Rs.)
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    isActive: {
      // Set to false to disable a line item without deleting it
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  }, {
    tableName: 'PriceConfigs',
    timestamps: true,
  });

  return PriceConfig;
};