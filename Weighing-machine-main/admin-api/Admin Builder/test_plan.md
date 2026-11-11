# Test Plan and Acceptance Gates

## Isolated prototype tests

- One full-size frame creates a draft camera/view profile with native and
  normalized timestamp ROI coordinates; no reference patch is fabricated.
- Optional 5–10-frame same-camera calibration still produces a draft median
  crop; mismatched dimensions and too few samples fail.
- Strictly parse requested timestamps, including leap dates, invalid calendar
  dates, required seconds, and zero padding.
- Validate camera profile schema, timezone, dimensions, ROI bounds, and
  supported lighting values.
- Accept valid JPEG/PNG input; reject corrupt bytes, unsupported formats,
  size-limit violations, pixel-limit violations, and profile mismatches.
- Verify timestamp is exactly rendered and remains inside the ROI.
- Require a reference patch of exactly ROI dimensions; reject missing,
  malformed, or wrong-size patches.
- Verify `lighting=none` is identity before timestamp compositing.
- Verify deep-night luminance is lower than day on generated fixtures.
- Verify the captured scene dimensions remain unchanged (the separate
  requested-time caption adds output height) and source bytes/hash remain
  unchanged.
- Verify every export has a visible provenance label and sidecars accurately
  identify the edited derivative.
- Verify the routine display-time annotation is appended outside the source
  scene, names the requested time as edited, and never claims capture time.
- Verify the report-slot preview renders the centered 5:3 `object-fit: cover`
  crop without changing the saved full-size scene and warns when the crop
  trims the appended caption.
- Verify output derivative, source/output hashes, manifest, QA report, and
  unique job-directory behavior.
- Verify all outputs remain `NEEDS_REVIEW` when profile calibration or
  mandatory human visual review is incomplete.

## Integration tests (future, after approval)

- Server authorization for missing, expired, valid-admin, and
  authenticated-non-admin tokens on every route.
- Unauthorized image, profile, job, history, preview, and derivative access.
- Input validation, request body limits, timeout, retry, storage failure,
  cleanup, and job state transitions.
- Audit actor identity and immutable source object behavior.
- Existing admin login, reporting, media uploads, and other workflows
  regression tests.
- Role middleware contract: valid JWT with `role === 'admin'` proceeds;
  authenticated non-admin receives 403; missing/invalid JWT receives 401.
  Apply the middleware before every editor route and derivative download.

## Visual review requirements

Inspect source and result at native resolution for exact timestamp placement,
old-overlay recovery artifacts, truck/cabin/wheels/headlights, raised
weighbridge edges, yellow rod, litter, ground texture, and fixed structures.
Automated tests cannot certify these characteristics.

## Real-camera validation status

The workspace contains 36 original CCTV PNGs in `Test-images/`. All show a
timestamp at the upper-left in `DD-MM-YYYY HH:mm:ss` style. Repeated filename
suffixes and visual framing produce candidate viewpoint groups: `ac1` (9),
`ac2` (8), `dc1` (9), `dc2` (9), and `dc` (1). These suffixes are candidate
group labels, not independently verified hardware camera IDs. Repository
naming maps `ac` and `dc` to arrival/departure photo slots, but does not prove
which physical camera produced a frame. Across all 36 frames, dimensions range
from 1616×941 to 1672×973 px and aspect ratios from 1.661 to 1.777; dimensions
vary within the candidate groups.

`ac1` and `dc1` tie for the largest group at nine frames. `ac1` is the best
draft candidate because its upper-left timestamp region and recurring
viewpoint have been examined, but neither its physical camera identity nor
the whole group is verified. All 36 frames show the same date, so a temporal
median retains persistent date glyphs; the nine-frame `ac1` probe visibly
produced a ghosted timestamp/reference. Full-frame dimensions also differ
within the group, so those samples cannot be combined by the existing
calibration path.

