# Phase 08 host integration and production bootstrap

`src/main.ts` is the production process entry point. It composes the existing Phase 06 API server and Phase 08 host, using the Phase 07 GitHub executor through the established route/worker composition. It does not start another HTTP server and does not run migrations. A container image or deployment manifest remains the responsibility of the deployment environment.

## Authoritative Prisma schema and migration operations

`phase-08/prisma/schema.prisma` is the authoritative schema for the composed application. `phase-08/prisma/migrations/` is its sole supported migration history. The older Phase 06 and Phase 07 schema/migration directories remain unchanged as historical compatibility references; preserving their exact SQL preserves checksums needed to reconcile databases that applied those historical migrations. Their package scripts do not deploy those partial histories.

Generate the Prisma client from the canonical schema:

```powershell
npm --prefix phase-08 run prisma:generate
```

Run the database-free lineage and generated-client consistency check:

```powershell
npm --prefix phase-08 run prisma:check
```

Only the Phase 08 package exposes the migration deployment command. After configuring `DATABASE_URL` for the explicitly approved database and verifying its current migration history, deploy with:

```powershell
npm --prefix phase-08 run prisma:migrate
```

The explicit schema path selects the adjacent canonical `phase-08/prisma/migrations/` directory. The application host does not apply migrations at startup: deployment operators own backups, target verification, migration ordering, execution, and post-deployment verification. Before rollout, verify the database's recorded migration names and checksums and check existing remediation/finding rows for violations of the composite tenant foreign key. Do not reset or rebaseline an existing database to make its history appear consistent. Stop and investigate any checksum or history mismatch before deploying.

### Dedicated Phase 08 integration database procedure

This procedure is for a disposable, dedicated local test database only. It is documentation; migration deployment and integration tests must be run separately and intentionally. Never point these commands at `cloudpilot_test`, port 5432, or a production database.

1. Confirm the existing dedicated container is running and healthy, and inspect its published port and volume without changing it. The expected database endpoint is `127.0.0.1:55432`, database `cloudpilot_phase08_test`.
2. Set `CLOUDPILOT_PHASE08_TEST_DATABASE_URL` in the test process environment from the approved test-only configuration. Do not place credentials in command history. Verify the URL host, port, and database name without printing the URL:

   ```powershell
   $testDb = [Uri]$env:CLOUDPILOT_PHASE08_TEST_DATABASE_URL
   if ($testDb.Host -notin @('127.0.0.1', 'localhost', '::1') -or $testDb.Port -ne 55432 -or $testDb.AbsolutePath.TrimStart('/') -ne 'cloudpilot_phase08_test') { throw 'Unexpected Phase 08 test database target.' }
   ```

3. Using a read-only SQL connection to that URL, check `SELECT current_database()` and require exactly `cloudpilot_phase08_test`. Before migration, `_prisma_migrations` must contain exactly these six entries in order, each finished and not rolled back:

   ```text
   20261014000000_init
   20261023000000_durable_jobs
   20261023100000_remediation
   20261023110000_remediation_composite_fk
   20261030100000_remediation_worker_leases
   20261030110000_remediation_lease_token
   ```

   Compare every stored checksum with SHA-256 of the corresponding canonical `phase-08/prisma/migrations/<name>/migration.sql` file. Stop on any extra, missing, failed, or mismatched migration.
4. Only after those checks, explicitly set the migration command's `DATABASE_URL` to the same dedicated URL. Recheck the database name immediately before deployment. Then run the approved Phase 08 migration command; because `migrate deploy` applies all pending migrations, the exact-six precondition is what ensures this run applies only `20261101120000_saas_identity_organizations`:

   ```powershell
   $env:DATABASE_URL = $env:CLOUDPILOT_PHASE08_TEST_DATABASE_URL
   npm run prisma:migrate
   ```

