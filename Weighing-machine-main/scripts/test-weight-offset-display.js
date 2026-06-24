'use strict';

const WeightReleaseService = require('../backend/services/WeightReleaseService');
const WeightAdjustmentService = require('../backend/services/WeightAdjustmentService');
const DeviceMonitorService = require('../backend/services/DeviceMonitorService');
const WorkflowEngine = require('../backend/engine/WorkflowEngine');
const SettingsService = require('../backend/services/SettingsService');
const TransactionService = require('../backend/services/TransactionService');

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function withMockedSettings(values, fn) {
  const original = SettingsService.get;
  SettingsService.get = (key) => {
    if (values[key] !== undefined) return values[key];
    if (key === 'WEIGHT_ADJUSTMENT_ENABLED') return 'false';
    if (key === 'WEIGHT_OFFSET_KG') return '0';
    try {
      return original(key);
    } catch (_e) {
      return '';
    }
  };
  try {
    return fn();
  } finally {
    SettingsService.get = original;
  }
}

function testClearSessionPreservesRelease() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 20000, offsetKg: 500 });
  assert(WeightReleaseService.isActive(), 'Release should be active before clearSessionAfterSave');

  WorkflowEngine.clearSessionAfterSave();

  assert(WeightReleaseService.isActive(), 'clearSessionAfterSave must not clear weight release');
  assert(
    WeightReleaseService.resolveDisplayKg(20000) === 20500,
    'Hold weight should persist after clearSessionAfterSave',
  );
  WeightReleaseService.clear();
  console.log('clearSessionAfterSave preserves release: ok');
}

function testLiveGrossOffsetFromWeighmentContext() {
  const originalInfo = TransactionService.getVehicleWeighmentInfo;
  TransactionService.getVehicleWeighmentInfo = () => ({
    mode: 'CLOSE',
    vehicleType: 'truck',
  });

  try {
    withMockedSettings(
      {
        WEIGHT_ADJUSTMENT_ENABLED: 'true',
        WEIGHT_OFFSET_KG: '500',
      },
      () => {
        WeightAdjustmentService.clearLiveRamp();
        DeviceMonitorService.clearWeighmentContext();
        DeviceMonitorService.setWeighmentContext({
          truckNumber: 'OFFSET-TEST-TRUCK',
          rfidTag: 'RFID-OFFSET-TEST',
        });

        const pass = DeviceMonitorService.getWorkflowPassForAdjustment();
        assert(pass === 'GROSS', `Expected GROSS pass for CLOSE ticket, got ${pass}`);

        const first = DeviceMonitorService.resolveLiveDisplayWeight(20000);
        assert(first === 20000, `First live tick should be raw only, got ${first}`);

        const ramped = DeviceMonitorService.resolveLiveDisplayWeight(25000);
        assert(
          ramped > 25000 && ramped < 25500,
          `Ramped display should be between raw and raw+offset, got ${ramped}`,
        );

        const peak = DeviceMonitorService.resolveLiveDisplayWeight(30000);
        assert(
          peak > 30000 && peak <= 30500,
          `Higher load should approach raw+offset, got ${peak}`,
        );

        WeightAdjustmentService.clearLiveRamp();
        DeviceMonitorService.setWeighmentContext({
          truckNumber: 'OFFSET-TEST-TRUCK',
          rfidTag: 'RFID-OFFSET-TEST',
        });
        const stationaryStable = DeviceMonitorService.resolveLiveDisplayWeight(
          28000,
          { isStable: true },
        );
        assert(
          stationaryStable === 28500,
          `Full load already on scale (stable) should show raw+offset, got ${stationaryStable}`,
        );

        const tareDisplay = WeightAdjustmentService.apply(20000, {
          live: false,
          pass: 'TARE',
        });
        assert(tareDisplay === 20000, 'TARE pass should not add offset');

        DeviceMonitorService.clearWeighmentContext();
      },
    );
  } finally {
    TransactionService.getVehicleWeighmentInfo = originalInfo;
  }

  console.log('live GROSS offset from weighment context: ok');
}

function testIntegrationReleaseAfterClearSession() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 15000, offsetKg: 300 });

  WorkflowEngine.clearSessionAfterSave();

  const released = WeightReleaseService.resolveDisplayKg(15000);
  assert(released === 15300, `Expected held display 15300, got ${released}`);
  WeightReleaseService.clear();
  console.log('integration release after clearSession: ok');
}

testClearSessionPreservesRelease();
testLiveGrossOffsetFromWeighmentContext();
testIntegrationReleaseAfterClearSession();
console.log('\nWeight offset display checks passed.');
