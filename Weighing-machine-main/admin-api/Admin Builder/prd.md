# Product Requirements — Admin Builder

## Product and user

Admin Builder is a proposed image-editing module inside the existing
Weighbridge Admin Dashboard. Its audience is an authenticated administrator
who reviews CCTV stills and needs narrowly scoped, auditable image operations.
This is not a standalone Streamlit application and the prototype is not
connected to the admin product.

## Goals

1. Make explicitly requested timestamp and illumination edits repeatable.
2. Keep source images immutable and label every result as an edited derivative.
3. Record source identity, requested operations, processing parameters, output
   identity, and review state.
4. Reuse the existing admin experience and infrastructure only after a
   separately approved integration phase.
5. Keep the processing engine modular and independent of web/API code.

## Phase 1 prototype scope

- Validate and decode JPEG and PNG input images with byte and pixel limits.
- Load a versioned camera profile and reject resolution/ROI mismatches.
- Render a requested local timestamp in a bounded, configured ROI.
- Replace old overlay pixels only from an operator-provided, dimension-matched
  clean reference patch; fail clearly if the patch is unavailable.
- Apply deterministic `none`, `auto`, or named lighting presets without
  resizing, sharpening, or synthesizing scene content.
- Export a new image and JSON manifest/QA report in a unique job directory.
- Burn a visible `EDITED DERIVATIVE - NOT ORIGINAL CCTV` banner into every
  exported image so its edited status is not dependent on sidecars.
- Test behavior using generated fixtures, never private production photos.

The prototype has no UI, authentication, API, database, S3 integration,
background job queue, or production history. It is not exposed as a service.

## Later production scope (requires approval)

- Admin-only single-image editing, profile management, job history, review,
  download, and possibly batch processing.
- Server-enforced admin authorization for every profile, job, preview, and
  derivative operation.
- Controlled integration with existing image storage and audit practices.
- A review UI that distinguishes machine checks from human review.

## Out of scope

- Rewriting capture metadata or asserting the edited overlay is the actual
  camera capture time.
- Replacing original images or normal photo/evidence uploads.
- Generative scene reconstruction, object removal, truck changes, plate
  alteration, ground changes, or weather/light-object synthesis.
- Automatic claims that truck, bridge, rod, or other site geometry survived.
- Any public unauthenticated processing service or mandatory paid/cloud AI.

## Acceptance principles

- Source bytes remain unchanged and source/output hashes are recorded.
- Output dimensions match the decoded source dimensions.
- For `lighting=none`, pre-encode pixels outside the authorized timestamp ROI
  remain exactly unchanged.
- Timestamp text is validated and wholly inside its calibrated ROI.
- Unavailable overlay recovery is an explicit error, not a fabricated fill.
- Results with uncalibrated profiles or visual questions remain `NEEDS_REVIEW`.
- Integration does not proceed until the exact external change list and
  authorization design are approved.
