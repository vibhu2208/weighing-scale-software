import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultPhotoMapping,
  destinationSlotsFor,
  resolveMappedPhotoSlots,
} from './bulkVehiclePhotos.js';

describe('photo slot mapping for Create images', () => {
  it('defaults AC1→AC1+AC2 and AC2→AC3', () => {
    const mapping = defaultPhotoMapping();
    assert.deepEqual(destinationSlotsFor('arrival', 1, mapping), [1, 2]);
    assert.deepEqual(destinationSlotsFor('arrival', 2, mapping), [3]);
    assert.deepEqual(destinationSlotsFor('departure', 1, mapping), [1, 2]);
    assert.deepEqual(destinationSlotsFor('departure', 2, mapping), [3]);
  });

  it('places AC1 into ac1+ac2 and AC2 into ac3 only', () => {
    const mapping = defaultPhotoMapping();
    const resolved = resolveMappedPhotoSlots(
      'arrival',
      { 1: 'key-ac1', 2: 'key-ac2' },
      mapping,
    );
    assert.deepEqual(
      resolved.map((r) => ({ slot: r.slot, sourceSlot: r.sourceSlot, key: r.key })),
      [
        { slot: 1, sourceSlot: 1, key: 'key-ac1' },
        { slot: 2, sourceSlot: 1, key: 'key-ac1' },
        { slot: 3, sourceSlot: 2, key: 'key-ac2' },
      ],
    );
  });

  it('lets a direct source win over a routed copy for the same slot', () => {
    const mapping = {
      arrival: { 1: [1, 2], 2: [2, 3], 3: [] },
      departure: { 1: [1], 2: [2], 3: [3] },
    };
    const resolved = resolveMappedPhotoSlots(
      'arrival',
      { 1: 'key-ac1', 2: 'key-ac2' },
      mapping,
    );
    const bySlot = Object.fromEntries(resolved.map((r) => [r.slot, r]));
    assert.equal(bySlot[2].key, 'key-ac2');
    assert.equal(bySlot[2].sourceSlot, 2);
    assert.equal(bySlot[3].key, 'key-ac2');
  });

  it('skips sources that map to no destinations', () => {
    const mapping = {
      arrival: { 1: [1], 2: [], 3: [] },
      departure: { 1: [], 2: [], 3: [] },
    };
    const resolved = resolveMappedPhotoSlots(
      'arrival',
      { 1: 'key-ac1', 2: 'key-ac2' },
      mapping,
    );
    assert.deepEqual(
      resolved.map((r) => ({ slot: r.slot, key: r.key })),
      [{ slot: 1, key: 'key-ac1' }],
    );
  });
});
