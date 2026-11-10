import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDestinationNames, normalizeFillVehicles } from './fillLists.js';

test('mergeDestinationNames keeps PC destinations when fill list is smaller', () => {
  const merged = mergeDestinationNames(
    ['MEERUT', 'GWAL PAHARI', 'BADKHAL'],
    ['MUZAFFAR NAGAR'],
  );
  assert.deepEqual(merged, ['MEERUT', 'GWAL PAHARI', 'BADKHAL', 'MUZAFFAR NAGAR']);
});

test('mergeDestinationNames does not duplicate case-insensitive names', () => {
  const merged = mergeDestinationNames(['Meerut', 'Pali'], ['MEERUT', 'BADKHAL']);
  assert.deepEqual(merged, ['Meerut', 'Pali', 'BADKHAL']);
});

test('mergeDestinationNames ignores blank entries', () => {
  const merged = mergeDestinationNames(['MEERUT', '  ', null], ['', 'PALI']);
  assert.deepEqual(merged, ['MEERUT', 'PALI']);
});

test('keeps fill-vehicle camera stills through normalize', () => {
  const [vehicle] = normalizeFillVehicles([
    {
      truck_number: 'hr58 e3515',
      kind: 'RDF',
      default_tare: 12000,
      arrival_cam_1: 'fill-vehicles/HR58E3515/arrival_cam-1.jpg',
      arrival_cam_2: 'fill-vehicles/HR58E3515/arrival_cam-2.jpg',
      departure_cam_1: 'fill-vehicles/HR58E3515/departure_cam-1.jpg',
      departure_cam_2: 'fill-vehicles/HR58E3515/departure_cam-2.jpg',
      ignored: 'nope',
    },
  ]);
  assert.equal(vehicle.truck_number, 'HR58E3515');
  assert.equal(vehicle.arrival_cam_1, 'fill-vehicles/HR58E3515/arrival_cam-1.jpg');
  assert.equal(vehicle.arrival_cam_2, 'fill-vehicles/HR58E3515/arrival_cam-2.jpg');
  assert.equal(vehicle.departure_cam_1, 'fill-vehicles/HR58E3515/departure_cam-1.jpg');
  assert.equal(vehicle.departure_cam_2, 'fill-vehicles/HR58E3515/departure_cam-2.jpg');
  assert.equal(vehicle.ignored, undefined);
  assert.equal(vehicle.net_min, undefined);
});

test('drops camera keys that are not fill-vehicle stills', () => {
  const [vehicle] = normalizeFillVehicles([
    {
      truck_number: 'HR58E3515',
      kind: 'COMPOST',
      arrival_cam_1: '../secrets.jpg',
      arrival_cam_2: '',
    },
  ]);
  assert.equal(vehicle.arrival_cam_1, undefined);
  assert.equal(vehicle.arrival_cam_2, undefined);
});
