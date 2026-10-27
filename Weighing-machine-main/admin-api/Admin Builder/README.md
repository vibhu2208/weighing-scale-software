# Admin Builder

Admin Builder is an **admin-only CCTV still editor** for the Weighbridge
admin dashboard. An administrator uploads one JPEG/PNG frame, chooses a
requested local date/time, and gets a **separate labeled copy**. Original
CCTV files, report photos, and evidence objects are never overwritten.

This branch (`admin-builder`) contains the processor, the dashboard page, and
the API routes. It is **not merged to `main`**. Treat every output as an
unapproved test derivative, not a replacement for a report image.

## What it does

Routine processing:

1. Validates the upload (JPEG/PNG, size and pixel limits).
2. Leaves the original in-frame camera timestamp untouched.
3. Appends a clearly labeled **requested display time** strip below the scene.
4. Applies a conservative, time-derived lighting grade (`auto`).
5. Burns `EDITED DERIVATIVE - NOT ORIGINAL CCTV` onto the copy.
6. Records source/output SHA-256 hashes plus a JSON manifest and QA report.

It does **not** reconstruct hidden pixels, replace the camera timestamp,
remove trucks/people/plates, or claim the requested time is the capture time.

## How the pieces fit together

```text
admin-web  /admin-builder page
    │  JWT + POST JSON
    ▼
admin-api  /admin-builder/*  (authMiddleware + requireAdmin)
    │  createBuilderWorkspace()
    ▼
Admin Builder/prototype/src/server.js   workspace (previews, save, list)
    │  processJob()
    ▼
Admin Builder/prototype/src/index.js    sharp transforms
```

Local edited copies are stored under `admin-api/admin-builder-data/`
(gitignored). They are not written to S3 or the reports table.

| Path | Role |
| --- | --- |
| `admin-web/src/pages/AdminBuilder.jsx` | Dashboard UI |
| `admin-web/src/api/client.js` | Authenticated client calls |
| `admin-web/src/lib/reportSlot.js` | 5:3 report-cell crop preview helper |
| `admin-api/src/routes/adminBuilder.js` | Express routes |
| `admin-api/src/auth.js` | `requireAdmin` role gate |
| `prototype/src/index.js` | Image processor |
| `prototype/src/server.js` | Local workspace used by the API and the loopback test UI |
| `config/` | Processor defaults and a sample camera profile |
| `examples/` | Sample job JSON / CSV (not production data) |

## Run it locally

Requirements: **Node.js 20.9+** (`sharp@0.35.5`), npm, and a configured
admin API database. Login must be an `admin` role user.

Terminal 1 — API:

```sh
cd Weighing-machine-main/admin-api
cp .env.example .env   # if you do not already have .env
npm install
npm run dev            # http://localhost:3001
```

Terminal 2 — dashboard:

```sh
cd Weighing-machine-main/admin-web
npm install
npm run dev            # http://localhost:5173
```

1. Open `http://localhost:5173` and log in as an administrator.
2. Open **Admin Builder** in the sidebar (`/admin-builder`).
3. Upload a JPEG/PNG CCTV frame, set date/time (Asia/Kolkata), then **Process**.
4. Compare the labeled copy. **Save** stores it under `admin-builder-data/`.

A non-admin token receives `403 ADMIN_ROLE_REQUIRED`. Missing/invalid JWT
receives `401`.

### Isolated processor (no dashboard)

Use this to change image logic without running the full admin stack:

```sh
cd "Weighing-machine-main/admin-api/Admin Builder/prototype"
npm install
npm test
npm run ui             # loopback only: http://127.0.0.1:4178
```

The prototype UI binds to `127.0.0.1` only. Do not tunnel or deploy it.

## Tests a new developer should run

```sh
# Processor + synthetic fixtures (no private CCTV required)
cd "Weighing-machine-main/admin-api/Admin Builder/prototype"
npm test

# Report-slot crop helper used by the dashboard page
cd Weighing-machine-main/admin-web
npm test
```

Tests that need real CCTV files live under gitignored `Test-images/` and
are **skipped** when those files are absent. Optional local gate scripts:

- `prototype/scripts/run-real-image-gates.mjs`
- `prototype/scripts/measure-quality-sprint.mjs`
- `prototype/scripts/reproduce-3748-failure.mjs`

Do not commit private camera frames, credentials, or processed outputs.

## API surface (all require JWT + admin role)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin-builder/profiles` | List saved camera/view profiles |
| `POST` | `/admin-builder/process` | Process one image (`sourceDataUrl`, `datetimeLocal`) |
| `POST` | `/admin-builder/previews/:id/save` | Persist a processed preview |
| `GET` | `/admin-builder/saved` | List saved derivatives |
| `GET` | `/admin-builder/saved/:id/image` | Download a derivative |
| `POST` | `/admin-builder/saved/delete` | Delete selected derivatives |

Vite proxies `/admin-builder` to the API in development
(`admin-web/vite.config.js`).

## Safety rules (do not relax these)

- Never overwrite source bytes or capture metadata.
- Every export must stay visibly labeled `EDITED DERIVATIVE - NOT ORIGINAL CCTV`.
- A requested overlay time is **not** verified capture time.
- Do not inpaint, generate, or invent missing scene content.
- Do not alter trucks, plates, people, weighbridge geometry, or weather.
- `lighting=none` is an identity transform before encoding; presets are
  approximations, not a reconstruction of another hour.
- Frontend route checks are not authorization. Keep `requireAdmin` on every
  Admin Builder endpoint.
- Keep original evidence / S3 report photos read-only.

## What is intentionally not in git

These stay on the developer machine only (see `.gitignore`):

- `Test-images/` — private CCTV samples
- `research/` — local investigation screenshots
- `prototype/local-data/` and `admin-api/admin-builder-data/` — run output
- `prototype/node_modules/`

## Deeper specs

Older files still describe the isolated-prototype phase. Prefer this README
for current wiring; use the specs for processing rules and future work.

| File | Contents |
| --- | --- |
| `prd.md` | Product goals and non-goals |
| `architecture.md` | Module boundaries and runtime notes |
| `design.md`, `flow.md` | UX and processing lifecycle |
| `rules.md`, `image_pipeline.md`, `security_and_provenance.md` | Image, access, and audit rules |
| `api_contracts.md`, `data_contracts.md` | Provisional contracts |
| `implementation_plan.md` | Phases and remaining production gates |
| `integration_review.md` | File-by-file integration notes (some now implemented on this branch) |
| `test_plan.md`, `ACCEPTANCE_TESTS.md` | Acceptance coverage |
| `ONE_FRAME_DESIGN.md` | One-frame camera/view profile design |
| `prototype/README.md` | Processor API details |
| `AGENTS.md`, `.cursor/rules/admin-builder.mdc` | Contributor / agent rules |

## Production status

This branch is a working admin-dashboard integration for **local testing**.
It is not approved to replace report images. Remaining production gates
include: Node 20.9+ on the API host, dedicated derivative storage (not
local disk), retention policy, and visual review of lighting realism.
See `implementation_plan.md`.
