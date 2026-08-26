const { DataTypes } = require('sequelize');
const baseline = require('./001-baseline-and-repairs');
const paymentIntegrity = require('./002-payment-integrity');
const reviews = require('./003-reviews');
const emailDeliveryQueue = require('./003-email-delivery-queue');
const verificationTokens = require('./004-verification-tokens');
const adminControlsAndSiteSettings = require('./005-admin-controls-and-site-settings');
const existingTableControls = require('./006-existing-table-controls');
const adminAccountStatus = require('./007-admin-account-status');
const scheduledOrders = require('./008-scheduled-orders');
const onlinePaymentsOnly = require('./009-online-payments-only');
const customerTokenVersion = require('./010-customer-token-version');
const payhereCallbackIntegrity = require('./011-payhere-callback-integrity');
const orderWorkflowIntegrity = require('./012-order-workflow-integrity');
const capacityReservationLock = require('./013-capacity-reservation-lock');
const emailQueueClaims = require('./014-email-queue-claims');
const verificationTokenIntegrity = require('./015-verification-token-integrity');
const paymentFinishedOrderStatus = require('./016-payment-finished-order-status');

const migrations = [
  baseline,
  paymentIntegrity,
  reviews,
  emailDeliveryQueue,
  verificationTokens,
  adminControlsAndSiteSettings,
  existingTableControls,
  adminAccountStatus,
  scheduledOrders,
  onlinePaymentsOnly,
  customerTokenVersion,
  payhereCallbackIntegrity,
  orderWorkflowIntegrity,
  capacityReservationLock,
  emailQueueClaims,
  verificationTokenIntegrity,
  paymentFinishedOrderStatus,
];

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
