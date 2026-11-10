# Resync Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Resync button on Synced rows in `CreatedTripsSync` that clears PC sync flags so the weighbridge can re-import the trip.

**Architecture:** New `resyncRemoteTrip(queryFn, id)` in `remoteTripService.js` clears `synced_to_local` / `synced_at` / `local_id` and `pg_notify`s the PC. Exposed as `POST /remote-trips/:id/resync`, called from a Resync button next to the Synced badge.

**Tech Stack:** Node/Express admin-api, React admin-web, `node:test` for API service tests.

## Global Constraints

- Resync button only in `CreatedTripsSync` (not Remote Trips list / Bulk Photo Upload).
- Button only when sync state is Synced (not Waiting / Pending).
- Full reset: `synced_to_local = false`, `synced_at = NULL`, `local_id = NULL`.
- No confirmation dialog.
- Match existing photo re-queue notify pattern.

## File map

| File | Role |
|------|------|
| `admin-api/src/services/remoteTripService.js` | `resyncRemoteTrip` service |
| `admin-api/src/services/remoteTripService.resync.test.js` | Service tests with mock `queryFn` |
| `admin-api/src/routes/remoteTrips.js` | `POST /:id/resync` route |
| `admin-web/src/api/client.js` | `resyncRemoteTrip(id)` client method |
| `admin-web/src/components/CreatedTripsSync.jsx` | Resync button UI |

---

### Task 1: `resyncRemoteTrip` service + tests

**Files:**
- Create: `Weighing-machine-main/admin-api/src/services/remoteTripService.resync.test.js`
- Modify: `Weighing-machine-main/admin-api/src/services/remoteTripService.js` (add function + export)

**Interfaces:**
- Consumes: `getRemoteTrip`, `isHeldUntilOutTime` (same file)
- Produces: `async function resyncRemoteTrip(queryFn, id) → trip row`

- [ ] **Step 1: Write the failing test**

Create `remoteTripService.resync.test.js`:

```js
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
    if (/UPDATE remote_trips SET/.test(sql)) {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Weighing-machine-main/admin-api && node --test src/services/remoteTripService.resync.test.js`

Expected: FAIL (`resyncRemoteTrip` not exported / not a function)

- [ ] **Step 3: Implement `resyncRemoteTrip`**

Add after `attachPhotos` in `remoteTripService.js`:

```js
async function resyncRemoteTrip(queryFn, id) {
  const row = await getRemoteTrip(queryFn, id);
  if (!row) {
    const err = new Error('Remote trip not found');
    err.status = 404;
    throw err;
  }
  if (!row.synced_to_local) {
    const err = new Error('Trip is not synced');
    err.status = 400;
    throw err;
  }
  if (isHeldUntilOutTime(row)) {
    const err = new Error('Trip is waiting until close time');
    err.status = 400;
    throw err;
  }

  const res = await queryFn(
    `UPDATE remote_trips
     SET synced_to_local = false,
         synced_at = NULL,
         local_id = NULL
     WHERE id = $1
     RETURNING *`,
    [id],
  );
  const trip = res.rows[0];
  if (!trip) {
    const err = new Error('Remote trip not found');
    err.status = 404;
    throw err;
  }

  try {
    await queryFn(`SELECT pg_notify('new_remote_trip', $1)`, [String(trip.id)]);
  } catch (err) {
    console.warn('[remoteTrip] resync notify failed', err.message);
  }
  return trip;
}
```

Export `resyncRemoteTrip` from `module.exports`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd Weighing-machine-main/admin-api && node --test src/services/remoteTripService.resync.test.js`

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add Weighing-machine-main/admin-api/src/services/remoteTripService.js \
  Weighing-machine-main/admin-api/src/services/remoteTripService.resync.test.js
git commit -m "Add resyncRemoteTrip to clear PC sync flags."
```

---

### Task 2: API route

**Files:**
- Modify: `Weighing-machine-main/admin-api/src/routes/remoteTrips.js`

**Interfaces:**
- Consumes: `resyncRemoteTrip(query, id)`
- Produces: `POST /remote-trips/:id/resync` → `{ ok, trip }` or error

- [ ] **Step 1: Wire the route**

Import `resyncRemoteTrip`. Add before `module.exports`:

```js
router.post('/:id/resync', async (req, res) => {
  try {
    const trip = await resyncRemoteTrip(query, req.params.id);
    return res.json({ ok: true, trip: await attachTripMedia(trip) });
  } catch (err) {
    const status = err.status || ( /not found/i.test(err.message) ? 404 : 400 );
    return res.status(status).json({ ok: false, error: err.message });
  }
});
```

- [ ] **Step 2: Smoke-check require loads**

Run: `cd Weighing-machine-main/admin-api && node -e "require('./src/routes/remoteTrips'); console.log('ok')"`

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add Weighing-machine-main/admin-api/src/routes/remoteTrips.js
git commit -m "Expose POST /remote-trips/:id/resync."
```

---

### Task 3: Admin web client + Resync button

**Files:**
- Modify: `Weighing-machine-main/admin-web/src/api/client.js`
- Modify: `Weighing-machine-main/admin-web/src/components/CreatedTripsSync.jsx`

**Interfaces:**
- Consumes: `POST /remote-trips/:id/resync`
- Produces: `api.resyncRemoteTrip(id)`; Resync button on Synced rows

- [ ] **Step 1: Add client method**

Next to `attachRemoteTripPhotos`:

```js
resyncRemoteTrip(id) {
  return request(`/remote-trips/${encodeURIComponent(id)}/resync`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
},
```

- [ ] **Step 2: Add Resync button in `CreatedTripsSync`**

- Track `resyncId` state (busy row id).
- In Sync column, when `state.label === 'Synced'`, render:

```jsx
<button
  type="button"
  className="mt-1 text-amber-400 hover:underline text-xs disabled:opacity-50"
  disabled={Boolean(resyncId)}
  onClick={async () => {
    setResyncId(row.id);
    setError('');
    try {
      await api.resyncRemoteTrip(row.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setResyncId('');
    }
  }}
>
  {resyncId === row.id ? 'Resync…' : 'Resync'}
</button>
```

- [ ] **Step 3: Manual check**

Open `/plan-gaps/fill`, find a Synced row, click Resync → badge becomes Pending.

- [ ] **Step 4: Commit**

```bash
git add Weighing-machine-main/admin-web/src/api/client.js \
  Weighing-machine-main/admin-web/src/components/CreatedTripsSync.jsx
git commit -m "Add Resync button on Synced trips in PC sync table."
```
