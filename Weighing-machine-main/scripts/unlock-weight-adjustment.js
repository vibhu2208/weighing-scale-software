'use strict';

/**
 * Renew the weight-increase feature window (unlocks Advance Setting controls).
 *
 * Run on the weighbridge PC:
 *   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/unlock-weight-adjustment.js
 */

const { initDatabase, closeDatabase } = require('../backend/database/db');
const SettingsService = require('../backend/services/SettingsService');
const WeightAdjustmentService = require('../backend/services/WeightAdjustmentService');

async function main() {
  initDatabase();
  const before = WeightAdjustmentService.getFeatureStatus();
  console.log('Before:', before);

  const after = WeightAdjustmentService.renewFeatureWindow('unlock_script');
  console.log('After:', after);

  // Keep enable flag on so the toggle stays usable after unlock.
  if (SettingsService.get('WEIGHT_ADJUSTMENT_ENABLED') !== 'true') {
    SettingsService.set('WEIGHT_ADJUSTMENT_ENABLED', 'true');
    WeightAdjustmentService.onEnabledSettingChanged('true');
  }

  try {
    const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');
    if (typeof CloudAdminSyncService.processNow === 'function') {
      const sync = await CloudAdminSyncService.processNow();
      console.log('Cloud sync:', sync);
    }
  } catch (err) {
    console.warn('Cloud sync skipped:', err.message);
  }

  console.log('Weight increase unlocked. Restart the weighbridge app if Settings still shows the error.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      closeDatabase();
    } catch (_e) {
      /* ignore */
    }
  });
