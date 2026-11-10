'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelRemoteTrip } = require('./remoteTripService');

function mockQuery(row, { mirrorFail = false } = {}) {
  const calls = [];
  let current = row ? { ...row } : null;
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM remote_trips WHERE id/.test(sql)) {
      return { rows: current ? [current] : [] };
    }
    if (/UPDATE remote_trips[\s\S]*SET/.test(sql)) {
      current = {
        ...current,
        ticket_status: 'CANCELLED',
        status: 'cancelled',
        material: 'CANCEL',
        customer_name: 'CANCEL',
        destination: 'CANCEL',
        operator_name: 'CANCEL',
        gross_weight: 0,
        tare_weight: 0,
        timestamp_out: current.timestamp_in,
        mcg_status: 'skipped',
      };
      return { rows: [current] };
    }
    if (/DELETE FROM transactions_mirror/.test(sql) || /INSERT INTO transactions_mirror/.test(sql)) {
      if (mirrorFail) throw new Error('mirror failed');
      return { rows: [{ slip_number: current?.slip_number }] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  return { queryFn, calls, getCurrent: () => current };
}

test('cancel sets CANCEL fields and zero weights', async () => {
  const row = {
    id: 'rt-1',
    slip_number: 'WB8105',
    truck_number: 'HR38X3951',
    vehicle_type: 'HYWA',
    ticket_status: 'CLOSED',
    material: 'RDF',
    customer_name: 'MCG',
    destination: 'PALI',
    operator_name: 'MANISH',
    gross_weight: 46550,
    tare_weight: 15000,
    timestamp_in: '2026-11-07T10:00:00.000Z',
    timestamp_out: '2026-11-07T12:00:00.000Z',
    synced_to_local: true,
  };
  const { queryFn } = mockQuery(row);
  const out = await cancelRemoteTrip(queryFn, 'rt-1', { siteId: 'WB-03' });
  assert.equal(out.trip.ticket_status, 'CANCELLED');
  assert.equal(out.trip.material, 'CANCEL');
  assert.equal(out.trip.customer_name, 'CANCEL');
  assert.equal(out.trip.destination, 'CANCEL');
  assert.equal(out.trip.operator_name, 'CANCEL');
  assert.equal(out.trip.gross_weight, 0);
  assert.equal(out.trip.tare_weight, 0);
  assert.equal(out.trip.timestamp_out, out.trip.timestamp_in);
  assert.equal(out.trip.truck_number, 'HR38X3951');
  assert.equal(out.wasSynced, true);
  assert.equal(out.slip_number, 'WB8105');
});

test('cancel rejects missing trip', async () => {
  const { queryFn } = mockQuery(null);
  await assert.rejects(() => cancelRemoteTrip(queryFn, 'missing', { siteId: 'WB-03' }), /not found/i);
});

test('cancel rejects already cancelled trip', async () => {
  const { queryFn } = mockQuery({
    id: 'rt-2',
    slip_number: 'WB8106',
    ticket_status: 'CANCELLED',
    synced_to_local: false,
  });
  await assert.rejects(() => cancelRemoteTrip(queryFn, 'rt-2', { siteId: 'WB-03' }), /already cancelled/i);
});
