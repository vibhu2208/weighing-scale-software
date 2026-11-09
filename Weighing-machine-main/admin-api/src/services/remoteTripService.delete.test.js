'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteRemoteTrip } = require('./remoteTripService');

function mockQuery(row) {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM remote_trips WHERE id/.test(sql)) {
      return { rows: row ? [row] : [] };
    }
    if (/DELETE FROM remote_trips WHERE id/.test(sql)) {
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/DELETE FROM transactions_mirror/.test(sql)) {
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  return { queryFn, calls };
}

test('delete removes pending trip and reports not synced', async () => {
  const row = {
    id: 'rt-1',
    slip_number: 'WB8105',
    synced_to_local: false,
  };
  const { queryFn, calls } = mockQuery(row);
  const out = await deleteRemoteTrip(queryFn, 'rt-1', { siteId: 'WB-03' });
  assert.deepEqual(out, { slip_number: 'WB8105', wasSynced: false });
  assert.ok(calls.some((c) => /DELETE FROM remote_trips WHERE id/.test(c.sql)));
  assert.ok(calls.some((c) => /DELETE FROM transactions_mirror/.test(c.sql)));
  const mirrorCall = calls.find((c) => /DELETE FROM transactions_mirror/.test(c.sql));
  assert.equal(mirrorCall.params[0], 'WB-03');
  assert.equal(mirrorCall.params[1], 'WB8105');
});

test('delete removes synced trip and reports wasSynced', async () => {
  const row = {
    id: 'rt-2',
    slip_number: 'WB8106',
    synced_to_local: true,
  };
  const { queryFn } = mockQuery(row);
  const out = await deleteRemoteTrip(queryFn, 'rt-2', { siteId: 'WB-03' });
  assert.deepEqual(out, { slip_number: 'WB8106', wasSynced: true });
});

test('delete rejects missing trip', async () => {
  const { queryFn } = mockQuery(null);
  await assert.rejects(() => deleteRemoteTrip(queryFn, 'missing', { siteId: 'WB-03' }), /not found/i);
});
