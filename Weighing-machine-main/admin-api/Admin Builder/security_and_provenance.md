# Security, Privacy, and Provenance

## Prototype boundary

The prototype includes a local Node library and optional test UI bound only to
127.0.0.1. The UI has no admin authentication, S3 access, database access, or
network listener on non-loopback interfaces. Do not expose it through a proxy,
tunnel, port-forward, or public interface. It is not a production substitute
for access controls.

Every export contains a visible `EDITED DERIVATIVE - NOT ORIGINAL CCTV`
corner label, an `EDITED_` filename, and source/output hashes in its sidecars.
The label intentionally changes a small bounded image area and must not be
removed from derivatives.

## Production access requirements

- Authenticate every route using the approved admin session/JWT mechanism.
- Enforce administrator role and site/resource scope server-side on every
  operation, including preview and download.
- Existing inspected `authMiddleware` verifies JWTs but does not enforce the
  role claim; do not assume it provides admin-only authorization.
- Do not expose S3 object keys or unauthenticated presigned downloads.
- Never trust actor ID, source hash, profile authorization, output key, or
  review claims supplied by the browser.
- Apply request limits, decoder limits, concurrency limits, timeouts, and
  safe logging. Avoid logging image data, tokens, or secrets.

## Source integrity

- Keep source bytes immutable and never overwrite or delete original evidence.
- Hash exact source and output bytes and verify the source did not change
  during processing.
- Store derivatives separately and clearly label their edited status.
- Burn a visible `EDITED DERIVATIVE - NOT ORIGINAL CCTV` label into every
  exported image, in addition to the filename and sidecars.
- Do not alter EXIF/camera capture time to match requested overlay text.
- A requested overlay timestamp is not verified capture time.

## Audit trail

Record source identity/hash, authenticated actor (in production), job/profile
versions, requested operations and parameters, reference patch hash,
processing time (not capture time), output hash, machine QA checks, warnings,
and human review decision. Retention and deletion periods require an
operational policy before production.

## File handling and privacy

Validate actual image decoding as well as filename/type; cap encoded bytes and
decoded pixels; use unique output directories; reject path traversal and
symlink escapes; never execute CSV/profile contents. Keep local sample data
synthetic. Do not upload private weighbridge images to external services or
include them in public fixtures without explicit authorization.

## Honest QA

Machine checks can validate dimensions, bounds, hashes, and operation flow.
They cannot prove that the truck, raised platform, yellow rod, or scene content
was visually preserved. Such checks require operator review and must not be
reported as machine-verified facts.
