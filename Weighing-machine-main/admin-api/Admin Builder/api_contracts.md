# Provisional API Contracts — Not Implemented

No API routes are implemented by the prototype. Paths below are conceptual
resource shapes only; select exact paths after integration approval and
repository review.

## Authorization requirements

- Require a valid existing admin session/JWT and an explicit server-side
  administrator role check on every endpoint.
- Do not rely on React route guards or client-supplied `userId`, role, source
  key, or output key.
- Authorize each source image, job, profile, history entry, and derivative
  access. A guessed ID/key must not expose another user's or site's data.
- Audit the authenticated actor from verified server context.

## Candidate resources

| Operation | Candidate method/resource | Requirements |
| --- | --- | --- |
| List/create/update profiles | `GET/POST /admin/admin-builder/profiles`, `PUT .../:profileId` | Admin only; strict schema; version changes; no arbitrary server file paths |
| Create job | `POST /admin/admin-builder/jobs` | Admin only; strict body; source must be authorized; bounded image size/pixels |
| Read job status | `GET /admin/admin-builder/jobs/:jobId` | Admin only; job/site ownership verified |
| Read preview/result | `GET /admin/admin-builder/jobs/:jobId/preview` | Admin only; no public or unscoped object URLs |
| Review decision | `POST /admin/admin-builder/jobs/:jobId/review` | Admin only; record actor, decision, and time |
| Download derivative | `GET /admin/admin-builder/jobs/:jobId/derivative` | Admin only; backend authorizes storage key and emits edited label |
| List history | `GET /admin/admin-builder/history` | Admin only; pagination, site scope, audit-safe filters |

## Request and response shape

Job creation should include only a source reference selected/authorized by the
server, a profile ID/version, requested local datetime, explicit supported
operations, and output settings. The client cannot set actor identity, source
hash, output key, review result, or claim QA passed.

Responses should use repository-standard JSON error envelopes. Expected
validation failures return 400; missing/invalid authentication 401; forbidden
role or resource scope 403/404 according to existing information-disclosure
policy; payload too large 413; unsupported media 415; unavailable processor
503; unexpected errors 500 with sanitized public message and correlated
server-side log context.

## Resource controls to decide

Set upload size, pixel dimensions, processing timeout, per-user concurrency,
rate limits, queue retention, output retention, and batch size before
production. These are not selected by the prototype and must be load-tested.
