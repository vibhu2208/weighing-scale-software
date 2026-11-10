# Cancel remote trip

## Goal

From Remote Trips, cancel an existing trip the same way Fill Blocked Slips does: CANCEL labels, 0 kg, same tare/gross time, `CANCELLED` status. If already on the PC, push the same change there.

## Behavior

- **Cancel** button per row (hidden when already `CANCELLED`)
- Two-step confirm: `Cancel` → `Confirm cancel?` (5s)
- Cloud update: material/customer/destination/operator = `CANCEL`; gross/tare = `0`; `timestamp_out = timestamp_in`; `ticket_status = CANCELLED`; keep plate if set else `CANCEL`
- Mirror upsert
- If synced (or has `local_id`): `edit_report` with `cancel: true` so PC applies cancel fields

## API

`POST /remote-trips/:id/cancel` → `{ ok, trip, localEditQueued }`
