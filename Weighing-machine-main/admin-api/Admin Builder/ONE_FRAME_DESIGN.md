# One-frame-first design and flow

## Problem to solve

Current prototype refuses the fixed `Timestamp + Automatic Lighting` routine job unless a 5–10-frame temporal-median patch has been approved. This creates a costly collection task for every camera angle and lighting state; it still fails when date digits stay the same or frames are cropped/scaled differently.

## Revised routine UI (one form)

**Upload image → Requested local date/time → Process → Side-by-side review → Save/Download**.

No mode/lighting dropdown in normal operation. A collapsed **Camera Setup** panel is available the first time a view is encountered:

1. Upload **one actual full-size frame** (or select the current uploaded frame).
2. Drag an ROI over the visible timestamp. Show zoomed pixels and a confirm button.
3. Pick a matching draft profile from existing candidate views or create a new named profile.
4. Store ROI as both pixel coordinates and normalized geometry with source dimensions and an approved reference screenshot. Match profiles by verified camera/view identity and geometry, **never resolution alone**.
5. Show timestamp typography/position and safe report-crop preview.
6. Save profile as `draft` then require visual signoff for `reviewed` status.

Additional reference frames can be attached later to improve background recovery, but absence must not block lighting processing and verified display-time annotation.

## Processing strategy

```
SOURCE IMMUTABLE → image validation / camera-profile match
                  → choose timestamp strategy
                    A. explicit display-time annotation (safe default)
                    B. simulated in-frame rendering on a labeled derivative (requires manual QA)
                    C. clean-reference replacement (only if verified source exists)
                  → automatic lighting based on requested local time
                  → conservative CCTV texture, no enhancement
                  → native-resolution scene review & report-slot crop preview
                  → temporary result → explicit Save / Download
                  → auditable output with visible edited/simulated identification
```

### Timestamp strategies

- **A (always available):** do not erase historical capture time. Write `Requested display time (edited)` in a visually differentiated border or caption. Preserve original image's timestamp and metadata. The normal UI remains a single Process button; clearly report which strategy was used.
- **B (optional simulation):** mask only known timestamp glyph pixels in an explicitly identified *simulation* copy, perform localized inpainting as an approximation, render new overlay with camera-like typography, and always show a nonremovable small `EDITED / SIMULATED` identifier. Approval must check old digit ghosts and damaged background. Do not use for authentic weighing evidence.
- **C (verified replacement):** if a genuine clean ROI image has been obtained from the same locked camera at matching geometry, inspect registration and use it. Do not extrapolate unseen scene details or auto-approve.

### Automatic time-based lighting

- Derive local time from requested date/time and camera timezone (commonly Asia/Kolkata; verify per profile).
- Use bounded, conservative exposure/gamma/color transforms. No invented headlight state, sources of illumination, weather, structures, wheels, garbage, or ramp geometry.
- Avoid using average luminance alone to assert 3 AM realism. Compare to a genuine corresponding exposure when available; provide manual visual review where not.
- Preserve original noise/compression/softness and image framing. No HDR, denoising, sharpening, upscaling, or unnecessary reconstruction.

## Report compatibility

The supplied Copilot investigation claims 200×120 CSS px report slots with `object-fit: cover`. The local screenshots visually corroborate a six-photo layout but **cannot prove native image resolution**.

- Keep the edited derivative at original dimensions for internal comparison and provenance.
- Offer a **report preview** showing the exact 5:3 slot crop, so loss of important ramp/truck/timestamp edges is visible.
- Do not arbitrarily force all originals to 480×288. The reported PDF path already downscales to <=480 px wide. If a separate report copy is necessary, create it from the reviewed derivative using the application's verified encoding behavior and preserve aspect ratio.
- JPEG conversion must match the MIME type. Do not change the existing report generator without separately authorized production integration.

## Camera slots and sample sufficiency

- The screenshot UI shows arrival Camera 1/2/3 and departure Camera 1/2/3, six **report slots**. Treat them as slots, not as proof of six physical cameras.
- One representative original per distinct fixed viewpoint is sufficient to draft a profile. Do **not** require night/day images for each view just to configure timestamp placement.
- If the input is resized or reframed, flag it for review instead of silently transforming coordinates.

## Data/storage

- Source: immutable, preserve bytes/hash/capture timestamp.
- Temporary preview: short-lived.
- Saved output: new unique derivative ID/path, not overwrite original/report-media keys.
- Manifest: source/output hashes, source capture time if known, requested time, chosen strategy, camera/view profile version, auto-lighting preset, reviewer and review status.
- Visible provenance should survive a copied image being separated from its manifest.

## Out of scope for this milestone

- New framework, microservice, paid API, database schema change.
- Production React, Express, S3, weighing/report code changes.
- Automatic person/vehicle removal, scene reconstruction, fabricated plate dirt, or evidence substitution.
