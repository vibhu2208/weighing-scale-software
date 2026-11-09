# Remove Remote Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators permanently remove remote trips (Synced/Pending/Waiting) with an inline 2-step confirm; Synced also queues PC `delete_report`.

**Architecture:** `deleteRemoteTrip` in remoteTripService deletes cloud + mirror and returns `{ wasSynced, slip_number }`. Route enqueues `delete_report` when synced. Shared `RemoveRemoteTripButton` wired into all three trip lists.

**Tech Stack:** Node/Express admin-api, React admin-web, `node:test`.

## Global Constraints

- Inline 2-step confirm (~5s), not `window.confirm`.
- Pending/Waiting: cloud only. Synced: cloud + `delete_report`.
- Button on CreatedTripsSync, RemoteTrips, BulkPhotoUpload.
- Do not delete S3 media in this change.

## File map

| File | Role |
|------|------|
| `admin-api/src/services/remoteTripService.js` | `deleteRemoteTrip` |
| `admin-api/src/services/remoteTripService.delete.test.js` | Tests |
| `admin-api/src/routes/remoteTrips.js` | `DELETE /:id` |
| `admin-web/src/api/client.js` | `deleteRemoteTrip` |
| `admin-web/src/components/RemoveRemoteTripButton.jsx` | 2-step UI |
| `CreatedTripsSync.jsx` / `RemoteTrips.jsx` / `BulkPhotoUpload.jsx` | Wire button |

---

### Task 1: Service + tests

**Files:**
- Create: `Weighing-machine-main/admin-api/src/services/remoteTripService.delete.test.js`
- Modify: `Weighing-machine-main/admin-api/src/services/remoteTripService.js`

**Interfaces:**
- Produces: `async function deleteRemoteTrip(queryFn, id, { siteId } = {}) → { slip_number, wasSynced }`

- [ ] **Step 1: Failing test** covering missing / pending / synced delete SQL + return shape
- [ ] **Step 2: Implement `deleteRemoteTrip`** (load, delete remote, delete mirror, return flags)
- [ ] **Step 3: Tests pass; commit**

---

### Task 2: Route + client + button component

**Files:**
- Modify: `remoteTrips.js`, `client.js`
- Create: `RemoveRemoteTripButton.jsx`

- [ ] **Step 1:** `DELETE /:id` — delete then optional `createCommand({ type: 'delete_report', ... })`
- [ ] **Step 2:** `api.deleteRemoteTrip(id)`
- [ ] **Step 3:** `RemoveRemoteTripButton` with confirm timeout + `onDone` / `onError`
- [ ] **Step 4: Commit**

---

### Task 3: Wire into three UIs

- [ ] CreatedTripsSync, RemoteTrips (new Actions/Remove column or under Sync), BulkPhotoUpload
- [ ] Commit
- [ ] Run `npm test` in admin-api