5. Recheck `current_database()`. Verify exactly the seven canonical migrations are finished, with checksums matching all seven canonical SQL files; the new final entry must be `20261101120000_saas_identity_organizations`. Confirm `identity_users`, `external_identities`, `organizations`, `organization_members`, and `organization_audit_events`, their foreign keys, `ck_*` checks, `uq_*` uniqueness constraint, and `idx_*` indexes exist using read-only catalog queries. Do not run `migrate reset`, truncate, or manually repair migration history.
6. Run Phase 08 integration tests serially from this package directory:

   ```powershell
   npm run test:integration
   ```

   The identity integration test independently requires `CLOUDPILOT_PHASE08_TEST_DATABASE_URL`, restricts it to loopback port 55432 and the expected database name, checks `current_database()` and all seven migration checksums before fixture setup, and does not read `DATABASE_URL` as a fallback.
7. The test suite tracks its generated identity, organization, audit, and legacy tenant fixture IDs and deletes only rows scoped to those IDs after rechecking `current_database()`. It does not truncate tables or reset the database. If a test process is interrupted before cleanup, inspect only the run's known fixture IDs and clean them through an explicitly scoped cleanup procedure after verifying database identity again.

## Composition contract

`src/main.ts` maps environment-based OIDC settings into the existing `JwksKeyResolver` and JWT verifier contract. Only RS256/ES256 are allowed. The host connects and checks PostgreSQL and required schema objects before opening the API listener; the server initializes route extensions before listening. Startup failures reject and trigger worker/server cleanup plus Prisma disconnect. `stop()` closes the HTTP listener, drains/stops route workers, stops the scan runner, and disconnects Prisma. Calls to start share one initialization; repeated stop calls share one shutdown.

Run the production process after building:

```powershell
npm --prefix phase-08 run build
npm --prefix phase-08 start
```

For local development, Node 20.6+ can load an existing local `.env` without adding a dotenv dependency:

```powershell
npm --prefix phase-08 run start:env
```

The entry point installs idempotent `SIGTERM`/`SIGINT` handlers. The API binds to `127.0.0.1` by default; set `HOST` to an explicit IPv4 or IPv6 address (commonly `0.0.0.0` behind a controlled deployment network) to expose it. Liveness is `GET /health/liveness`; readiness is `GET /health/readiness`, which returns 503 until startup has completed, during shutdown, or when the database check fails. Readiness responses do not expose database errors. Shutdown closes the listener and drains/stops route workers before disconnecting Prisma.

Worker shutdown stops polling and lease reaping immediately, aborts active GitHub requests, and waits up to five seconds by default for in-flight work. Calls to `shutdown(timeoutMs)` can set a non-negative timeout. Database operations already in progress are drained before shutdown returns, even if that safety drain exceeds the worker-task timeout. If remote execution remains unfinished after the timeout, its heartbeat is stopped and its result is discarded; it cannot write remediation state afterward. The job remains running with its original lease and becomes recoverable through normal lease expiry and reaping (normally after the 60-second lease). A custom executor that ignores abort may remain in memory beyond the grace period, but it has no further database writes.

```ts
const host = createCloudPilotHostFromEnvironment(existingJwtVerifierConfig);
await host.start();
process.once("SIGTERM", () => { void host.stop(); });
process.once("SIGINT", () => { void host.stop(); });
```

## Environment

