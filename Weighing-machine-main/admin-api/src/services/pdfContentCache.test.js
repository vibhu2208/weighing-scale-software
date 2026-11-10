'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pdfContentFingerprint } = require('./pdfContentCache');

test('pdfContentFingerprint changes when a photo key changes', () => {
  const base = {
    slip_number: 'WB100',
    truck_number: 'HR55A1234',
    arrival_photo_1: 'remote-trips/WB100/arrival_cam-1.jpg',
    gross_weight: 1000,
  };
  const a = pdfContentFingerprint(base, { grossPrint: true });
  const b = pdfContentFingerprint(
    { ...base, arrival_photo_1: 'remote-trips/WB100/arrival_cam-1-b.jpg' },
    { grossPrint: true },
  );
  assert.notEqual(a, b);
});

test('pdfContentFingerprint is stable for identical inputs', () => {
  const row = { slip_number: 'WB100', truck_number: 'X', material: 'RDF' };
  assert.equal(
    pdfContentFingerprint(row, { grossPrint: false }),
    pdfContentFingerprint({ ...row }, { grossPrint: false }),
  );
});

test('gross and normal fingerprints differ', () => {
  const row = { slip_number: 'WB100' };
  assert.notEqual(
    pdfContentFingerprint(row, { grossPrint: true }),
    pdfContentFingerprint(row, { grossPrint: false }),
  );
});
