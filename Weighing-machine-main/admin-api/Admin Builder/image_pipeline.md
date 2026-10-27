# Image Pipeline

## Limitations

A single image does not contain the scene pixels hidden by timestamp glyphs.
No automatic method can guarantee recovery of those pixels. Routine jobs keep
the original timestamp and add a labeled simulated-time badge in a report-safe
corner that does not cover that timestamp. Advanced Camera Setup records a timestamp ROI and framing from
one full-size frame as an unreviewed draft; it does not create a background
reference. Optional multi-frame temporal-median output remains a simulation
candidate and requires visual review.

Lighting transforms are deterministic approximations of pixel values, not
reconstruction of real conditions, shadows, weather, or sensor behavior.

## Input and coordinate conventions

- Decode JPEG or PNG through `sharp` with strict encoded-byte and decoded-pixel
  limits.
- Use RGB byte arrays internally and retain original width/height.
- ROI coordinates are integer source pixels, zero-origin, with width/height
  extents `[x, x + width)` and `[y, y + height)`.
- Reject an ROI outside image bounds; never rescale an input to fit a profile.
- Preserve original file bytes and hash independently of decoded pixels.

## Processing stages

1. Validate file signature/decoder, dimensions, limits, profile, requested
   time, ROI, and output format.
2. Read original bytes once and compute SHA-256.
3. For routine jobs, retain the original scene and camera-timestamp pixels.
   Place a labeled simulated-time badge inside the report-safe area and clear
   of the detected camera timestamp. Do not conceal or inpaint the glyphs.
4. For optional in-frame simulation, validate and hash the reference patch;
    require its dimensions to equal the timestamp ROI exactly.
5. Apply requested lighting as one linear-light midtone gain. Near-black
   pixels and already-bright surfaces are held. Do not stack gamma, contrast,
   channel gain, and a mean-chasing exposure. `none` is an identity transform.
6. For diagnostic in-frame simulation only, composite the supplied patch into
    the ROI and render the timestamp. This does not recover authentic hidden
    pixels.
7. The simulated badge displays the requested local time with the explicit
   lines `SIMULATED`, `EDITED DERIVATIVE`, and `NOT ORIGINAL CCTV`. It is not
   a camera OSD and does not replace the capture timestamp.
8. Encode one output at the source width and height into a unique derivative
   path. Do not resize or upscale the captured scene.
9. Re-read/verify output dimensions and source hash; write manifest and QA
   report.
10. Leave visual review state pending; machine checks cannot establish scene
    geometry or authenticity.

## Prototype restrictions

- No automated OCR, glyph-mask estimation, inpainting, patch registration,
  protected-region segmentation, or visual similarity score.
- The local test UI lets an operator drag-select ROI on one source frame and
  stores both native and normalized geometry. Saved view profiles are reused
  only after explicit selection; framing mismatches bypass ROI reuse.
- The 5–10 frame method remains optional. It does not generate a separate
  patch per target timestamp and cannot establish authenticity.
- Temporal-median recovery assumes static camera/background and changing
  glyph pixels. It may retain persistent glyph strokes or remove real
  structures/objects if they remain in the ROI across samples. Operator visual
  inspection is mandatory; one real annotation derivative has been inspected,
  but timestamp replacement and camera-wide lighting realism remain untested.
- Lighting curves are illustrative and require camera calibration.
- The requested display overlay time is explicitly recorded as modified
  display text, not capture time. The source file and its metadata remain
  unchanged; the newly rendered derivative does not copy source metadata.
- JPEG output is lossy; exact equality outside the ROI is assessed on the
  pre-encode working pixels outside the timestamp ROI and compact watermark
  badge where applicable, not by comparing compressed JPEG files.
- The simulated badge is an identifiable in-frame label. It does not cover
  the camera timestamp. A passing hash or machine gate does not approve
  visual quality; `qa_status` stays `NEEDS_REVIEW`.

## Future algorithm acceptance

Any added mask or recovery algorithm requires synthetic and camera-approved
visual tests, hard dimension/bounds checks, and human review. Large or
structural occlusions must not be auto-approved.