- `DATABASE_URL` is required and must be a PostgreSQL URL. The host constructs Prisma with this explicit URL; it does not use Phase 06's local `cloudpilot_test` fallback.
- `PORT` is optional and defaults to `3000`.
- `HOST` is optional and defaults to `127.0.0.1`; it must be an IP address.
- `CLOUDPILOT_ENABLE_REMEDIATION_WORKER` must be `true` or `false`; absent defaults to disabled. In tests, the worker only starts when explicitly set to `true`. When disabled, remediation routes are not registered, so jobs cannot accumulate without a worker.
- `CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED` must be `true` or `false`; it defaults to `false`. Unknown verified Entra principals are rejected without database writes unless explicitly enabled.
- `CLOUDPILOT_ORGANIZATION_CREATION_ENABLED` must be `true` or `false`; it defaults to enabled only when `NODE_ENV=development`, otherwise disabled.
- `CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER` is optional, defaults to `5`, and accepts `1` through `100`. A process-local create throttle is an additional best-effort guard; production deployments should also enforce edge-level rate limits.
- `GITHUB_TOKEN` is required only when the worker is enabled. The deployment must provide a currently valid, least-privilege GitHub App installation token through its secret manager. The independent `GitHubAppTokenService` can mint repository-restricted tokens, but the current worker/connector still uses `GITHUB_TOKEN`; replacing that global-token path is tracked technical debt and is not part of this stage.
- The GitHub App install-start endpoint requires backend `GITHUB_APP_SLUG`; `CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS` is optional, defaults to 600 seconds, and accepts 60 through 900 seconds. The App ID/private key are used only by the backend to create a short-lived App JWT for installation verification; no installation token is minted by this callback.
- The independent GitHub App token service retrieves only App authentication credentials; webhook verification uses a separate credential-provider method. Its in-memory cache defaults to 256 entries, has a hard maximum of 1024, removes expired entries first, then evicts least-recently-used entries. The host does not expose a token endpoint or connect this service to remediation execution.
- Future callers must first obtain an `AuthorizedGitHubRepositoryAccess` from `TrustedOrganizationGitHubAuthorizationService`. That boundary must resolve installation and immutable repository IDs from persisted organization/project bindings and verify the authenticated user's active organization membership and required permission. Browser-supplied IDs are selectors only, never proof of access. The contract is defined, but its persistence-backed implementation and installation lifecycle are not implemented.
- `GITHUB_API_BASE_URL` is optional; the Phase 07 connector defaults to GitHub's API and enforces HTTPS.
- Production authentication accepts Microsoft Entra ID v2 user access tokens for one tenant. Configure `OIDC_TENANT_ID` as the tenant GUID; `OIDC_ISSUER` must be exactly `https://login.microsoftonline.com/<OIDC_TENANT_ID>/v2.0`; `OIDC_AUDIENCE` must be the API app registration's client/application ID GUID; and `OIDC_ALLOWED_CLIENT_IDS` must be a non-empty comma-separated allowlist of client application ID GUIDs expected in `azp`. The verifier requires `ver: "2.0"`, `idtyp: "user"`, the configured `tid`, an allowlisted `azp`, and only `admin`, `operator`, or `viewer` in `roles`. Configure the API app registration to emit the optional `idtyp` claim for user access tokens (the `include_user_token` additional property); missing `idtyp` is rejected. Assign the matching app roles to users or groups. `OIDC_JWKS_URI` is optional; when omitted, the resolver discovers provider metadata from the exact issuer. If supplied, it must be HTTPS. The existing JWKS resolver blocks private IPs by default. No static signing secret is accepted by this production bootstrap. Local/provider-neutral verifier fixtures remain separate and do not use this Entra production contract.

Enable the remediation worker only after the deployment supplies the Phase 08 schema, runtime secrets, and lifecycle handling. The host fails startup if PostgreSQL verification or worker initialization fails; it does not accept remediation requests while the worker is unavailable.

The schema preflight checks required Phase 06 tables and the Milestone 1C identity/organization tables; when the remediation worker is enabled it also checks the remediation table and lease columns. It is a compatibility guard, not a schema migration or complete schema-drift detector. Deployment operators must deploy the canonical Phase 08 migrations separately and verify migration history before starting a release.

## GitHub App persistence foundation (Stage 3C)

### Immutable remediation execution artifacts (Stage 3E.3 A.2)

The canonical schema adds nullable execution_artifact, execution_artifact_hash, and approved_artifact_hash fields through additive migration 20261105160000_remediation_execution_artifact. Historical proposals remain NULL and are not backfilled. The artifact records the exact rendered file bytes together with proposal/tenant/organization/project identity, repository binding and immutable GitHub repository ID, installation record, base ref and commit SHA, plan hash, planner version, file operation/mode, original-file base64 bytes and SHA-256 digest, original Git blob SHA, rendered-content digest, canonical-patch hash, schema version, and creation time. Original source files are limited to 512 KiB and the full JSON artifact to 2 MiB. Bytes come only from the trusted snapshot reader, which pins the immutable repository and commit, checks the allowlisted canonical path and Git blob SHA, rejects symlinks/directories/submodules and unsupported modes/types, and strictly decodes base64 and UTF-8 without normalizing line endings or whitespace. Artifact validation recomputes the exact original-byte SHA-256 and Git blob SHA before persistence and on subsequent integrity checks. Proposal APIs expose only artifact metadata and hashes, never original or rendered contents.

