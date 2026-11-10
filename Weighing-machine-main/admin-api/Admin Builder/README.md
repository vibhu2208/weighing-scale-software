# Admin Builder

Admin Builder is an **admin-only CCTV still editor** for the Weighbridge
admin dashboard. An administrator uploads one JPEG/PNG frame, chooses a
requested local date/time, and gets a **separate labeled copy**. Original
CCTV files, report photos, and evidence objects are never overwritten.

This branch (`admin-builder`) contains the processor, the dashboard page, and
the API routes. It is **not merged to `main`**. Treat every output as an
unapproved test derivative, not a replacement for a report image.

## What it does

Admin Builder is a **synthetic training-image generator**. Give it a CCTV frame
and a requested local date/time; it returns a separate copy where:

1. The in-frame camera timestamp (`DD-MM-YYYY HH:MM:SS`) is detected, erased
   from the surrounding pixels, and redrawn in the camera's own font, size and
   position (`prototype/src/osd.js`, glyphs in `src/osd-atlas.json` harvested
   from real stamps).
2. The scene is relit for that time of day: exposure toward a time target,
   filmic highlight roll-off, dawn/dusk warmth, cool desaturated night, bloom
   around lamps already in the frame (`prototype/src/relight.js`).
3. Optional operator-placed lamp glows (headlights) are added at night.
4. Nothing is drawn on the picture to mark it. Provenance lives in the saved
   `edit_manifest.json` / `qa_report.json` (`synthetic_training_derivative:
   true`, hashes, parameters), an EXIF description and the `EDITED_` filename.

Original files are never overwritten. Limits: it cannot invent missing
content (no daylight detail in a pitch-black frame, no headlights on a truck
that has none unless you place them), and frames whose stamp it cannot find
fail with `OSD_NOT_FOUND`. `timestampStrategy: "display_annotation"` still
selects the older labeled-strip mode.

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

## Lighting calibration

`prototype/src/relight.js` follows a fixed winter schedule set by the operator:
**fully dark 18:30-05:30, daylit otherwise**, with 30-minute ramps on the day
side (18:00-18:30 and 05:30-06:00). Late afternoon dims and warms within "day".
Change `KEYFRAMES` when the season changes.

It is calibrated on the operator's reference frames. **These are not all camera
originals:** the same trucks and scenes appear in `Documents/K1-images` and
`Downloads` under different stamps, so at least one copy of each is an edit, and
nothing here can tell which. Treat the numbers as "matches the references", not
"matches the camera". To re-measure:

```sh
node scripts/measure-frames.mjs frames.json <frame-dir> [<frame-dir> ...]
node scripts/validate-relight.mjs frames.json [contact-sheet-dir]
node scripts/fit-pairs.mjs <day.png>:<night.png> [...]   # same-scene pairs
node scripts/validate-matrix.mjs frames.json 40          # many frames x many clock times
```

`validate-matrix.mjs` is the broad check: it relights frames to 13 clock times
(including both ramps) and counts outputs outside the 5th-95th percentile of the
reference frames of that class. About 10% fall outside by construction; more means
a defect. Run it after any lighting change, and view contact sheets as well, because
statistics passed while pictures were still wrong (see below).

**Is the source day or night?** This decides everything, and the mean alone gets it
wrong: floodlit night frames reach a mean of 52, while dim afternoon frames sit at
25-50. `sourceNightness()` uses the darkest tenth of the frame (p10) and the mean:
night p10 is 0-13 and day p10 is 17+ across the references, labelled by each frame's
own stamp time. By that label it misclassifies 3 of 125 (a 16:11 and a 16:44 frame
that really are dusk-dark, and one 11:59 frame that is dark). The old rule got 9
wrong and left floodlit night frames about 80% "day", so they received almost no
conversion.

| | Mean | p10 | p50 | p90 | p99 |
| --- | --- | --- | --- | --- | --- |
| Reference night (72) | 25 | 2 | 20 | 52 | 87 |
| Day to night, 22:00 | 21 | 5 | 19 | 39 | 62 |
| Reference day (39) | 99 | 44 | 94 | 156 | 216 |
| Night to day, 12:00 | 101 | 51 | 102 | 146 | 199 |

- **Day to night** uses a tone curve fitted from same-scene day/night pairs
  (`NIGHT_TONE`), not a gamma. Those pairs show no colour tint, so none is added.
  It also applies a measured light falloff (`NIGHT_FALLOFF`) and darkens open
  sky, which the tone curve alone leaves grey.
- **Night to day, background:** a floodlit night frame lights the foreground and
  leaves trees, walls and the far ground nearly black. A plain brightness lift
  reveals only noise there, so the lift path (`LIFT` in `relight.js`) denoises, takes
  hue from a wide blur where the source is near-black, adds tinted skylight, and puts
  detail back with a noise floor. Tune it with `scripts/tune-lift.mjs` against the
  reference day frames; it does not need frame files named in the code. In one sweep,
  raising saturation did nothing until the fill tint was exposed, because the fill
  was adding neutral grey on top of the colour. Result against 40 day references:
  mean 101 vs 99, darkest tenth 44 vs 44, saturation 23.7 vs 25.3, red/blue 1.11 vs
  1.14. Sharpness is 14 vs 25, so it still looks softer and slightly over-processed.
- **Night to day** takes down the bloom halo around lit lamps without hollowing the
  lens out, divides out the falloff, flattens the slowly varying light
  and adds ambient skylight. Denoising makes it about half as sharp as a real day
  frame (Laplacian 12.5 against 23.6). It cannot recover daylight shadows, and
  lit lamps stay lit with reduced glare.
- **Not possible by grading:** turning headlights on or off automatically,
  moving shadows, or rendering a real sky. Lamps are only added where placed.
- Single-channel maps must go through `singleChannel()`: `sharp` otherwise returns
  3 channels and per-pixel indexing silently reads the wrong place.

## Hardening notes

- Stamp detection searches the top-left for the `DD-MM-YYYY HH:MM:SS` layout
  and scores every character against the camera glyphs, in either polarity: the
  frames carry white text with a black outline, dim grey text, or black text.
  Measured on 148 reference frames and 165 non-stamp images
  (`scripts/stamp-roc.mjs`): at `MIN_STAMP_SCORE` 0.40, 146 frames and no
  non-stamp images are accepted. The margin is thin: the best non-stamp image
  scores 0.37, and the cutoff was chosen on these same images. A rejected frame
  fails with `OSD_NOT_FOUND`.
- The output keeps the source stamp's style, except that black text switches to
  light when the relit background is too dark to read it.
- Jobs run through a limiter (`ADMIN_BUILDER_MAX_CONCURRENT`, default 1, queue
  of 6); extra requests get `SERVER_BUSY`. A typical 1.6 MP frame takes ~0.9 s; a 17 MP frame was last measured before the current stamp search at ~5 s / ~600 MB.
- Pending previews expire after an hour and are capped at 100 in memory.
- One damaged saved manifest no longer breaks the saved-images list.
- Lamp positions are sanitised (max 12, finite numbers, bounded radius).
- Known gap outside this folder: `requireAdmin` trusts the JWT role claim
  and the route maps `SERVER_BUSY` to HTTP 400 instead of 503.

## Safety rules (do not relax these)

- Never overwrite source bytes or capture metadata.
- Outputs are synthetic: keep `synthetic_training_derivative` in the manifest and never use them as evidence or report photos.
- The redrawn timestamp is **not** a capture time.
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
