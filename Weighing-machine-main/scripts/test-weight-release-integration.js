'use strict';

const WeightReleaseService = require('../backend/services/WeightReleaseService');

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function buildDisplay(raw) {
  const released = WeightReleaseService.resolveDisplayKg(raw);
  if (released != null) {
    return { weight: released, weightReleaseActive: true, rawWeight: raw };
  }
  return { weight: raw, weightReleaseActive: false, rawWeight: raw };
}

function testPostCloseHoldAfterSave() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 20000, offsetKg: 500 });

  const stable = buildDisplay(20000);
  assert(stable.weight === 20500, 'After close save, display should hold offset weight');
  assert(stable.weightReleaseActive, 'Release session should be active');

  const afterReset = buildDisplay(20000);
  assert(afterReset.weight === 20500, 'Hold should persist after screen reset simulation');
  console.log('post-close hold after save: ok');
}

function testGradualReleaseOnDeparture() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 10000, offsetKg: 200 });

  buildDisplay(10000);
  let previous = 10200;
  for (const raw of [9970, 9000, 7000, 4000, 1000]) {
    const payload = buildDisplay(raw);
    assert(payload.weightReleaseActive || raw <= 1000, 'Active until offset bleeds off');
    assert(payload.weight >= raw, `Display ${payload.weight} should be >= raw ${raw}`);
    if (payload.weightReleaseActive) {
      assert(payload.weight <= previous, 'Display should decrease during departure');
      previous = payload.weight;
    }
  }
  console.log('gradual release on departure: ok');
}

function testLedAndScreenShareSameWeight() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 15000, offsetKg: 300 });

  const ui = buildDisplay(15000);
  const led = buildDisplay(15000);
  assert(ui.weight === led.weight, 'UI and LED should show the same held weight');
  console.log('led and screen share same weight: ok');
}

function testClearSessionDoesNotKillRelease() {
  const WorkflowEngine = require('../backend/engine/WorkflowEngine');
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 20000, offsetKg: 500 });

  WorkflowEngine.clearSessionAfterSave();

  assert(WeightReleaseService.isActive(), 'Release must survive clearSessionAfterSave');
  assert(buildDisplay(20000).weight === 20500, 'Held weight must survive clearSessionAfterSave');
  WeightReleaseService.clear();
  console.log('clearSessionAfterSave does not kill release: ok');
}

testPostCloseHoldAfterSave();
testGradualReleaseOnDeparture();
testLedAndScreenShareSameWeight();
testClearSessionDoesNotKillRelease();
console.log('\nIntegration checks passed.');