Approval now fails closed until a valid artifact is attached and stores the exact artifact hash in approved_artifact_hash. A future worker must validate that hash, approved proposal state, current tenant/project/binding/repository/installation authorization, plan hash, base commit, and exact rendered bytes still match before any repository write. Artifact validation helpers are pure functions and are not connected to a worker.

The host now composes an internal trusted artifact-preparation service with a separate GitHub App contents-read token capability. That capability requests exactly `contents: read` and `metadata: read`: metadata permission resolves and verifies repository identity/default branch, while contents permission reads Git trees and blobs. The token is short-lived, installation- and immutable-repository-scoped, cached only in bounded backend memory, and never exposed through an API. This does not broaden the metadata-only discovery token or use the legacy global `GITHUB_TOKEN` path.

Stage 3E.3 A.2.6 adds an independent, read-only execution-authorization contract, composed internally by the host but not exposed through an API and not connected to the remediation worker. It resolves the verified issuer/subject to an active local identity, requires current active organization membership with the existing `remediation:approve` permission (owner/admin; the permission model has no separate `remediation:execute` permission), then rechecks proposal approval and plan integrity, requester/approver identity status, adopted project and scan tenant scope, active installation/binding, immutable repository ID, artifact hash and approved-artifact hash. It asks the trusted snapshot reader to resolve the current default-branch head again after reading the pinned Git tree/blob; moved heads, changed source bytes, unavailable reads, and malformed state fail closed. A missing planner-allowlisted file is represented only as an absent-file snapshot for the artifact's explicit create operation. The result contains a frozen, artifact-bound data structure without tokens or URLs. Validation is a read-only authorization decision, not a GitHub write guarantee. The approved future-writer policy uses fail-closed base-ref checks before writing and immediately before draft-PR creation, then verifies the resulting PR/base state and closes the draft where safely possible if the base moved. GitHub PR creation names a base branch and cannot atomically assert the approved base SHA, so a residual race remains; the writer must require manual review and must never silently rebase, regenerate, overwrite, or merge.

Stage 3E.2.10.4C adds a host-composed, persistence-backed capability issuer. It accepts a claimed remediation lease (never a caller-provided execution context), obtains a runtime-branded context from the serializable claim validator, requests a repository-scoped App token with exactly `{ contents: "write", pull_requests: "write", metadata: "read" }`, resolves the immutable GitHub repository ID, and requires the resolved owner/name to match trusted binding metadata. Capability lifetime is the earlier of token expiry and the database-recorded lease expiry. Context, membership, approval, adoption, installation, binding, artifact, and lease state are revalidated before each client request. In-process invalidation hooks are available for lease, binding, organization, identity, and installation changes; current mutation services do not yet call those hooks, so persisted revalidation remains authoritative. Tokens are cached only by installation/repository/permission scope and are never included in the capability. The capability service is not exposed by an API, does not create Git objects, and is not connected to the runner; the worker activation guard remains in place. The GitHub client session is short-lived, and a token already minted cannot be revoked by cache invalidation; persisted request-time checks prevent subsequent client calls after authorization loss.

Before reads, the snapshot adapter rechecks active user/membership permission, tenant/project/organization ownership, approved adoption, active binding, and the same active installation through persistence. It resolves the repository by immutable ID, verifies owner/name/default branch, resolves the default branch once to a commit SHA, then traverses that commit's Git tree and reads only planner-allowlisted observability files. It rejects identity drift, missing/duplicate paths, symlinks, submodules, non-regular modes, malformed/oversized responses, and digest mismatches. Reads have bounded timeouts and response bodies, reject redirects, and return fixed safe errors. The adapter is wired only to the internal artifact-preparation service; no public preparation route or worker integration is enabled. Tests use mocked GitHub responses only, so live GitHub permissions and runtime interoperability remain unverified. Migration deployment remains a separate operator action.

