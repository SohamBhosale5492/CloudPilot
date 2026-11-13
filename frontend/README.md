# CloudPilot frontend

Standalone React and TypeScript UI for the existing CloudPilot API. The frontend does not replace API authorization: the backend remains authoritative for JWT validation, role checks, and tenant scoping.

## Requirements and startup

- Node.js 20.19 or newer and npm.
- A configured Microsoft Entra single-tenant API and client application, with the CloudPilot API delegated scope and the signed-in user assigned an allowed CloudPilot role.
- The CloudPilot API listening on `127.0.0.1:3000` for local development.

From this directory:

```powershell
Copy-Item .env.example .env.local
# Set the required values in .env.local; do not commit this file.
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Register that exact redirect URI in the Entra client application. Vite forwards `/api/*` and `/health/*` to `http://127.0.0.1:3000`; the backend CORS configuration is not changed. Production deployments should serve the UI and API through a same-origin reverse proxy or an explicitly configured HTTPS API origin with the required CORS policy.

To stop the Vite process, press Ctrl+C. To create a production bundle, run `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`; serve `dist/` using the deployment's static hosting and API routing setup.

## Configuration

Set these variables in an untracked local `.env.local` file (the example contains empty placeholders):

| Variable | Purpose |
| --- | --- |
| `VITE_ENTRA_TENANT_ID` | Tenant GUID used to form the tenant-specific Entra authority. |
| `VITE_ENTRA_CLIENT_ID` | Public client application GUID used by MSAL. |
| `VITE_ENTRA_API_CLIENT_ID` | CloudPilot API application GUID retained as explicit setup metadata; the configured delegated scope is what MSAL requests. |
| `VITE_ENTRA_API_SCOPE` | Delegated API scope requested for sign-in and API access, for example `api://<api-client-id>/access_as_user`. |
| `VITE_API_BASE_URL` | API base path or origin; defaults to `/`. Local Vite proxies `/api` and `/health` to port 3000. |

No client secret belongs in this browser application. MSAL obtains access tokens silently and the API client adds a bearer token per request. The UI decodes only the access token's `roles` claim to show or hide actions; it does not treat decoded claims as verified identity. Every API request is still independently authenticated and authorized by the backend. No token is logged by the frontend.

## Screens and API behavior

- Overview reads `/health/liveness` and `/health/readiness`. It shows only returned health status; it does not fabricate dashboard totals.
- Projects lists `GET /api/v1/projects`, creates with `POST /api/v1/projects` for `project:create`, opens tenant-scoped project details, and deletes with `DELETE /api/v1/projects/:projectId` for `project:delete`.
- Project details list scans, start scans, and link to findings using the existing project and scan API routes. The organization GitHub binding panel uses the signed-in user's organization list, active installation discovery, paginated repository metadata, and the verified immutable-ID binding API. The legacy repository URL panel is explicitly metadata only.
- Scans are selected within a project. Findings are read from the scan-scoped endpoint and display the returned rule, signal, verdict, expected/observed values, reason, and evidence. A supported `gap` can create a persisted proposal through the approved proposal API. The proposal review page uses server-side artifact preparation, displays the artifact hash and pinned base, and exposes approval/rejection only when the API reports organization-scoped permissions. Approval does not activate background execution; the worker remains disabled.
- Remediations list within a selected project, show a status detail page, and link to returned pull requests. Failed records are marked `Retry disabled`; the legacy retrigger endpoint is intentionally rejected with HTTP 409. If a read route responds 404, the UI reports that no record was returned instead of fabricating a dataset.
- Audit events use `GET /api/v1/audit-events` and are exposed in the UI only for `audit:read` (admin under the current backend RBAC).

All collection views use the API's `nextCursor`/`hasMore` contract with explicit previous/next navigation. A visible page is one server page, never represented as the complete dataset. Project and scan pickers are cursor-paginated too.

The navigation and controls mirror the current permission grants in `phase-06/src/rbac/guard.ts`: admin has all defined permissions; operator has project read, scan read/create, finding read, and remediation create/read; viewer has project read, scan read, finding read, and remediation read. UI gating is convenience only. Backend denial remains final.

## Validation limits

Frontend unit tests use mocked identity roles and mocked API responses. They cover local permission mapping, configuration validation, cursor navigation, bearer header attachment, proposal creation, and review actions. They do **not** verify Entra sign-in, token issuance, real organization membership, backend interoperability, or tenant isolation against a running API. No real Entra provider or production resource is contacted by the test suite.
