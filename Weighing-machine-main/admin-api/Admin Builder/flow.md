# Processing Flow

## Single-image lifecycle (proposed)

1. Authenticated admin selects or uploads an eligible source through an
   approved, access-controlled path.
2. Server validates actor authorization, size/type/decode limits, source
   identity, requested operations, and camera profile.
3. Server creates a unique job record and records the authenticated actor.
4. Processor receives immutable source bytes plus validated job/profile data.
5. Routine processing keeps the original in-frame timestamp and appends the
   requested display time as a clearly labeled annotation outside the captured
   scene. It never claims hidden-pixel recovery.
6. Optional in-frame simulation requires a supplied reference patch and stays
   in a review-required state; it is not presented as authentic recovery.
7. Apply bounded, time-derived lighting before creating the derivative.
8. Processor creates a derivative, hard-check report, and provenance manifest.
9. Server stores the derivative separately from the source and updates job
   state.
10. Admin compares output and source, reviews warnings, and downloads only via
   an authorized endpoint.
11. Audit records retain source/output identities and the review decision.

## State transitions

`QUEUED -> VALIDATING -> PROCESSING -> NEEDS_REVIEW | FAILED`

After an explicit reviewer decision, `NEEDS_REVIEW -> APPROVED | REJECTED`.
Download is permitted only for an authorized user and a stored derivative.
No stage may change the original object or source capture metadata.

## Failure handling

| Condition | Required result |
| --- | --- |
| Unauthorized or non-admin actor | Deny before reading or returning image content |
| Corrupt, unsupported, or oversized image | Reject with a specific validation error |
| Profile/image dimensions or framing mismatch | Do not reuse its ROI; annotate safely and flag camera-view review |
| Invalid timestamp or text outside ROI | Reject before writing an output |
| Missing/unverified clean patch | Stop timestamp replacement; no flat-fill fallback |
| Processing exception or timeout | Mark job failed; clean up only its own temporary output |
| Storage write failure | Keep source untouched; do not return a success-shaped response |
| QA uncertainty | Mark `NEEDS_REVIEW`; do not claim visual verification |
| Unauthorized derivative/history request | Deny access server-side, not only in the UI |

## Prototype lifecycle

The isolated local prototype validates uploaded input, processes buffers,
writes temporary previews and explicit saved derivatives to local storage,
verifies that the source hash is unchanged, and emits `edit_manifest.json`
plus `qa_report.json`. Its loopback test UI is unauthenticated and is not a
production web service; it has no S3/database access or queue.
