import assert from 'node:assert/strict';
import test from 'node:test';
import { REPORT_PHOTO_SLOT, reportSlotCoverCrop } from './reportSlot.js';

test('report slot matches the production 200×120 cover crop', () => {
  assert.equal(REPORT_PHOTO_SLOT.width, 200);
  assert.equal(REPORT_PHOTO_SLOT.height, 120);
  assert.equal(REPORT_PHOTO_SLOT.objectFit, 'cover');
  assert.equal(REPORT_PHOTO_SLOT.columns, 3);
});

test('typical CCTV frames stay inside the report cell with little cover crop', () => {
  const crop = reportSlotCoverCrop(1616, 973);
  assert.ok(crop.croppedFraction < 0.08);
  assert.equal(crop.warning, false);
});

test('warns when a tall frame would lose ramp or truck content', () => {
  const crop = reportSlotCoverCrop(800, 1200);
  assert.equal(crop.axis, 'vertical');
  assert.equal(crop.warning, true);
  assert.ok(crop.croppedFraction > 0.4);
});
