# Weighbridge Manager — Product Overview

This document describes what the product does and how operators use it. It is written for site managers, weighbridge staff, and business owners—not for developers.

---

## What is Weighbridge Manager?

**Weighbridge Manager** is a desktop application for industrial weighbridges (truck scales). It runs at the gate or scale house and helps your team:

- Identify trucks automatically when they arrive
- Record empty and loaded weights in a controlled two-step process
- Calculate net cargo weight (loaded minus empty)
- Take a photo of the truck on the bridge
- Print weigh slips for drivers and records
- Keep a searchable history of all weighments
- Send completed tickets to head office when online

The goal is faster, more accurate weighing with less manual typing and fewer mistakes.

---

## Who uses it?

| Role | Typical use |
|------|-------------|
| **Weighbridge operator** | Runs day-to-day weighing on the **Weigh** screen |
| **Supervisor / manager** | Checks **Dashboard**, reviews **Reports**, manages **Vehicles** |
| **IT or admin** | Sets up hardware, backup, cloud sync, and printer in **Settings** |

---

## Main areas of the application

The app has five sections, shown in the side menu:

### 1. Dashboard

Your live control room for today’s operations.

**What you see:**

- How many weighments happened today, how many finished, and total net weight moved (in tonnes)
- How many tickets are still waiting to upload to the cloud
- Whether the RFID reader, scale, camera, and cloud link are working
- A short list of the most recent tickets (slip number, truck, net weight, time, status)
- A simple progress indicator: idle → RFID detected → weighing → complete

**How you use it:** Glance here to confirm the site is running smoothly. You do not start a weighment from the dashboard; that happens on the **Weigh** screen.

---

### 2. Weigh (core weighing screen)

This is where almost all weighing work happens.

**What you see:**

- **Live weight** — large display in kilograms, with an indication when the scale reading is stable enough to trust
- **RFID** — which tag was read and which registered truck it belongs to (owner, transporter)
- **Progress** — step-by-step log of what already happened on this ticket (scan, tare, gross, photo, print, sync)
- **Photo** — image captured at the bridge (empty pass and/or loaded pass)
- **Transaction details** — slip number, truck, times, gross, tare, and **net weight**
- **Print slip** — button to print once the ticket is ready
- **Abort / cancel** — stop a wrong or stuck weighment, or cancel an open ticket that will not be completed

**How weighing works — the two-pass flow**

Most sites use a **two-pass** process: the same truck is weighed twice—once empty, once loaded.

#### Pass 1 — Empty truck (tare)

1. Truck drives onto the bridge **empty** (or with only fixed equipment).
2. Driver or gate staff triggers identification — normally by **scanning the truck’s RFID tag**.
3. The system recognizes the vehicle (or asks the operator to enter the truck number if the tag is unknown).
4. A **new slip (ticket)** is opened for that truck.
5. When the scale shows a **stable** weight above the minimum threshold, the system **locks in the tare (empty) weight**.
6. A **photo** is taken (if the camera is set up).
7. The ticket stays **open**. The truck leaves to be loaded.

The screen will remind you: *load the truck and scan RFID again when it returns loaded.*

#### Pass 2 — Loaded truck (gross)

1. The same truck returns **loaded** and drives onto the bridge.
2. **Same RFID tag** is scanned again.
3. The system finds the **open ticket** for that truck and continues it (does not start a duplicate).
4. When weight is **stable**, the system records **gross (loaded) weight** and time out.
5. Another **photo** is captured for the loaded pass.
6. **Net weight** is calculated automatically: gross minus tare.
7. The ticket is marked **complete**, a **slip is printed**, and the record is **queued for cloud sync**.

#### If RFID is not recognized

- The operator can **type the truck number** and continue.
- If that truck is not in the vehicle list, the app can **create a basic vehicle record** on the spot and then proceed.

#### If something goes wrong

- **Abort transaction** — cancels the current weighment in progress.
- **Cancel open ticket** — closes a pass-1 ticket that will never get a loaded weighment.
- Weighments that take too long without a stable weight can time out; the operator can start again after the system resets.

---

### 3. Vehicles

A master list of trucks (and similar vehicles) that use your weighbridge.

**What you can store for each vehicle:**

- Vehicle / truck number
- RFID tag (one tag per vehicle; duplicates are not allowed)
- Owner name
- Transporter name
- Vehicle type (truck, tanker, or container)
- Maximum capacity (optional, in kg)
- Active or inactive status

**What you can do:**

- **Add** new vehicles
- **Edit** details
- **Search** by number or owner
- **Deactivate** vehicles you no longer use (they can be reactivated later)
- **Show inactive** vehicles in the list when needed

**Why it matters:** When RFID is scanned, the weigh screen instantly shows truck number, owner, and transporter. Unknown tags are flagged so staff can fix registration before weighing continues.

---

### 4. Reports

Historical view and exports for accounts, audit, and management.

