# Image and Product Rules

## Precedence

Current explicit job request defines allowed operations. Provenance and source
preservation are mandatory. If requested work cannot be done within scope,
leave the image unchanged for that operation and report the blocker.

## Source and derivative

- Never overwrite, delete, or silently substitute the source image.
- Preserve source capture metadata as source metadata; do not rewrite it to
  match an edited overlay.
- Use a separate derivative filename and manifest stating that the result is
  edited.
- Do not describe an edited frame as authentic raw CCTV or verified evidence.
- Record source and output SHA-256 hashes, actor (in production), job,
  profile/version, operations, processing time, and review status.

## Permitted scope

- Change timestamp pixels only when replacement is requested and the old
  overlay is recoverable through an operator-approved reference patch or
  separately validated mask.
- Apply global lighting only when requested. `none` must be an identity
  transform before final encoding.
- No implicit object, plate, ground, weather, or scene edits.
- No generative image creation, synthetic lights/headlights, sharpening,
  denoising, upscaling, scene beautification, or content reconstruction.

## Preservation constraints

Preserve source framing, dimensions, truck identity, wheels/axles, headlights,
raised weighbridge geometry and sidewalls, yellow rod, ground texture, litter,
garbage, and fixed site structures. These are human visual checks; code must
not claim them passed based only on dimensions or pixel statistics.

## Calibration and uncertainty

Profiles must be camera-specific and versioned. Example coordinates and
lighting values are placeholders, not calibration. Profile mismatch blocks
automatic processing. Unverified font, uncertain patch alignment, or
reconstruction risk requires human review.

## Capability disclosure

The prototype is not a production admin feature. It has no authentication,
storage integration, or scene-aware preservation check. It must not expose a
network service or be used to change production evidence in place.
