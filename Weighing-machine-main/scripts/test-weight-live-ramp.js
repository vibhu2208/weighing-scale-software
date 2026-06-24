'use strict';

const WeightAdjustmentService = require('../backend/services/WeightAdjustmentService');
const SettingsService = require('../backend/services/SettingsService');

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

function testGradualLiveRamp() {
  withMockedSettings(
    {
      WEIGHT_ADJUSTMENT_ENABLED: 'true',
      WEIGHT_OFFSET_KG: '100',
    },
    () => {
      WeightAdjustmentService.clearLiveRamp();

      const first = WeightAdjustmentService.resolveLiveDisplay(100, 'GROSS');
      assert(first === 100, `First reading should be raw only, got ${first}`);

      const step2 = WeightAdjustmentService.resolveLiveDisplay(200, 'GROSS');
      assert(step2 > 200 && step2 < 300, `Early ramp should be partial, got ${step2}`);

      const mid = WeightAdjustmentService.resolveLiveDisplay(500, 'GROSS');
      assert(mid > 500 && mid < 600, `Mid ramp should be between raw and raw+offset, got ${mid}`);

      const peak = WeightAdjustmentService.resolveLiveDisplay(2100, 'GROSS');
      assert(peak === 2200, `After full ramp span display should be raw+offset, got ${peak}`);

      WeightAdjustmentService.clearLiveRamp();
      const stationary = WeightAdjustmentService.resolveLiveDisplay(5000, 'GROSS', {
        isStable: true,
      });
      assert(
        stationary === 5100,
        `Stable full load on scale should show raw+offset, got ${stationary}`,
      );
    },
  );

  WeightAdjustmentService.clearLiveRamp();
  console.log('gradual live ramp: ok');
}

testGradualLiveRamp();
console.log('\nLive ramp checks passed.');