**What you can do:**

- Choose a **date range** (from / to)
- Filter by **ticket status** (pending, weighing, captured, printed, synced, etc.)
- Filter by **cloud sync status** (synced, pending, retry, failed)
- See **summary totals**: number of tickets, total gross, tare, and net weight (also shown in tonnes)
- **Browse** all matching tickets in a table with slip number, truck, weights, in/out times, status, and whether a photo exists
- **Expand a row** for more detail (owner, transporter, thumbnail image)
- **Export** the filtered list to spreadsheet (CSV) or PDF
- **Reprint** a slip for any completed ticket
- **Retry sync** for tickets that failed to upload to the cloud

Reports refresh when you change filters or press **Refresh**.

---

### 5. Settings

Configuration and housekeeping for the site.

**Hardware**

- Connect and test the **RFID reader**, **weighbridge scale**, and **camera**
- Optional **simulator mode** for training or testing without real devices (simulated RFID, weight slider, test photo)

**Cloud sync**

- Set where completed tickets are sent (your organisation’s cloud address and access)
- Choose how often automatic sync runs
- Run **manual sync now** and see how many tickets are still pending

**Application**

- Turn **automatic database backup** on or off and choose how often backups run
- Run **backup now** and see recent backup files
- **Image cleanup** — automatically delete old photos after a number of days, or run cleanup manually
- See how much disk space photos are using

**Printer**

- Choose default printer and paper size (standard A4 or narrow thermal roll)
- **Print test slip** using the latest transaction
- If thermal printing failed earlier, a **thermal print queue** lets you **resend** those slips

---

## Weigh slip (what gets printed)

Each completed weighment can produce a slip that typically includes:

- Company name and site details (as configured)
- Slip number
- Truck number and RFID (if used)
- Gross, tare, and **net** weight
- Time in and time out
- Owner and transporter (from the vehicle record)
- Operator name

Slips can be printed automatically when a loaded pass finishes, or again later from **Weigh** or **Reports**.

---

## Device status (always visible)

Along the side of the app, small indicators show whether these are connected:

- **RFID** — tag reader
- **Scale** — live weight on the bridge
- **Camera** — for vehicle photos
- **Cloud** — sync to central systems

The **Dashboard** also shows a fuller device panel with last activity time and pending sync count.

---

## Ticket lifecycle (in simple terms)

| Stage | Meaning for staff |
|-------|-------------------|
| **Pending** | Ticket opened; waiting for weights |
| **Weighing** | Actively on the bridge or between pass 1 and pass 2 |
| **Captured** | Gross and tare recorded; photo done |
| **Printed** | Slip generated/sent to printer |
| **Synced** | Successfully sent to cloud |
| **Error** | Cancelled, timed out, or failed — may need supervisor action |

---

## Cloud sync — what it does for the business

After a ticket is complete and printed, it is placed in a **sync queue**. The app sends it to your central server on a schedule you set, or when you press **Manual sync now**.

- Supervisors see **pending sync** counts on the dashboard
- Failed uploads can be **retried** from Reports
- Operations can continue on site even if the internet drops; tickets queue until the link returns

---

## Backup and data safety

- **Automatic backups** copy your weighment database on a schedule you choose
- **Manual backup** before maintenance or end of day
- **Photos** are stored locally; old images can be removed automatically to save disk space
- Vehicle and transaction history remain in the database for reporting

---

## Typical day at the weighbridge

1. Operator opens the app and checks **Dashboard** — devices green, no unusual pending sync backlog.
2. Empty truck arrives → **Weigh** screen → RFID scan → stable tare → photo → truck leaves with **open ticket**.
3. Loaded truck returns → same RFID → stable gross → photo → net weight shown → slip prints → ticket syncs.
4. Supervisor runs **Reports** at shift end for totals and exports to accounts.
5. Admin checks **Settings** periodically: backups, storage, printer queue, cloud failures.

---

## Summary

| Feature | What it does |
|---------|----------------|
| **Automatic truck ID** | RFID links to your vehicle register |
| **Two-pass weighing** | Tare (empty) then gross (loaded) on one slip |
| **Net weight** | Calculated for you; no manual subtraction |
| **Photos** | Proof of truck on scale at tare and/or gross |
| **Weigh slips** | Print for driver and office; reprint anytime |
| **Vehicle register** | Search, add, edit, deactivate trucks |
| **Live dashboard** | Today’s counts, device health, recent tickets |
| **Reports & export** | Date filters, CSV/PDF, summaries |
| **Cloud upload** | Sends completed tickets to head office |
| **Backup & cleanup** | Protect data and manage photo storage |

**Weighbridge Manager** ties together identification, weighing, imaging, printing, and reporting so your site can run a consistent, auditable weighbridge operation from one screen.

---

*Document version: product overview for Weighbridge Manager. For setup and installation, refer to your site’s deployment guide.*
