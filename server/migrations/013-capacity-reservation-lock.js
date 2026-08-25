module.exports = {
  name: '013-capacity-reservation-lock',
  async up({ sequelize, transaction }) {
    const [existing] = await sequelize.query(
      'SELECT id FROM SiteSettings WHERE id = 1',
      { transaction },
    );
    if (existing.length) return;

    const now = new Date();
    await sequelize.getQueryInterface().bulkInsert('SiteSettings', [{
      id: 1,
      developmentMode: false,
      maintenanceMessage: 'The system is currently undergoing development. Please check back soon.',
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    }], { transaction });
  },
};
