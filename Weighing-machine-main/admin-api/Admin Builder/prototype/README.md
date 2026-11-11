# Isolated Image-Processing Prototype

This package is the Admin Builder processor. The admin dashboard loads it
through `admin-api/src/routes/adminBuilder.js`. You can still run it alone
for tests and the loopback UI. See the parent `README.md` for the full
developer setup.

It exports a `processJob` function and has an optional loopback-only local
test interface. The loopback UI is not an admin-authenticated application
and must not be deployed.

## Setup and tests

Requirements: Node.js 20.9 or later (required by the current patched `sharp`
release).

```sh
npm install
npm test
npm run ui
```

The test UI listens on `http://127.0.0.1:4178` by default. Use
`npm run ui -- --port 4179` to select a different port. It binds only to
127.0.0.1, rejects non-local Host/Origin requests, and must not be exposed via
a proxy, tunnel, or public interface. Runtime profiles/results are stored in
the ignored `local-data/` folder. Tests generate synthetic fixtures in
memory. Do not commit production images, credentials, or private camera
samples.

## Processing API

```js
import { processJob } from './src/index.js';

const result = await processJob({
  sourcePath: '/path/to/source.png',
  outputRoot: './runs',
  profile: cameraProfile,
  job: {
    job_id: 'example-one',
    profile_id: 'camera_a_demo',
    datetime_local: '2026-10-21T03:15:00',
    timestamp_enabled: false,
    timestamp_strategy: 'display_annotation',
    lighting_mode: 'auto',
    output_format: 'png'
  }
});
```

The routine `/api/process` operation applies automatic lighting and appends a
clearly labeled requested-time strip outside the captured frame. It preserves
the original in-frame timestamp and does not require calibration. A one-frame
camera/view profile stores the timestamp ROI for identification and diagnostics
only; it cannot reveal pixels hidden by that timestamp. The older
`timestamp_enabled: true` path still accepts a dimension-matched reference
patch but is recorded as `SIMULATED_INFRAME_REVIEW` for current profiles.
Only a profile explicitly marked `verified_clean_reference` and reviewed by
an operator can produce the `VERIFIED_REFERENCE` state; the local UI does not
create such a profile.

The output is created under a new job directory, named `EDITED_<job-id>.<ext>`,
with `edit_manifest.json` and `qa_report.json`. Source and output hashes are
recorded automatically. Routine UI downloads only the image; these sidecars
stay in local storage. Routine jobs return `ANNOTATED_DISPLAY_TIME`; the
requested time is visibly labeled `REQUESTED DISPLAY TIME` beneath the
unchanged scene frame, together with `EDITED DERIVATIVE - NOT ORIGINAL CCTV`.
The appended band increases output height but does not resize or cover scene
pixels. The prototype cannot assess whether scene geometry was visually
preserved.

The routine UI and local processing route enforce Timestamp + Automatic
Lighting; legacy mode flags sent by a client are ignored. Processing does not
require a camera profile. A saved profile is applied only after explicit
camera/view selection; a dimension/framing mismatch disables ROI reuse and
adds a review warning.

## Reusable per-camera calibration

The test UI creates a draft profile from one full-size frame. The operator
drags over the timestamp; native and normalized ROI coordinates, source
dimensions/hash, expected framing, view ID, and timezone are stored. Profiles
are not inferred from resolution or silently auto-selected. A 5–10-frame
same-view median reference remains optional under Advanced Calibration.

This is only a candidate workflow: the median assumes a fixed camera and
stable background while timestamp glyphs vary between samples. Moving trucks,
persistent objects under digits, compression changes, or misaligned framing
can contaminate the patch. Inspect the generated crop and at least one
watermarked processed image; do not mark the profile calibrated or infer
hidden scene content automatically.

The available CCTV samples form candidate viewpoint groups but do not verify
hardware camera identity. A real `3515-ac1.png` sample was processed with
`ANNOTATED_DISPLAY_TIME`; its original timestamp remains in the captured
scene, the requested time is in the appended caption strip, and the report
preview shows the centered crop and warns that it trims the upper-left camera
timestamp and part of the appended time caption. This does not validate
timestamp replacement or lighting realism. All samples still show the same
date, and the earlier `ac1` median probe retained timestamp ghosts.

## Prototype limitations

- The test UI is local-only and unauthenticated; it is not an admin UI or
  production HTTP service. No S3/database access or queue.
- No OCR, patch registration, automatic inpainting, object removal, or visual
  geometry verification.
- In the legacy in-frame simulation path, an absent/invalid reference patch
  is an error, never a flat-color fallback.
- Lighting is an approximate profile-based transform, not a reconstruction
  of the real scene at another time.
- EXIF orientations other than 1 are rejected rather than silently rotated.
- Output encoding does not copy source metadata. The original uploaded file,
  including its original capture metadata, is never modified. A requested
  display timestamp is recorded as a modified overlay in the manifest and is
  explicitly not represented as verified capture time.
