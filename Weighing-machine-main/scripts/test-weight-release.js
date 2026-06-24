'use strict';

const WeightReleaseService = require('../backend/services/WeightReleaseService');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function testHoldAtPeakWhileStable() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 20000, offsetKg: 500 });

  assert(WeightReleaseService.isActive(), 'Session should be active');
  assert(
    WeightReleaseService.resolveDisplayKg(20000) === 20500,
    'Should hold at peak + offset',
  );
  assert(
    WeightReleaseService.resolveDisplayKg(20010) === 20500,
    'Should hold when raw is slightly above peak',
  );
  assert(
    WeightReleaseService.resolveDisplayKg(19990) === 20500,
    'Should hold within decrease threshold',
  );
  console.log('hold at peak while stable: ok');
}

function testNoActivateWithZeroOffset() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 20000, offsetKg: 0 });
  assert(!WeightReleaseService.isActive(), 'Zero offset should not activate');
  assert(
    WeightReleaseService.resolveDisplayKg(20000) === null,
    'Inactive session should return null',
  );
  console.log('no activate with zero offset: ok');
}

function testTransitionToReleasing() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 20000, offsetKg: 500 });

  const withinThreshold = WeightReleaseService.resolveDisplayKg(19985);
  assert(withinThreshold === 20500, 'Should still hold within threshold');

  const releasing = WeightReleaseService.resolveDisplayKg(19970);
  assert(releasing != null, 'Should return display during release');
  assert(releasing < 20500, 'Display should drop after threshold crossed');
  assert(releasing >= 19970, 'Display should not fall below raw');
  console.log('transition to releasing: ok');
}

function testMonotonicReleaseTowardRaw() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 10000, offsetKg: 200 });

  WeightReleaseService.resolveDisplayKg(10000);
  WeightReleaseService.resolveDisplayKg(9970);

  let previous = Infinity;
  const samples = [9500, 8000, 5000, 2000, 500];
  for (const raw of samples) {
    const display = WeightReleaseService.resolveDisplayKg(raw);
    assert(display != null, `Display should be set for raw ${raw}`);
    assert(display >= raw, `Display should not be below raw (${display} < ${raw})`);
    assert(display <= previous, `Display should decrease monotonically (${display} > ${previous})`);
    previous = display;
  }
  console.log('monotonic release toward raw: ok');
}

function testSessionClearsAtEnd() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 5000, offsetKg: 100 });

  WeightReleaseService.resolveDisplayKg(5000);
  WeightReleaseService.resolveDisplayKg(4970);

  let display = WeightReleaseService.resolveDisplayKg(100);
  assert(display != null, 'Should still resolve near end');
  assert(display >= 100, 'Near-end display should track raw');

  display = WeightReleaseService.resolveDisplayKg(50);
  assert(!WeightReleaseService.isActive(), 'Session should clear when offset is gone');
  assert(display === 50, 'Should return raw after session ends');
  console.log('session clears at end: ok');
}

function testClearOnZeroRaw() {
  WeightReleaseService.clear();
  WeightReleaseService.activate({ peakRawKg: 8000, offsetKg: 150 });
  WeightReleaseService.resolveDisplayKg(8000);

  const display = WeightReleaseService.resolveDisplayKg(0);
  assert(display === 0, 'Zero raw should return 0');
  assert(!WeightReleaseService.isActive(), 'Session should clear on zero raw');
  console.log('clear on zero raw: ok');
}

function run() {
  testHoldAtPeakWhileStable();
  testNoActivateWithZeroOffset();
  testTransitionToReleasing();
  testMonotonicReleaseTowardRaw();
  testSessionClearsAtEnd();
  testClearOnZeroRaw();
  console.log('\nAll weight release tests passed.');
}

run();
