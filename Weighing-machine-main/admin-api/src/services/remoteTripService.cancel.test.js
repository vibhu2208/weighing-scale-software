'use strict';

const assert = require('assert');
const { validateRemoteTripFields, buildCreatePayload } = require('./remoteTripService');

const lists = {
  materials: ['RDF'],
  customers: ['MCG'],
  destinations: ['MUZAFFAR NAGAR'],
  operators: ['PARDEEP'],
};

function closedBody(extra = {}) {
  return {
    ticket_status: 'CLOSED',
    vehicle_type: 'TRUCK',
    truck_number: 'HR58E3515',
    operator_name: 'PARDEEP',
    material: 'RDF',
    customer_name: 'MCG',
    destination: 'MUZAFFAR NAGAR',
    gross_weight: 65220,
    tare_weight: 15810,
    timestamp_in: '2026-10-30T12:40:37.000Z',
    timestamp_out: '2026-10-30T15:07:57.000Z',
    ...extra,
  };
}

function cancelledBody(extra = {}) {
  return closedBody({
    ticket_status: 'CANCELLED',
    truck_number: 'CANCEL',
    operator_name: 'CANCEL',
    material: 'CANCEL',
    customer_name: 'CANCEL',
    destination: 'CANCEL',
    gross_weight: 0,
    tare_weight: 0,
    ...extra,
  });
}

const closed = validateRemoteTripFields(closedBody(), lists);
assert.deepStrictEqual(closed.errors, {});
assert.strictEqual(closed.values.ticket_status, 'CLOSED');

const cancelled = validateRemoteTripFields(cancelledBody(), lists);
assert.deepStrictEqual(cancelled.errors, {}, JSON.stringify(cancelled.errors));
assert.strictEqual(cancelled.values.ticket_status, 'CANCELLED');
assert.strictEqual(cancelled.values.status, 'cancelled');
assert.strictEqual(cancelled.values.truck_number, 'CANCEL');
assert.strictEqual(cancelled.values.material, 'CANCEL');
assert.strictEqual(cancelled.values.gross_weight, 0);
assert.strictEqual(cancelled.values.tare_weight, 0);
assert.strictEqual(
  cancelled.values.timestamp_out,
  cancelled.values.timestamp_in,
  'cancelled tickets use the same tare and gross time',
);

const withPlate = validateRemoteTripFields(
  cancelledBody({ truck_number: 'HR58E3515' }),
  lists,
);
assert.deepStrictEqual(withPlate.errors, {});
assert.strictEqual(withPlate.values.truck_number, 'HR58E3515');

const payload = buildCreatePayload(cancelledBody(), lists);
assert.strictEqual(payload.ticket_status, 'CANCELLED');
assert.strictEqual(payload.status, 'cancelled');
assert.strictEqual(payload.mcg_status, 'skipped');
assert.strictEqual(payload.gross_weight, 0);
assert.strictEqual(payload.material, 'CANCEL');
assert.strictEqual(payload.timestamp_out, payload.timestamp_in);

console.log('remoteTripService cancelled ticket tests passed');
