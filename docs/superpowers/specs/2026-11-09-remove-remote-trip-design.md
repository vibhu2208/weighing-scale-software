# Remove remote trip (with 2-step confirm)

## Goal

Operators can permanently remove a remote trip that is Synced, Pending, or Waiting. Synced trips also queue a PC delete so the local weighbridge ticket is removed. Accidental clicks are blocked with an inline two-step confirm.

## Scope

- **In:** Delete API; shared Remove button on Created trips / PC sync table, Remote Trips list, and Bulk Photo Upload trip list.
- **Out:** Soft-delete / archive; bulk remove-all; deleting S3 photos/PDFs (orphaned media may remain).

## Behavior

### Confirm UX

1. First click: button label becomes `Confirm remove?` (destructive styling).
2. Second click within ~5 seconds: call delete API.
3. If the timeout elapses without a second click, the button resets to `Remove`.
4. While the request runs: disabled, label `Removing…`.
5. On success: parent list reloads / row disappears.
6. On error: show the page/table error message.

### Delete semantics

| Sync state | Cloud `remote_trips` | `transactions_mirror` | PC local ticket |
|------------|----------------------|-----------------------|-----------------|
| Pending / Waiting | Delete | Delete matching slip row if present | No command |
| Synced | Delete | Delete matching slip row if present | Enqueue `delete_report` for the slip |

## API

`DELETE /remote-trips/:id` (auth required)

1. Load remote trip by id → 404 if missing.
2. Note `wasSynced = Boolean(row.synced_to_local)` and `slip_number`.
3. `DELETE FROM remote_trips WHERE id = $1`.
4. `DELETE FROM transactions_mirror WHERE site_id = $site AND UPPER(slip_number) = UPPER($slip)`.
5. If `wasSynced`, `createCommand({ type: 'delete_report', payload: { slipNumber }, createdBy })`.
6. Return `{ ok: true, deleted: true, slip_number, localDeleteQueued: wasSynced }`.

Service: `deleteRemoteTrip(queryFn, id, { createdBy, createCommand })` in `remoteTripService.js` (or thin wrapper that calls command service from the route). Prefer keeping DB deletes in the service and command creation in the route to avoid circular deps, matching `reports.js` delete pattern.

## Client

- `api.deleteRemoteTrip(id)` → `DELETE /remote-trips/:id`.
- Shared component `RemoveRemoteTripButton` with props `{ tripId, slipNumber, onDone, disabled }`.
- Wire into:
  - `CreatedTripsSync.jsx`
  - `RemoteTrips.jsx` (trips table)
  - `BulkPhotoUpload.jsx` (trip rows)

## Data flow

```
Operator: Remove → Confirm remove?
  → DELETE /remote-trips/:id
  → delete remote_trips (+ mirror)
  → if was synced: admin_commands delete_report
  → PC CloudAdminSync applies delete_report (local ticket + mirror cleanup)
  → UI reloads list
```

## Error handling

| Case | Response |
|------|----------|
| Unknown id | 404 |
| DB failure | 500; UI shows error |
| Command insert fails after row deleted | 500 with clear message (trip already gone; operator can retry report delete if needed) |

Prefer deleting cloud row first so a stuck Pending trip is always removable even if command enqueue fails for Synced (document that local ticket may remain until report delete is used).

## Testing

- Service/route tests: pending delete removes row and does not create command; synced delete removes row and creates `delete_report`; missing id → 404.
- Manual: two-step confirm timeout; remove Pending; remove Synced and verify command appears on Sync Status.
