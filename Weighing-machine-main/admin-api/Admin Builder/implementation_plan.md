# Phased Implementation Plan

## Phase 0 — Repository review and specification

- Verify admin UI routes/navigation, Express route patterns, JWT claims and
  authorization, image storage, deployment/runtime, dependency conventions,
  database/history needs, and tests.
- Record verified facts, assumptions, blockers, architecture options, and
  exact prospective external changes.
- Consolidate documentation under `Admin Builder`.
- Do not change production code or files outside this directory.

## Phase 1 — Isolated processing prototype

**Status: one-frame draft setup and safe display-time annotation implemented;
in-frame timestamp replacement and scene/lighting accuracy remain unverified.**

- Build a reusable Node.js image-processing package under `prototype/`.
- Validate images, profiles, exact timestamps, ROI bounds, and reference patch.
- Support conservative time-derived lighting and a clearly labeled requested
  display-time annotation that leaves the original timestamp untouched.
- Add a loopback-only, beginner-friendly upload, compare, preview, and export
  interface with advanced settings separated from routine editing.
- Permanently mark every output image `EDITED DERIVATIVE - NOT ORIGINAL CCTV`
  and include hashes, manifest, QA report, and explicit errors.
- Add one-frame draft camera/view setup with native and normalized ROI
  coordinates; keep 5–10-frame temporal-median calibration optional and
  require visual review before using any in-frame simulation.
- Generate synthetic fixtures and test dimensions, bounds, transforms,
  immutability, and sidecar integrity.
- No admin UI/API/database/S3 access, production authentication, or integration.

### Phase 1 validation results (2026-10-25)

- 22 automated tests pass, including one-frame profile creation, frame dimension
  validation, timestamp formatting/bounds, `none` identity outside the visible
  watermark, appended annotation pixel preservation, lighting monotonicity,
  original-byte immutability, sidecars, and explicit camera-view matching.
- npm audit reports no known vulnerabilities for the prototype dependency tree.
- 36 real CCTV samples are present in `Test-images/`, with repeated candidate
  viewpoints grouped by filename suffix and visual framing.
- `3515-ac1.png` was processed, previewed and saved as an
  `ANNOTATED_DISPLAY_TIME` derivative. Its original capture-time overlay was
  preserved, and the requested time was appended outside the scene. The
  5:3 report preview crops about 25 pixels from top and bottom and exposes
  upper-left timestamp clipping risk.
- The one-frame flow creates an unreviewed draft ROI profile. No profile is
  trusted for timestamp replacement. Real-camera lighting plausibility and
  preservation of truck/site details remain subject to native-resolution
  review; no hidden pixels were reconstructed.
- The routine UI presents one edited-image download; manifests, QA, and hashes
  are stored automatically in the local run directory rather than downloaded
  as separate files.
- Test outputs carry a compact visible `EDITED DERIVATIVE - NOT ORIGINAL CCTV`
  label; source bytes and source metadata remain untouched.

## Phase 2 — Integration review and approval gate (prepared, not approved)

- Finalize the list of exact `admin-web` and `admin-api` files that would
  change, with reason, risk, compatibility, and test plan for each.
- Verify deployment/runtime and any persistent job/audit requirements.
- Resolve server-side admin role checks and authorized image download design.
- Present findings and request explicit user approval before editing anything
  outside `Admin Builder`.

Current findings and proposed file-by-file changes are in
`integration_review.md`. Production Render Node version remains unverified;
the current API manifest allows Node 18, while the patched prototype `sharp`
requires Node 20.9 or later.

## Phase 3 — Admin integration (not authorized yet)

- Add a protected dashboard route and navigation entry using existing UI
  conventions.
- Add server-side role-gated API endpoints for bounded single-image upload,
  profile setup, preview, and derivative download.
- Keep original evidence storage unchanged; use separate derivative keys and
  access-controlled downloads. Record hashes and review metadata alongside
  the derivative.
- Process synchronously with strict image limits initially; no queue, schema
  migration, or microservice is proposed for the first release.

## Phase 4 — Batch and operations (separate approval)

- Add exact filename mapping, row-level validation, isolated failures,
  bounded concurrency/queueing, manifests, and package downloads.
- Measure memory, latency, and rate limits under representative workloads.

## Phase 5 — Advanced edits (separate requirements and review)

- Evaluate manual masks/reference-assisted edits for content alterations.
- Require protected geometry masks and explicit human review; never claim
  reliable object removal without evidence.

## Current boundary

Only work inside `Admin Builder` is authorized. Phase 1 prototype and initial
Phase 2 review are complete to the extent possible without real camera samples
or deployment access. Production modifications and integration are deferred
until the user approves the exact external file list.
