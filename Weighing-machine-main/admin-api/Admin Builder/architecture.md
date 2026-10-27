# Architecture

## Current repository evidence

The inspected admin application uses React 18, Vite, and React Router in
`../admin-web`; protected layout and routes are declared in
`../admin-web/src/App.jsx`, with navigation in
`../admin-web/src/components/Layout.jsx`. The frontend checks login state,
which is a UI convenience and not an authorization boundary.

The API uses Express in `../admin-api/src/index.js`. Existing media and report
routes attach `authMiddleware` from `../admin-api/src/auth.js`. That middleware
validates a JWT and populates `req.user`, but the inspected implementation does
not check `req.user.role`. The login token includes a role claim, so a
server-side role authorization layer must be designed and approved before
exposing editor endpoints.

The media service in `../admin-api/src/services/s3Presign.js` supports S3
presigning and object access. Existing media routes handle regular uploads.
Admin Builder must not reuse normal upload behavior to replace evidence.
Deployment documentation describes the admin UI on Vercel and API on Render,
with PostgreSQL RDS and S3. The admin API declares Node.js 18 or later. No
image-processing library was found in the existing admin API dependency tree.
The patched `sharp` release used by the prototype requires Node.js 20.9 or
later; production integration will require confirming the Render runtime and
may require an approved Node runtime change.

This is a bounded preliminary review, not a complete audit of deployment,
database schema, retention, storage policies, or every authorization path.
Those must be verified before production integration.

## Processing architecture options

| Option | Advantages | Costs and risks | Assessment |
| --- | --- | --- | --- |
| Node.js image module (`sharp`) | Runs in the existing API runtime; avoids a second service/runtime; can use existing Node job and storage boundaries; image operations stay in a reusable package | Native dependency deployment must be verified on target platforms; image processing can consume API memory/CPU; `sharp` does not solve difficult overlay reconstruction | Preferred production direction, subject to deployment and load verification |
| Python worker (OpenCV/Pillow) | Mature image-processing ecosystem and inpainting tools; engine can be reused independently | Adds Python/runtime/dependency packaging; worker lifecycle, IPC, timeouts, resource limits, and deployment need design; do not expose a public unauthenticated worker | Keep as an alternative if validated algorithms need exceed Node capability |
| Hybrid React + Express + private Python worker | Strong UI/auth boundary plus broad Python imaging capability | Highest operational complexity; worker hardening and deploy coupling; network/service isolation needs a concrete hosting design | Do not choose without a demonstrated need |

## Recommendation

Keep the processor as a standalone, UI-independent Node package and let the
existing Express API own authentication, authorization, orchestration, storage,
and download access if integration is later approved. This aligns with the
existing Node ecosystem and avoids making a second service, but the patched
`sharp` release requires Node.js 20.9 or later. `sharp` is used only inside
the isolated prototype at `prototype/`; deployment compatibility and
processing load must be measured before adding it to the production API.

The engine accepts buffers and explicit profile/job values. It does not read
credentials, access the database/S3, or authenticate users. The optional
development UI binds to loopback only; it is not an admin service.
If a reliable localized overlay recovery method cannot be provided by the
operator, processing must stop for review; the engine must not invent hidden
pixels.

## Responsibility boundaries

- **Admin React UI (future):** authenticated navigation, controls, validation
  display, comparison/review, and derivative download.
- **Express API (future):** authentication plus explicit role authorization,
  input limits, job lifecycle, storage authorization, audit actor identity,
  and access-controlled downloads.
- **Processing package:** validated image transforms, deterministic results,
  explicit failures, hashes, and machine-readable reports.
- **Storage (future):** unique derivative keys separate from original evidence;
  no replacement of the existing source object.

## Future job execution

Do not run unbounded image work in a long-lived Express request. Start with
strict pixel/byte limits and measure realistic workloads. If processing time
or memory becomes unsuitable, evaluate a bounded queue or private worker as a
separate architecture decision. Do not add a public processing endpoint or
service in the prototype phase.
