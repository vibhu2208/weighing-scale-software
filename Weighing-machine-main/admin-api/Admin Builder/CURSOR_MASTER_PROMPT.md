# Admin Builder — Admin-Integrated Project Instructions

## Mission

Develop Admin Builder as a future module inside the existing Weighbridge Admin
Dashboard. The initial authorized work is an isolated and testable processing
prototype in this directory only. Do not build a standalone Streamlit product.

## Hard scope boundary

Until the user separately approves integration after reviewing the exact
outside-folder change list:

- Modify files only under `admin-api/Admin Builder`.
- Do not change `admin-web`, existing API source, report generation, weighing
  calculations, regular photo uploads, database records, production images,
  or environment files.
- Do not expose the processor as a network service.

## Architecture facts and caveats

The inspected UI is React/Vite and the API is Node/Express. Existing admin
routes use JWT authentication, but inspected `authMiddleware` does not enforce
the administrator role. Frontend route protection is not enough. Before
integration, verify all relevant repository/deployment/storage conventions and
design a server-side role and resource authorization gate.

The preferred direction is a reusable, UI-independent Node package orchestrated
by the existing API if later approved. This remains a recommendation subject
to deployment, performance, and visual validation. Keep Python worker options
documented as alternatives if real algorithmic needs justify them.

## Image integrity

Never overwrite source bytes or change capture metadata. Every result is a
separately named edited derivative with source/output SHA-256, explicit
operations, parameters, timestamps of processing, and review state. The
requested overlay time is not proof of actual capture time.

Do not generate/rebuild the scene or change truck, weighbridge, rod, litter,
ground, headlights, plates, people, or vehicles in the prototype. Timestamp
replacement requires a verified, dimension-matched reference patch for the
ROI. Fail safely without one; do not paint over the timestamp or claim hidden
pixels were recovered.

Lighting is an approximate deterministic pixel transform, not a physical
reconstruction. Preserve dimensions and prohibit sharpening/upscaling.
Machine checks cannot certify scene geometry; leave human visual review
pending.

## Development and validation

1. Read `README.md`, `architecture.md`, `implementation_plan.md`,
   `rules.md`, `image_pipeline.md`, `data_contracts.md`,
   `security_and_provenance.md`, and `test_plan.md`.
2. Implement only the current approved phase.
3. Use synthetic fixtures; never commit private CCTV or credentials.
4. Run the targeted tests and report exact results.
5. Before integration, present exact external files to change, rationale,
   risks, authorization design, and regression plan. Wait for explicit
   approval before editing them.
