# Admin Integration Review

**Status:** Proposal only. Production integration has not been approved or
implemented. All paths below are outside the current work boundary.

## Existing application findings

- The UI is React/Vite. `admin-web/src/App.jsx` defines authenticated routes,
  `admin-web/src/components/Layout.jsx` defines navigation, and
  `admin-web/src/api/client.js` attaches the current bearer token.
- The API is Node/Express. `admin-api/src/index.js` mounts routers and applies
  a 25 MB JSON parser.
- `admin-api/src/auth.js` validates JWTs and populates `req.user`, but the
  inspected middleware does not enforce the admin role. Its JWT secret has a
  fallback when `JWT_SECRET` is absent; production must be verified and fail
  closed.
- Existing `admin-api/src/services/s3Presign.js` supports object operations.
  Use a dedicated Admin Builder prefix; never accept arbitrary client S3 keys or
  overwrite report/evidence objects.
- Local Node is v22.23.3; prototype `sharp` requires Node 20.9+. The production
  Render Node version is not recorded in checked-in documentation and remains
  unverified.
- The prototype’s test server is loopback-only and unauthenticated. It must
  not be deployed or exposed through a proxy.
- Existing `authMiddleware` validates JWTs and sets `req.user`; it does not
  check the admin role. Production role enforcement must be added to the
  feature's router and consult the current server-side user record.

## Proposed minimum file list

| File | Change |
| --- | --- |
| `admin-web/src/App.jsx` | Add Admin Builder under the existing authenticated layout |
| `admin-web/src/components/Layout.jsx` | Add an admin-only **Admin Builder** navigation entry |
| `admin-web/src/api/client.js` | Add authenticated bounded upload/process/download calls |
| `admin-web/src/pages/AdminBuilder.jsx` (new) | Port the simplified routine UI and advanced camera setup |
| `admin-api/src/index.js` | Mount the new editor router with bounded multipart parsing |
| `admin-api/src/adminAuthorization.js` (new) | Reload current `admin_users` role after JWT authentication; require `admin` |
| `admin-api/src/routes/adminBuilder.js` (new) | Guard all source, profile, process, preview, and download endpoints |
| `admin-api/src/services/adminBuilderStorage.js` (new) | Use the existing S3 service for isolated profile and derivative/sidecar prefixes |
| `admin-api/package.json`, `admin-api/package-lock.json` | Add local processor package, bounded multipart parser, API tests, and verified Node engine |
| `admin-api/test/adminBuilderAuthorization.test.js`, `admin-api/test/adminBuilderRoutes.test.js` (new) | Cover role checks, upload limits, profile reuse, hashes, and source preservation |
| `DEPLOY.md` | Document verified runtime, required environment, storage prefix, and rollback |

The processor remains in `Admin Builder/prototype` and is consumed as a local
package. Reuse the existing React/Vite, Express, JWT login, Sharp, and S3
infrastructure. Do not add a frontend framework, paid API, separate auth
system, microservice, or job queue.

## Minimal production design

- Upload one bounded JPG/PNG through multipart; process synchronously with
  configured byte/pixel limits. Do not send base64 in JSON.
- Require existing JWT authentication and a current server-side admin-role
  check on every route. Missing/invalid token returns 401; authenticated
  non-admin returns 403; role lookup failure denies access.
- Keep report/original evidence objects read-only. Store camera-profile JSON,
  reusable reference crops, edited derivatives, and manifest/QA sidecars under
  separate scoped prefixes in the existing S3 bucket.
- Store hashes, actor, processing time, requested **display-overlay** time,
  profile version, and review status in sidecars. The requested overlay is
  never represented as verified capture time.
- Do not add RDS tables initially. Add queryable history only if agreed
  retention/search needs cannot be met by scoped sidecars and object lifecycle
  rules.

## Decisions and blockers before approval

1. Choose user-uploaded image versus an authorized existing report-photo
   reference as the production source flow. Never accept an arbitrary S3 key.
2. Agree on image byte/pixel limits and lifecycle/retention for profiles,
   derivatives, and sidecars.
3. Verify deployed Node.js is compatible with `sharp@0.35.5` (Node 20.9+).
4. Verify all `admin_users.role` values, current-role query behavior, and
   production `JWT_SECRET` configuration.
5. Test bounded synchronous processing and multipart dependency/build behavior
   on the production host before release.

No production integration should begin until these decisions and this exact
file list are explicitly approved. No changes to weighing, reports, normal
media uploads, database schemas, or original evidence storage are proposed.
