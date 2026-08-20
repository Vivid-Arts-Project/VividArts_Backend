const { DataTypes } = require('sequelize');
const baseline = require('./001-baseline-and-repairs');
const paymentIntegrity = require('./002-payment-integrity');

const migrations = [baseline, paymentIntegrity];

async function runMigrations(db) {
  const Migration = db.sequelize.define('SchemaMigration', {
    name: { type: DataTypes.STRING(160), primaryKey: true },
  }, {
    tableName: 'SchemaMigrations',
    timestamps: true,
  });
  await Migration.sync();

  for (const migration of migrations) {
    const applied = await Migration.findByPk(migration.name);
    if (applied) continue;
    await db.sequelize.transaction(async transaction => {
      await migration.up({ db, sequelize: db.sequelize, transaction });
      await Migration.create({ name: migration.name }, { transaction });
    });
    console.log(`✓ Applied database migration ${migration.name}`);
  }
}

module.exports = { runMigrations };
