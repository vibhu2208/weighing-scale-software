# Admin Module UX — Proposed

This describes a future module only; no React UI is implemented in the
prototype. The module should appear within the existing authenticated
Weighbridge Admin layout, share its visual conventions, and avoid a second
login or independent dashboard.

## Navigation and pages

- **Single Image Editor:** select an eligible source image, camera profile,
  requested local timestamp, and allowed lighting mode.
- **Camera Profiles:** list and validate versioned camera-specific settings;
  uncalibrated profiles remain visibly marked.
- **Review:** matched original/result previews, exact requested overlay text,
  changes/warnings, machine QA checks, and explicit human review.
- **History:** access-controlled jobs and derivative downloads.
- **Batch Editor:** later phase, after single-job lifecycle and storage
  controls are approved and proven.

## Interaction requirements

- Clearly distinguish original, preview, and saved `EDITED` derivative.
- Show source dimensions, camera profile/version, timestamp ROI, requested
  operations, and any missing reference patch before processing.
- Disable timestamp replacement until the profile matches image dimensions,
  the timestamp fits its ROI, and a valid reference patch is provided.
- Display processing progress and actionable validation errors.
- Present approximate lighting and recovery uncertainty without implying
  physical reconstruction.
- Require explicit human review before download; machine checks alone cannot
  pass visual scene-preservation checks.
- Keep a derivative label and provenance access visible near every export.

## Existing-app conventions to inspect during integration

Review existing `admin-web/src/components/Layout.jsx`, API client,
notifications, form patterns, responsive CSS, and page conventions before
choosing components. No UI styling or route changes are authorized in the
prototype phase.

## Accessibility

Use labeled controls, keyboard-operable inputs, non-color-only status cues,
clear focus states, readable contrast, and responsive layouts consistent with
the admin application.
