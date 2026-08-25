const { DataTypes } = require('sequelize');

module.exports = {
  name: '015-verification-token-integrity',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const columns = await queryInterface.describeTable('verification_tokens');
    if (!columns.requestWindowStartedAt) {
      await queryInterface.addColumn('verification_tokens', 'requestWindowStartedAt', {
        type: DataTypes.DATE, allowNull: true,
      }, { transaction });
    }
    if (!columns.requestCount) {
      await queryInterface.addColumn('verification_tokens', 'requestCount', {
        type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
      }, { transaction });
    }
    if (!columns.context) {
      await queryInterface.addColumn('verification_tokens', 'context', {
        type: DataTypes.JSON, allowNull: true,
      }, { transaction });
    }

    await sequelize.query(`
      DELETE older
      FROM verification_tokens older
      INNER JOIN verification_tokens newer
        ON older.identifier = newer.identifier
       AND older.type = newer.type
       AND older.id < newer.id
    `, { transaction });
    const indexes = await queryInterface.showIndex('verification_tokens');
    if (!indexes.some(index => index.name === 'verification_tokens_identifier_type_unique')) {
      await queryInterface.addIndex('verification_tokens', ['identifier', 'type'], {
        name: 'verification_tokens_identifier_type_unique',
        unique: true,
        transaction,
      });
    }
  },
};
