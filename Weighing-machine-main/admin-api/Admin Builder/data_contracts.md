# Data Contracts

All contracts here describe prototype or proposed integration data; they are
not production database schemas.

## Camera profile

```json
{
  "schema_version": 1,
  "profile_id": "camera_a_demo",
  "profile_version": 1,
  "display_name": "DEMO — UNCALIBRATED",
  "calibrated": false,
  "expected_width": 1280,
  "expected_height": 720,
  "timezone": "Asia/Kolkata",
  "timestamp": {
    "roi": {"x": 8, "y": 8, "width": 300, "height": 32},
    "format": "%Y-%m-%d %H:%M:%S",
    "font_size_px": 19,
    "font_family": "monospace",
    "color_rgb": [235, 235, 235],
    "reference_patch_required": true
  },
  "calibration": {
    "method": "per_pixel_temporal_median",
    "sample_count": 5,
    "sample_sha256": ["..."],
    "reference_patch_sha256": "...",
    "operator_review": "pending"
  },
  "lighting": {
    "presets": {
      "deep_night": {"exposure_ev": -2.1, "gamma": 1.15, "saturation": 0.68},
      "night": {"exposure_ev": -1.5, "gamma": 1.1, "saturation": 0.78},
      "dawn": {"exposure_ev": -0.55, "gamma": 1.0, "saturation": 0.88},
      "day": {"exposure_ev": 0.0, "gamma": 1.0, "saturation": 1.0},
      "dusk": {"exposure_ev": -0.65, "gamma": 1.0, "saturation": 0.9}
    }
  }
}
```

All sample dimensions, ROI, font, and exposure parameters are placeholders.
They are not inferred camera values and do not constitute calibration.

## Job request

```json
{
  "schema_version": 1,
  "job_id": "example-one",
  "profile_id": "camera_a_demo",
  "datetime_local": "2026-10-21T03:15:00",
  "timestamp_enabled": true,
  "lighting_mode": "auto",
  "output_format": "png"
}
```

The requested local datetime has no UTC offset and is displayed as requested;
the profile timezone is recorded. No conversion should silently rewrite the
overlay to UTC. Invalid dates/times and unsupported formats are rejected.

## Result and provenance

Each result includes `job_id`, `status` (`FAILED`, `NEEDS_REVIEW`, or
`QA_PASSED`), `qa_passed`, output paths, completed/pending operations, and
warnings. `QA_PASSED` is not authenticity verification.

`edit_manifest.json` records schema version, `edited_derivative: true`,
source/output SHA-256, dimensions, source/output names, requested local time,
timezone, profile ID/version/calibration state, operation order/parameters,
reference patch hash when used, processing timestamp UTC, QA state, and
warnings. Production integration additionally records server-derived actor
identity, job/site scope, and review event IDs.

`qa_report.json` separates hard machine checks from human review checks.
Unreviewed scene geometry checks must remain `manual_review_required`.
Every output image additionally contains a visible
`EDITED DERIVATIVE - NOT ORIGINAL CCTV` corner label; its compact badge is an
intentional output edit.

## Safe input constraints

- Allow only supported decoded image formats; reject extensions that disagree
  with actual decoding.
- Prototype defaults: 25 MB encoded input and 20 million pixels maximum.
- Reject absolute/traversal filenames and unsafe job IDs.
- Do not accept arbitrary font/patch filesystem paths from a production API;
  resolve authorized storage references server-side.
- Batch CSV is future scope: basename-only filenames, exact matching,
  duplicate detection, and row-level failures.
