require('dotenv').config();

const db = require('../models');
const { runMigrations } = require('../migrations');

(async () => {
  await db.sequelize.authenticate();
  await runMigrations(db);
  console.log('✓ Database migrations are up to date');
  await db.sequelize.close();
})().catch(error => {
  console.error('✗ Database migration failed:', error);
  process.exitCode = 1;
});
