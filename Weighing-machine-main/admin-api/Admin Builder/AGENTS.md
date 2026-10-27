# Admin Builder Contributor Instructions

- Keep documentation and prototype changes within this `Admin Builder`
  directory unless the user explicitly approves a later integration change.
- Do not modify the existing admin app, API, reports, weighing workflows,
  original media, or environment files during prototype work.
- Treat this as a proposed admin-native module, not a standalone Streamlit app.
- The prototype must remain a library and test suite, not a network service.
- Preserve original image bytes; label every output as an edited derivative and
  record source/output hashes. Keep the visible `EDITED DERIVATIVE - NOT
  ORIGINAL CCTV` banner in every export.
- Never claim a changed timestamp is the verified camera capture time.
- Do not guess hidden pixels, reconstruct scenes, add/remove objects, or claim
  geometry was preserved without human review.
- Read `rules.md`, `image_pipeline.md`, `security_and_provenance.md`, and
  `test_plan.md` before changing image-processing behavior.
- Do not proceed to integration or modify files outside this directory without
  an explicit approval after presenting the exact change list.
