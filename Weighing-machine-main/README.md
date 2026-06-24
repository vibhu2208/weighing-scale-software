# Weighbridge Manager

Professional industrial Weighbridge Management System.

**Stack:** Electron · React 18 + Vite · Node.js (main process) · SQLite via `better-sqlite3` · Tailwind CSS · Zustand.

This repository currently contains **Phase 1 — Project Setup & Folder Structure**: a runnable shell with logging, IPC scaffolding, database connection, file storage, and a Tailwind-styled React UI. Hardware adapters, the transaction engine, real DB schema, and full screens land in subsequent phases.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Run in development (Vite + Electron)
npm run dev
```

`npm run dev` boots Vite on `http://localhost:5173`, waits for it, then launches Electron pointed at the dev server. DevTools open automatically.

### Other scripts

| Script              | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `npm run dev`       | Concurrent Vite + Electron dev session.                        |
| `npm run build`     | Production build (Vite → `dist/renderer`, then electron-builder → `release/`). |
| `npm run reset-db`  | Drops & re-seeds the SQLite DB. Requires `APP_ENV=development`. |
| `npm run rebuild`   | Rebuild native modules (`better-sqlite3`) for current Electron. |

## Folder layout

```text
weighbridge-app/
├── electron/        # main + preload + IPC registrars
├── backend/         # database, adapters, services, engine, utils
├── frontend/        # Vite + React (pages, components, hooks, store, api)
├── scripts/         # build.js, reset-db.js
├── database/        # SQLite files (gitignored)
├── uploads/         # captured images (gitignored)
├── backups/         # DB backups (gitignored)
├── logs/            # winston logs (gitignored)
├── electron-builder.config.js
├── tailwind.config.js / postcss.config.js
├── .env.example     # copy to .env
└── package.json
```

## Environment

Copy `.env.example` to `.env` and adjust as needed. If `.env` is missing the app falls back to defaults and logs a warning (it does not crash).

## Logging

Winston writes to:

- `logs/app.log` — all levels, JSON, rotated at 5 MB.
- `logs/error.log` — errors only.
- `logs/device.log` — entries tagged with `meta.type === 'device'`.

Use `logger.device('rfid', 'tag scanned', { tagId })` to push into `device.log`.

## What works in Phase 1

- `npm run dev` launches Electron loading the React shell with zero console errors.
- `window.electronAPI` is exposed via `contextBridge` (verify in DevTools).
- `logs/app.log` is written by Winston on first run.
- `uploads/`, `backups/`, `logs/`, `database/` directories are auto-created.
- `db.js` opens SQLite (WAL + foreign keys) at `database/weighbridge.db`.
- All constants and timestamp utilities are importable from `backend/utils/*`.

Hardware adapters, the transaction state machine, DB schema, real screens, reports, printing, and cloud sync are intentionally out-of-scope for this phase.