A one-frame draft profile named `candidate_ac1_view` was saved from
`3515-ac1.png` (1619×971), with the dragged ROI x=8, y=2, width=366,
height=44. The source-frame hash is recorded. The profile is explicitly a
draft, is not a verified physical camera identity, and does not provide a
clean background reference or authorize in-frame replacement.

One actual frame, `3515-ac1.png` (1619×971), was processed in the local UI at
native scene dimensions with requested local time `2026-10-25T20:40:01`.
Outcome: `ANNOTATED_DISPLAY_TIME`; the original in-frame timestamp remained
visible and the requested time was appended in a separate labeled 50-pixel
caption strip. The derivative was saved and retrieved successfully. The
original PNG bytes and stored upload hash match. The captured scene remains
1619×971; the 50-pixel caption makes the full derivative 1619×1021. The
report-slot preview renders a centered 5:3 crop, removing about 25 pixels
from the top and bottom. It clips the upper-left capture timestamp and about
25 pixels from the bottom half of the appended requested-time caption; the UI
now warns about both risks before export. Review the crop before any report
use.

This is a working safe annotation workflow, not a timestamp replacement
validation. Lighting was applied for the requested night time, but without
same-camera exposure references it is not certified as realistic. The
processed view does not establish preservation of pixels hidden under the
source overlay, nor certify truck, tyre, weighbridge, yellow rod, ground,
litter, or permanent-structure appearance at native resolution. No hidden
pixels were reconstructed. One-frame profiles record candidate view
geometry; reuse requires explicit selection and a framing review, not merely
a matching resolution. A framing/dimension mismatch bypasses the saved ROI
and adds a review warning.

### Report screenshot references

`Test-images/` also contains 17 report-related screenshots: 15 report pages and
2 report-photo selection UI captures. The report pages show up to six photo
slots (three per weighment pass); the reviewed examples include repeated or
similar viewpoints. They help compare recurring framing, but slot labels do
not establish hardware camera identity. The screenshots are not source report
PDFs or native camera photos. Their thumbnail crops cannot be used to generate
a trustworthy timestamp background or camera profile.

The report source code defines 120 CSS-pixel-high photo cells with
`object-fit: cover`, approximately 200×120 CSS px (about 53×32 mm) on the
portrait PDF page. The weighbridge-PC PDF path embeds resized JPEGs at up to
480 px wide and quality 55, preserving aspect ratio; it does not normally
change the original capture file while rendering the report. The Admin API
PDF path embeds the S3 photo bytes without that resize and labels them as
`image/jpeg`, so PNG bytes would be mislabeled. A separate remote-trip sync
path can convert a downloaded non-JPEG photo in place (up to 1920 px wide,
quality 85); verify that path before relying on local-file immutability.
These production observations are read-only; no production files were changed.

## Simplified routine UI checks

- The routine screen exposes upload, the fixed Timestamp + Automatic Lighting
  operation, desired local date/time, processing, comparison, Save, Download,
  report-slot preview, and saved-image history. The server enforces the
  separate annotation plus auto-lighting strategy regardless of legacy
  client-supplied mode fields.
- Camera profile, ROI, and font controls remain in Advanced Settings.
- Drag-selected timestamp coordinates are measured in source-image pixels;
  manual coordinates remain in a nested advanced section.
- A previously selected camera/view profile is remembered in the browser.
  Profiles are never auto-selected based on there being one or on resolution.
  A framing/dimension mismatch bypasses the saved ROI and is flagged for
  review.
- The original image and metadata are untouched. Hashes, manifest, and QA
  report are saved automatically; ordinary image export downloads only the
  derivative.

## Fixture policy

Generate test images procedurally. Do not commit customer CCTV, production
photos, private reference patches, or credentials.

## Local run

From `prototype/`, run `npm test` (23 tests currently pass) or
`npm run ui` to start the loopback-only test interface. Integration suites are
not available until the separately approved production changes exist.
