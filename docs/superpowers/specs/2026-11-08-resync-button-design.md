# Resync button for Created trips PC sync table

## Goal

Let operators force a remote trip that is marked **Synced** back to **Pending** so the weighbridge PC can re-import it. Primary case: slips like WB8105 that show Synced with “time not recorded” and are not actually on the PC.

## Scope

- **In:** “Created trips and PC sync” table (`CreatedTripsSync`), used on Fill Blocked Slips (`/plan-gaps/fill`) and Remote Trips Import.
- **Out:** Remote Trips list page, Bulk Photo Upload, bulk resync-all.

## Behavior

### UI

- Show a **Resync** button only when the row’s sync state is **Synced** (not Waiting, not Pending).
- Place it under or beside the Synced badge in the Sync column.
- While the request is in flight for that row: disable the button and show `Resync…`.
- On success: reload the table (or update the row) so the badge becomes **Pending** and synced-at shows `—`.
- On failure: set the existing table-level error message.

### API

`POST /remote-trips/:id/resync` (auth required)

1. Load the remote trip by id; 404 if missing.
2. If not currently `synced_to_local`, return 400 (`Trip is not synced`).
3. If held until out time (`release_at` in the future / Waiting), return 400 (`Trip is waiting until close time`).
4. Update:

   ```sql
   SET synced_to_local = false,
       synced_at = NULL,
       local_id = NULL
   ```

5. `pg_notify('new_remote_trip', id)` so the PC can pick it up promptly (same pattern as photo re-queue).
6. Return `{ ok: true, trip }`.

Service function lives next to `attachPhotos` in `remoteTripService.js` and is exported for the route.

### Client

- Add `api.resyncRemoteTrip(id)` in `admin-web/src/api/client.js`.
- Wire the button in `CreatedTripsSync.jsx` only.

## Data flow

```
Operator clicks Resync
  → POST /remote-trips/:id/resync
  → clear sync flags on remote_trips
  → pg_notify new_remote_trip
  → UI refreshes → Pending
  → weighbridge RemoteTripSync imports on next cycle / notify
```

## Error handling

| Case | Response |
|------|----------|
| Unknown id | 404 |
| Already pending / waiting | 400 with clear message |
| DB / notify failure | 500; UI shows error text |

No confirmation dialog (one-click; action is reversible by a later successful PC sync).

## Testing

- Unit/service: resync clears flags; rejects unsynced and waiting trips.
- Manual: on Fill Blocked Slips, click Resync on a Synced row → badge becomes Pending; after PC sync it returns to Synced with a recorded time when available.