The canonical schema adds `OrganizationGitHubInstallation`, `ProjectGitHubRepository`, `GitHubConnectIntent`, and `GitHubWebhookDelivery` in migration `20261105120000_github_integration_persistence`. Installation and repository IDs use GitHub's immutable numeric identifiers. Repository bindings are constrained to the same organization as both the adopted project and installation; partial unique indexes allow one active repository per project and prevent binding one active repository twice within an organization. These partial indexes and the named CHECK constraints in this migration are SQL-managed PostgreSQL constraints under Prisma 5.22.0: the Prisma schema alone does not preserve them. The database-free `npm run prisma:check` verifies the exact partial-index names, uniqueness, columns and predicates, plus the migration-managed CHECK definitions. Keep the SQL in the canonical migration history intact and run this check when reviewing schema or migration changes.

The `ck_remediations_execution_artifact` and `ck_remediations_approval_repository_id` constraints and artifact immutability trigger are migration-managed PostgreSQL integrity controls; Prisma schema validation alone cannot verify them. Startup inspects `pg_trigger`, `pg_class`, `pg_namespace`, `pg_proc`, and `pg_language` metadata plus `pg_get_triggerdef`/`pg_get_functiondef`: it requires one enabled, non-internal, unconditional `BEFORE UPDATE OR DELETE FOR EACH ROW` trigger on `public.remediations`, bound to the expected `public` PL/pgSQL invoker function. The function rejects unsupported trigger operations, rejects changes to an existing artifact or its hash, and rejects deletion of any remediation row containing an artifact. Consequently, ordinary direct deletion and parent-driven cascade deletion cannot erase persisted artifact history; rejection and invalidation update lifecycle state while retaining artifact fields. There is no application deletion helper or proposal-delete route. Existing parent foreign keys retain their cascade semantics for legacy/no-artifact remediations, while the trigger prevents a cascade from deleting an artifact-bearing remediation. The database-free lineage verifier independently checks the pending migration's constraint expressions and trigger/function SQL source. These checks detect missing, disabled, misattached, altered, or no-op definitions at startup; they cannot stop a sufficiently privileged database owner/administrator from disabling triggers or altering schema objects, nor do they replace database role hardening and operational monitoring. Any privileged retention/deletion process requires a separately reviewed policy; no bypass exists in this stage.

Connection intents persist only a unique state hash, and webhook delivery rows persist metadata and a payload hash, never raw bodies or credentials. When webhook processing is implemented, `processed_at` represents terminal successful or intentionally ignored processing; failed attempts retain `NULL`, while `attempt_count` records processing attempts. This documents the intended persistence contract only; webhook processing is not implemented and runtime behavior is unchanged.

`OrganizationAuditEvent` now supports either a referenced CloudPilot user actor or a constrained system actor label. Existing events default to the user form and retain their IdentityUser references. The migration only makes `actor_user_id` nullable to allow the checked system form; it does not rewrite audit records.

Stage 3D.1 adds an authenticated installation-start endpoint that stores only a SHA-256 state hash. Stage 3D.2 adds an authenticated callback relay and independently verifies an installation with the GitHub App API before consuming the intent and atomically persisting the installation plus organization audit event. Only `setup_action=install` is supported; an update/reconnect lifecycle is not implemented. The callback does not establish the identity of the human who clicked through GitHub; the audit actor is the authenticated CloudPilot user who initiated the intent. The host never applies migrations and requires the canonical GitHub intent/installation tables to be deployed before startup.

Repository discovery and project-binding APIs are implemented; webhook processing remains disabled. The contents-read token capability is used only by the internal snapshot reader and is not connected to the remediation worker. The worker's repository-binding resolver remains deny-all, `Project.repositoryUrl` remains an unverified legacy hint, and the worker continues to use its existing `GITHUB_TOKEN` path. No live GitHub call or PostgreSQL callback transaction has been verified by unit tests.

## SaaS identity foundation (Milestone 1C)

The canonical schema adds `IdentityUser`, `ExternalIdentity`, `Organization`, `OrganizationMember`, and `OrganizationAuditEvent`. The existing tenant-scoped `User`, `Tenant`, resources, and legacy token-role authorization remain unchanged. The configured and verified issuer plus JWT-verifier-mapped `sub` are used as the exact external identity key; Entra `tid` remains only in the legacy identity context. This is a temporary single-issuer compatibility bridge, not generic OIDC provider support. Email is profile data and is never used to link identities.

