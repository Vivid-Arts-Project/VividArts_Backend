const { DataTypes } = require('sequelize');

module.exports = {
  name: '012-order-workflow-integrity',
  async up({ sequelize, transaction }) {
    const queryInterface = sequelize.getQueryInterface();
    const orderColumns = await queryInterface.describeTable('Orders');

    await queryInterface.changeColumn('Orders', 'status', {
      type: DataTypes.ENUM(
        'in_queue', 'sketching', 'waiting_for_feedback', 'revision_requested',
        'approved', 'finished', 'framed', 'shipped', 'done', 'cancelled',
      ),
      allowNull: false,
      defaultValue: 'in_queue',
    }, { transaction });

    const addOrderColumn = async (name, definition) => {
      if (!orderColumns[name]) await queryInterface.addColumn('Orders', name, definition, { transaction });
    };
    await addOrderColumn('cancelled_at', { type: DataTypes.DATE, allowNull: true });
    await addOrderColumn('cancellation_reason', { type: DataTypes.STRING(500), allowNull: true });
    await addOrderColumn('cancelled_by_admin_id', { type: DataTypes.UUID, allowNull: true });

    const [duplicates] = await sequelize.query(`
      SELECT order_id, version
      FROM ProofImages
      GROUP BY order_id, version
      HAVING COUNT(*) > 1
      LIMIT 1
    `, { transaction });
    if (duplicates.length) throw new Error('Duplicate proof versions must be repaired before enforcing workflow integrity');

    const indexes = await queryInterface.showIndex('ProofImages');
    if (!indexes.some(index => index.name === 'proof_images_order_version_unique')) {
      await queryInterface.addIndex('ProofImages', ['order_id', 'version'], {
        name: 'proof_images_order_version_unique',
        unique: true,
        transaction,
      });
    }
  },
};
