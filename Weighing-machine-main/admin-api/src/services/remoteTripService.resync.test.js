'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resyncRemoteTrip } = require('./remoteTripService');

function mockQuery(row) {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM remote_trips WHERE id/.test(sql)) {
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE remote_trips[\s\S]*SET/.test(sql)) {
      return {
        rows: [
          {
            ...row,
            synced_to_local: false,
            synced_at: null,
            local_id: null,
          },
        ],
      };
    }
    if (/pg_notify/.test(sql)) return { rows: [{ pg_notify: '' }] };
    throw new Error(`unexpected sql: ${sql}`);
  };
  return { queryFn, calls };
}

test('resync clears sync flags and notifies', async () => {
  const row = {
    id: 'rt-1',
    slip_number: 'WB8105',
    synced_to_local: true,
    synced_at: '2026-11-07T10:00:00.000Z',
    local_id: 42,
    release_at: null,
  };
  const { queryFn, calls } = mockQuery(row);
  const out = await resyncRemoteTrip(queryFn, 'rt-1');
  assert.equal(out.synced_to_local, false);
  assert.equal(out.synced_at, null);
  assert.equal(out.local_id, null);
  assert.ok(calls.some((c) => /pg_notify/.test(c.sql)));
});

test('resync rejects missing trip', async () => {
  const { queryFn } = mockQuery(null);
  await assert.rejects(() => resyncRemoteTrip(queryFn, 'missing'), /not found/i);
});

test('resync rejects unsynced trip', async () => {
  const { queryFn } = mockQuery({
    id: 'rt-2',
    synced_to_local: false,
    release_at: null,
  });
  await assert.rejects(() => resyncRemoteTrip(queryFn, 'rt-2'), /not synced/i);
});

test('resync rejects waiting trip', async () => {
  const { queryFn } = mockQuery({
    id: 'rt-3',
    synced_to_local: true,
    release_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await assert.rejects(() => resyncRemoteTrip(queryFn, 'rt-3'), /waiting/i);
});