New authenticated endpoints are `GET /api/v1/me`, `GET /api/v1/organizations?limit=&cursor=`, and `POST /api/v1/organizations` with a required `Idempotency-Key` header and `{ "displayName": "..." }`. Organization listing reflects active database memberships. Creation atomically creates the organization, active owner membership, and two organization audit events. Same creator/key/payload replays the existing result; same key with a different normalized request returns 409. The existing `AuditEvent` is not used for organization events, and no legacy Tenant ID is fabricated.

First-use provisioning is disabled by default. Organization creation defaults on only in development, and has a configurable per-user lifetime limit. Membership management, invitations, legacy Tenant-to-Organization mapping/bootstrap, resource migration, RLS, billing, and frontend changes are not implemented by this foundation. No legacy mapping is populated. Future membership-management operations must serialize owner changes on the organization row and reject any demotion, suspension, or revocation that would leave no active owner; foreign keys alone cannot enforce that invariant. Organization suspension/deletion and audit retention remain subject to the approved future data-lifecycle policy.
# GitHub repository discovery (Stage 3D.3)

The authenticated backend exposes organization-scoped active installation listing and paginated repository discovery at `GET /api/v1/organizations/:orgId/github/installations` and `GET /api/v1/organizations/:orgId/github/installations/:installationRecordId/repositories?page=1&perPage=30`. Discovery uses a separate installation token request with exactly `metadata: read`; it does not bind repositories to projects or enable remediation.

The frontend organization integrations UI is deferred because the current frontend has no trusted active-organization context or organization navigation. Do not present raw repository metadata as a verified project binding. A later frontend stage must establish safe organization context before exposing these APIs.

The current installation schema represents `active`/`disconnected` status and has no persisted `suspended` state. Discovery returns safe errors for upstream access failures and does not mutate installation status; suspension-specific persistence behavior is unsupported until an explicit lifecycle is designed.

Stage 3E.2 backend binding routes use `ProjectGitHubRepository` and the existing partial unique indexes. Repository verification is performed through the metadata-only installation token before the short persistence transaction; GitHub state can change in the interval, so later execution must revalidate the active installation and binding. The organization integrations UI remains deferred until the frontend has trusted active-organization context and navigation. Legacy `Project.repositoryUrl` remains unverified metadata and is not binding authorization.

Stage 3E.2.10.4D adds an internal artifact-only Git object writer foundation. It accepts only the runtime-branded persisted execution context, capability, and server-owned lease guard; it revalidates persisted authorization before each request and writes only the approved rendered bytes at the approved path from the exact base commit. It verifies the full tree delta and commit parent by reading the Git objects back. Ambiguous writes are not retried; unprovable outcomes require manual review. This writer creates no branch or pull request, is not connected to the remediation runner, and does not enable the worker. Its capability requests exactly `{ contents: "write", metadata: "read" }`; the separate existing token method retains pull-request scope for a future reviewed PR stage. GitHub acceptance and database lease ownership cannot be atomic, so a request already accepted by GitHub cannot be undone by lease loss; the writer stops further requests and returns a manual-review result when that risk exists.

Stage 3E.2.10.4E adds an internal deterministic branch/draft-PR publisher foundation. It accepts only a writer-produced runtime-branded commit result and its matching live artifact capability. Branch names derive from proposal and artifact identity; existing refs are accepted only at the exact verified commit, and unexpected refs are never overwritten. PR creation uses a separate token capability with exactly `{ pull_requests: "write", metadata: "read" }`; Git ref/tree/commit writes remain limited to the contents capability. The publisher verifies PR repository IDs, head ref/SHA, base ref/SHA, and current base ref, and performs one-page bounded reconciliation rather than retrying ambiguous non-idempotent requests. If the base moves after PR creation, it attempts to close only the matching draft; failure returns the unresolved PR number and URL for manual review. No rebase, regeneration, force update, merge, or automatic retry occurs. A GitHub request already accepted cannot be atomically cancelled by database lease loss. This publisher remains disconnected from the remediation runner; no live GitHub operation or production readiness is established.

The human `POST /api/v1/remediation-executions/:executionId/reconciliation/resolve` endpoint supports only `failed` and `manual_review_required`. It cannot assert successful completion because that requires runtime-branded evidence from the trusted execution workflow; completion is recorded through that workflow, not from a human-supplied outcome.
