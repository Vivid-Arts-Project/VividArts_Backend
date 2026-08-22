const { DataTypes } = require('sequelize');

module.exports = {
  name: '006-existing-table-controls',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const tableNames = (await queryInterface.showAllTables())
      .map(table => typeof table === 'string' ? table : (table.tableName || table.name));
    const actualName = wanted => tableNames.find(name => String(name).toLowerCase() === wanted.toLowerCase());
    const adminsTable = actualName('Admins');
    const galleryTable = actualName('GalleryImages');

    if (adminsTable) {
      const columns = await queryInterface.describeTable(adminsTable);
      if (!columns.isSuperAdmin) {
        await queryInterface.addColumn(adminsTable, 'isSuperAdmin', {
          type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
        }, { transaction });
      }
      const [admins] = await sequelize.query(`SELECT \`id\` FROM \`${adminsTable}\` ORDER BY \`createdAt\` ASC LIMIT 1`, { transaction });
      if (admins[0]) {
        await sequelize.query(`UPDATE \`${adminsTable}\` SET \`isSuperAdmin\` = 1 WHERE \`id\` = :id`, {
          replacements: { id: admins[0].id }, transaction,
        });
      }
    }

    if (galleryTable) {
      await queryInterface.changeColumn(galleryTable, 'placement', {
        type: DataTypes.ENUM('home', 'gallery', 'both'), allowNull: false, defaultValue: 'gallery',
      }, { transaction });
    }
  },
};
