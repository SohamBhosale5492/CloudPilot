# Phase 08 host integration and production bootstrap

`src/main.ts` is the production process entry point. It composes the existing Phase 06 API server and Phase 08 host without starting a second HTTP server or running migrations. Remediation execution is disabled by default. Setting `CLOUDPILOT_ENABLE_REMEDIATION_WORKER=true` explicitly starts the Phase 08 lease-only worker after database/schema and GitHub App credential checks; that worker claims approved artifacts through the durable execution lifecycle and publishes only verified draft PRs. The production host does not compose the legacy Phase 07 planner/executor or global-token connector.

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

### PostgreSQL integration-test targets

Integration tests are separate from unit tests and require explicitly supplied disposable PostgreSQL URLs. Tests validate their target before connecting; never fall back to `DATABASE_URL`. The current guarded targets are:

| Variable | Required target | Notes |
| --- | --- | --- |
| `CLOUDPILOT_PHASE08_TEST_DATABASE_URL` | loopback `127.0.0.1:56432`, `cloudpilot_phase08_test` | Identity, binding, API, and rollback-contained fixtures. |
| `CLOUDPILOT_CLAIM_TEST_DATABASE_URL` | loopback `127.0.0.1:56433`, `cloudpilot_claim_test` | Claim and trusted-context fixtures. |
| `CLOUDPILOT_CLAIM_CONCURRENCY_FRESH_TEST_DATABASE_URL` | loopback `127.0.0.1:56438`, `cloudpilot_claim_concurrency_fresh_test` | Requires zero pre-existing remediation, execution, and event rows; the test refuses a non-fresh target. |
| `CLOUDPILOT_RECOVERY_LEASE_FRESH_TEST_DATABASE_URL` | loopback `127.0.0.1:56439`, `cloudpilot_recovery_lease_fresh_test` | Requires a fresh disposable target and refuses to delete existing records. |
| `CLOUDPILOT_RUNTIME_ROLE_TEST_DATABASE_URL` and `CLOUDPILOT_MIGRATION_ROLE_TEST_DATABASE_URL` | loopback `127.0.0.1:56440`, `cloudpilot_runtime_role_test`, roles `cloudpilot_runtime` and `cloudpilot_migrator` respectively | Privilege acceptance is separately gated by `CLOUDPILOT_RUN_RUNTIME_ROLE_ACCEPTANCE=true`; that test invokes Prisma migration deployment and requires explicit migration authorization. |
| `CLOUDPILOT_FIXTURE_TEST_DATABASE_URL` | loopback `127.0.0.1:56440`, `cloudpilot_runtime_role_test`, role `cloudpilot_integration_test` | Phase 06/07 legacy fixture suites only. Requires separately provisioned test-only CRUD grants; never substitute `cloudpilot_runtime`. |

The claim/concurrency/recovery tests must be run serially because their fixtures and freshness requirements differ. Do not reuse populated databases for tests that require an empty database; provision and authorize a separate disposable target instead. Normal Phase 08 unit tests do not connect to PostgreSQL:

```powershell
npm --prefix phase-08 run test:unit
```

Phase 06/07 fixture tests use `CLOUDPILOT_FIXTURE_TEST_DATABASE_URL` rather than the restricted runtime URL because the fixtures create legacy tenant/user rows. A DBA must provision the non-inheriting `cloudpilot_integration_test` login out of band and apply `scripts/grant-integration-fixture-role.sql` only after migrations in the disposable `cloudpilot_runtime_role_test` database. The SQL checks the database name and role attributes, does not grant to `cloudpilot_runtime`, does not grant DDL/TRUNCATE, and keeps `remediation_execution_events` update/delete revoked. This script was not applied as part of the current local verification.

The database-backed command is:

```powershell
npm --prefix phase-08 run test:integration
```

It builds and runs integration test files serially, but it is not safe to invoke without reviewing each test's explicit target and setup. Some integration tests require committed fixtures or a fully migrated schema. On 2026-11-10, the local process had no runtime/migration database URLs or required OIDC startup variables, and a TCP-only check found the authorized `127.0.0.1:56440` endpoint unreachable. No PostgreSQL authentication, Prisma connection/readiness, or applied migration status is asserted here; database acceptance remains partially unverified. The separate runtime-role acceptance test is skipped unless its explicit opt-in is set, and invokes `prisma migrate deploy`, so it requires separate migration authorization.

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

When explicitly enabled, the host worker stops polling, aborts cooperative in-flight requests, and drains before Prisma disconnects. The flag defaults off; no worker was activated or GitHub mutation performed during this implementation.

```ts
const host = createCloudPilotHostFromEnvironment(existingJwtVerifierConfig);
await host.start();
process.once("SIGTERM", () => { void host.stop(); });
process.once("SIGINT", () => { void host.stop(); });
```

## Environment

- `DATABASE_URL` is the restricted application/runtime connection. The host constructs Prisma with this explicit URL; it does not use Phase 06's local `cloudpilot_test` fallback.
- `MIGRATION_DATABASE_URL` is the deployment-only Prisma direct connection. The Prisma schema uses it as `directUrl`, so `prisma migrate deploy` does not fall back to runtime credentials. Keep this value out of API/worker process environments.
- Backend startup also requires `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_TENANT_ID`, and `OIDC_ALLOWED_CLIENT_IDS`; `OIDC_JWKS_URI` is optional. Configure these as process/deployment settings through the approved configuration manager. `phase-08/.env.example` documents API-process placeholders only and intentionally excludes `MIGRATION_DATABASE_URL`, so migration credentials are not copied into the API process. It is not a working credential set. Do not put real database passwords or private keys in source or commit a local environment file.

### PostgreSQL runtime and migration roles

Phase 08 uses two separate PostgreSQL logins. `cloudpilot_migrator` is available only to deployment tooling, owns application objects created or altered by Prisma migrations, and receives schema `CREATE` plus the privileges needed to deploy the canonical migration history. `cloudpilot_runtime` is the API/application login. It has no ownership, schema `CREATE`, superuser, role/database creation, replication, RLS bypass, membership inheritance, or migration privileges. It is never a member of `cloudpilot_migrator`.

Prisma Client uses only runtime `DATABASE_URL`. Prisma Migrate uses schema `directUrl` from `MIGRATION_DATABASE_URL`; set both explicitly for local schema validation/generation and configure the migration URL only in the deployment job that runs migrations. The host explicitly overrides Prisma Client's datasource with `DATABASE_URL`. Do not add an automatic credential fallback.

Provision both role names through the organization's secret-management/DBA workflow; do not put passwords in SQL files, migration files, documentation, source, or shell history. Example role attributes (set credentials interactively or through an approved secret manager):

```sql
CREATE ROLE cloudpilot_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE cloudpilot_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
```

On a fresh, dedicated CloudPilot database, grant `CONNECT` to both roles, `USAGE, CREATE` on `public` to the migrator, and `USAGE` only on `public` to runtime. The deployment principal must be able to make `cloudpilot_migrator` the owner of every application object it alters; migrations do not issue `SET ROLE`. Existing databases require a DBA ownership inventory and one-time, explicitly scoped ownership transfer before migration deployment. This repository does not assume current owners and intentionally does not transfer ownership automatically.

After the helper migration has been applied by `cloudpilot_migrator`, review and run [`scripts/grant-runtime-role.sql`](scripts/grant-runtime-role.sql) as the authorized database administrator/migration owner. It is scoped to the CloudPilot tables and roles, does not create roles or change passwords, refuses unsafe role attributes/memberships, grants only listed DML, grants helper execution, and checks effective denial of UPDATE on the four lock-only tables and UPDATE/DELETE/TRUNCATE on append-only audit/event tables. It never revokes privileges from `PUBLIC`. If it reports effective `CREATE` on `public`, first establish why the dedicated database grants it; do not remove a PUBLIC grant in a shared database.

The helpers are narrowly typed `SECURITY DEFINER` functions owned by `cloudpilot_migrator`, use only fully qualified table names and fixed `search_path = pg_catalog`, contain no dynamic SQL, and have PUBLIC execution revoked. They preserve lock modes: `findings` SHARE, active organization SHARE, member/user SHARE, active organization/member/user UPDATE for human recovery, and the binding plus installation SHARE lock in one statement. Helpers are called using the same Prisma transaction client as the surrounding state transition; row locks remain held to transaction completion. The runtime role has no UPDATE on `findings`, `organizations`, `organization_members`, or `organization_github_installations`.

Runtime table grants are intentionally not blanket grants: no access is granted to legacy `tenants`, `users`, or `github_webhook_deliveries`; `remediation_execution_events` is SELECT/INSERT only; `organization_audit_events` is INSERT only; `audit_events` is SELECT/INSERT only; runtime DELETE is limited to projects and findings for the existing project-delete and partial-scan-retry paths; and no table receives TRUNCATE. Existing artifact and event-journal triggers remain defense in depth. Review effective inherited privileges and role memberships as well as direct grants; a grant file cannot compensate for a runtime role inheriting a privileged role. The application needs no identity/serial sequence grants because the Phase 08 models generate UUID identifiers.

Operator-reported acceptance: all 18 repository migrations are applied to the isolated acceptance database, and runtime-role permissions plus the five locking helpers were verified there. Those database results were not rerun in this sprint. Before production rollout, repeat the migration success/failure, startup/readiness, helper lock lifetime/contention, claim `SKIP LOCKED`, lease fencing, recovery/reconciliation, FK, artifact immutability, and runtime-denial checks in a separate approved environment. Production deployment and existing-object ownership conversion remain prerequisites.
- `PORT` is optional and defaults to `3000`.
- `HOST` is optional and defaults to `127.0.0.1`; it must be an IP address.
- `CLOUDPILOT_ENABLE_REMEDIATION_WORKER` must be `true` or `false`; absent defaults to disabled. Only set `true` after separately accepting the GitHub App permissions, database runtime role, monitoring, and operational controls. The host validates App ID/private-key configuration before listening, then runs the artifact-only durable claim loop. With the flag absent or `false`, it remains off.
- `CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED` must be `true` or `false`; it defaults to `false`. Unknown verified Entra principals are rejected without database writes unless explicitly enabled.
- `CLOUDPILOT_ORGANIZATION_CREATION_ENABLED` must be `true` or `false`; it defaults to enabled only when `NODE_ENV=development`, otherwise disabled.
- `CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER` is optional, defaults to `5`, and accepts `1` through `100`. A process-local create throttle is an additional best-effort guard; production deployments should also enforce edge-level rate limits.
- The production execution path does not use `GITHUB_TOKEN` or `GITHUB_API_BASE_URL`; repository-scoped GitHub App tokens are used. `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are required to execute approved work. No credential is required merely to keep the worker disabled.
- The GitHub App install-start endpoint requires backend `GITHUB_APP_SLUG`; `CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS` is optional, defaults to 600 seconds, and accepts 60 through 900 seconds. The App ID/private key are used only by the backend to create a short-lived App JWT for installation verification; no installation token is minted by this callback.
- The independent GitHub App token service retrieves only App authentication credentials; webhook verification uses a separate credential-provider method. Its in-memory cache defaults to 256 entries, has a hard maximum of 1024, removes expired entries first, then evicts least-recently-used entries. The host does not expose a token endpoint or connect this service to remediation execution.
- The host composes `PrismaTrustedOrganizationGitHubAuthorizationService` with a persisted resolver that requires an active binding and active installation scoped to the same tenant, organization, and project. Browser-supplied IDs remain selectors only, never proof of access.
- Production authentication accepts Microsoft Entra ID v2 user access tokens for one tenant. Configure `OIDC_TENANT_ID` as the tenant GUID; `OIDC_ISSUER` must be exactly `https://login.microsoftonline.com/<OIDC_TENANT_ID>/v2.0`; `OIDC_AUDIENCE` must be the API app registration's client/application ID GUID; and `OIDC_ALLOWED_CLIENT_IDS` must be a non-empty comma-separated allowlist of client application ID GUIDs expected in `azp`. The verifier requires `ver: "2.0"`, `idtyp: "user"`, the configured `tid`, an allowlisted `azp`, and only `admin`, `operator`, or `viewer` in `roles`. Configure the API app registration to emit the optional `idtyp` claim for user access tokens (the `include_user_token` additional property); missing `idtyp` is rejected. Assign the matching app roles to users or groups. `OIDC_JWKS_URI` is optional; when omitted, the resolver discovers provider metadata from the exact issuer. If supplied, it must be HTTPS. The existing JWKS resolver blocks private IPs by default. No static signing secret is accepted by this production bootstrap. Local/provider-neutral verifier fixtures remain separate and do not use this Entra production contract.

The worker flag is an explicit operational opt-in and remains off by default. The host starts the API first, then the worker; shutdown stops the worker before disconnecting Prisma. The worker reaps expired leases and claims one item at a time through the durable execution lifecycle. It never invokes the legacy runner, reads mutable repository URLs, or retries uncertain remote mutations. A crash with unresolved GitHub intent remains fenced for recovery/manual review; automatic remote reconciliation is not performed by the worker. Live GitHub execution and PostgreSQL worker acceptance have not been demonstrated by the unit tests in this change.

The schema preflight checks required Phase 06 tables and the Milestone 1C identity/organization tables; when the remediation worker is enabled it also checks the remediation table and lease columns. It is a compatibility guard, not a schema migration or complete schema-drift detector. Deployment operators must deploy the canonical Phase 08 migrations separately and verify migration history before starting a release.

## GitHub App persistence foundation (Stage 3C)

### Immutable remediation execution artifacts (Stage 3E.3 A.2)

The canonical schema adds nullable execution_artifact, execution_artifact_hash, and approved_artifact_hash fields through additive migration 20261105160000_remediation_execution_artifact. Historical proposals remain NULL and are not backfilled. The artifact records the exact rendered file bytes together with proposal/tenant/organization/project identity, repository binding and immutable GitHub repository ID, installation record, base ref and commit SHA, plan hash, planner version, file operation/mode, original-file base64 bytes and SHA-256 digest, original Git blob SHA, rendered-content digest, canonical-patch hash, schema version, and creation time. Original source files are limited to 512 KiB and the full JSON artifact to 2 MiB. Bytes come only from the trusted snapshot reader, which pins the immutable repository and commit, checks the allowlisted canonical path and Git blob SHA, rejects symlinks/directories/submodules and unsupported modes/types, and strictly decodes base64 and UTF-8 without normalizing line endings or whitespace. Artifact validation recomputes the exact original-byte SHA-256 and Git blob SHA before persistence and on subsequent integrity checks. Proposal APIs expose only artifact metadata and hashes, never original or rendered contents.

Approval now fails closed until a valid artifact is attached and stores the exact artifact hash in approved_artifact_hash. The opt-in worker validates approved proposal state, tenant/project/binding/repository/installation authorization, plan hash, base commit, and exact rendered bytes before repository writes.

The host now composes an internal trusted artifact-preparation service with a separate GitHub App contents-read token capability. That capability requests exactly `contents: read` and `metadata: read`: metadata permission resolves and verifies repository identity/default branch, while contents permission reads Git trees and blobs. The token is short-lived, installation- and immutable-repository-scoped, cached only in bounded backend memory, and never exposed through an API. This does not broaden the metadata-only discovery token or use the legacy global `GITHUB_TOKEN` path.

Execution authorization is rechecked by the trusted claim context, capability, writer, and publisher at their boundaries. It verifies current identity/membership, approval, project adoption, active installation/binding, immutable repository ID, artifact hash, pinned base and lease before remote mutation. The result is a frozen artifact-bound structure without tokens or URLs. GitHub cannot atomically bind draft-PR creation to a base SHA; the publisher verifies the base before and after creation, closes only the newly created intended draft where safe if the base moved, and otherwise requires manual review. It never rebases, regenerates, overwrites, or merges.

The host composes a persistence-backed capability issuer. It accepts a claimed lease (never caller-supplied execution context), requests repository-scoped App capabilities with separate contents-write and pull-request-write permission profiles, resolves the immutable GitHub repository ID, and checks it against trusted binding metadata. Capabilities expire no later than the database lease. Membership, approval, adoption, installation, binding, artifact, and lease state are revalidated before each request. Tokens are bounded-cache entries scoped by installation/repository/permission and are never included in the capability. Persisted request-time checks prevent later calls after authorization loss; an already accepted GitHub request cannot be atomically cancelled.

Before reads, the snapshot adapter rechecks active user/membership permission, tenant/project/organization ownership, approved adoption, active binding, and the same active installation through persistence. It resolves the repository by immutable ID, verifies owner/name/default branch, resolves the default branch once to a commit SHA, then traverses that commit's Git tree and reads only planner-allowlisted observability files. It rejects identity drift, missing/duplicate paths, symlinks, submodules, non-regular modes, malformed/oversized responses, and digest mismatches. Reads have bounded timeouts and response bodies, reject redirects, and return fixed safe errors. Tests use mocked GitHub responses only, so live GitHub permissions and runtime interoperability remain unverified. Migration deployment remains a separate operator action.

The canonical schema adds `OrganizationGitHubInstallation`, `ProjectGitHubRepository`, `GitHubConnectIntent`, and `GitHubWebhookDelivery` in migration `20261105120000_github_integration_persistence`. Installation and repository IDs use GitHub's immutable numeric identifiers. Repository bindings are constrained to the same organization as both the adopted project and installation; partial unique indexes allow one active repository per project and prevent binding one active repository twice within an organization. These partial indexes and the named CHECK constraints in this migration are SQL-managed PostgreSQL constraints under Prisma 5.22.0: the Prisma schema alone does not preserve them. The database-free `npm run prisma:check` verifies the exact partial-index names, uniqueness, columns and predicates, plus the migration-managed CHECK definitions. Keep the SQL in the canonical migration history intact and run this check when reviewing schema or migration changes.

The `ck_remediations_execution_artifact` and `ck_remediations_approval_repository_id` constraints and artifact immutability trigger are migration-managed PostgreSQL integrity controls; Prisma schema validation alone cannot verify them. Startup inspects `pg_trigger`, `pg_class`, `pg_namespace`, `pg_proc`, and `pg_language` metadata plus `pg_get_triggerdef`/`pg_get_functiondef`: it requires one enabled, non-internal, unconditional `BEFORE UPDATE OR DELETE FOR EACH ROW` trigger on `public.remediations`, bound to the expected `public` PL/pgSQL invoker function. The function rejects unsupported trigger operations, rejects changes to an existing artifact or its hash, and rejects deletion of any remediation row containing an artifact. Consequently, ordinary direct deletion and parent-driven cascade deletion cannot erase persisted artifact history; rejection and invalidation update lifecycle state while retaining artifact fields. There is no application deletion helper or proposal-delete route. Existing parent foreign keys retain their cascade semantics for legacy/no-artifact remediations, while the trigger prevents a cascade from deleting an artifact-bearing remediation. The database-free lineage verifier independently checks the pending migration's constraint expressions and trigger/function SQL source. These checks detect missing, disabled, misattached, altered, or no-op definitions at startup; they cannot stop a sufficiently privileged database owner/administrator from disabling triggers or altering schema objects, nor do they replace database role hardening and operational monitoring. Any privileged retention/deletion process requires a separately reviewed policy; no bypass exists in this stage.

Connection intents persist only a unique state hash, and webhook delivery rows persist metadata and a payload hash, never raw bodies or credentials. When webhook processing is implemented, `processed_at` represents terminal successful or intentionally ignored processing; failed attempts retain `NULL`, while `attempt_count` records processing attempts. This documents the intended persistence contract only; webhook processing is not implemented and runtime behavior is unchanged.

`OrganizationAuditEvent` now supports either a referenced CloudPilot user actor or a constrained system actor label. Existing events default to the user form and retain their IdentityUser references. The migration only makes `actor_user_id` nullable to allow the checked system form; it does not rewrite audit records.

Stage 3D.1 adds an authenticated installation-start endpoint that stores only a SHA-256 state hash. Stage 3D.2 adds an authenticated callback relay and independently verifies an installation with the GitHub App API before consuming the intent and atomically persisting the installation plus organization audit event. Only `setup_action=install` is supported; an update/reconnect lifecycle is not implemented. The callback does not establish the identity of the human who clicked through GitHub; the audit actor is the authenticated CloudPilot user who initiated the intent. The host never applies migrations and requires the canonical GitHub intent/installation tables to be deployed before startup.

Repository discovery, persisted project binding, source-analysis-to-scan integration, proposal review, and the opt-in approved-artifact execution composition are implemented. Webhook processing remains disabled. `Project.repositoryUrl` remains an unverified legacy hint and is not execution authority. Legacy remediation create/retrigger requests remain HTTP 409. Mocked tests do not establish live GitHub interoperability; PostgreSQL and live GitHub acceptance remain separate release gates.

## SaaS identity foundation (Milestone 1C)

The canonical schema adds `IdentityUser`, `ExternalIdentity`, `Organization`, `OrganizationMember`, and `OrganizationAuditEvent`. The existing tenant-scoped `User`, `Tenant`, resources, and legacy token-role authorization remain unchanged. The configured and verified issuer plus JWT-verifier-mapped `sub` are used as the exact external identity key; Entra `tid` remains only in the legacy identity context. This is a temporary single-issuer compatibility bridge, not generic OIDC provider support. Email is profile data and is never used to link identities.

New authenticated endpoints are `GET /api/v1/me`, `GET /api/v1/organizations?limit=&cursor=`, and `POST /api/v1/organizations` with a required `Idempotency-Key` header and `{ "displayName": "..." }`. Organization listing reflects active database memberships. Creation atomically creates the organization, active owner membership, and two organization audit events. Same creator/key/payload replays the existing result; same key with a different normalized request returns 409. The existing `AuditEvent` is not used for organization events, and no legacy Tenant ID is fabricated.

First-use provisioning is disabled by default. Organization creation defaults on only in development, and has a configurable per-user lifetime limit. Membership management, invitations, legacy Tenant-to-Organization mapping/bootstrap, resource migration, RLS, billing, and frontend changes are not implemented by this foundation. No legacy mapping is populated. Future membership-management operations must serialize owner changes on the organization row and reject any demotion, suspension, or revocation that would leave no active owner; foreign keys alone cannot enforce that invariant. Organization suspension/deletion and audit retention remain subject to the approved future data-lifecycle policy.
# GitHub repository discovery (Stage 3D.3)

The authenticated backend exposes organization-scoped active installation listing and paginated repository discovery at `GET /api/v1/organizations/:orgId/github/installations` and `GET /api/v1/organizations/:orgId/github/installations/:installationRecordId/repositories?page=1&perPage=30`. Discovery uses a separate installation token request with exactly `metadata: read`; it does not bind repositories to projects or enable remediation.

The project detail UI now loads organizations from the authenticated membership API and uses the organization-scoped installation, repository-discovery, and project-binding routes. Backend membership, adoption, installation, and project checks remain authoritative; the legacy `Project.repositoryUrl` field remains unverified metadata and is not binding authorization.

The current installation schema represents `active`/`disconnected` status and has no persisted `suspended` state. Discovery returns safe errors for upstream access failures and does not mutate installation status; suspension-specific persistence behavior is unsupported until an explicit lifecycle is designed.

Stage 3E.2 backend binding routes use `ProjectGitHubRepository` and the existing partial unique indexes. Repository verification is performed through the metadata-only installation token before the short persistence transaction; GitHub state can change in the interval, so later execution must revalidate the active installation and binding. The UI selects only organizations returned for the signed-in user, and binding writes still pass backend organization-owner/admin authorization. Legacy `Project.repositoryUrl` remains unverified metadata and is not binding authorization.

The frontend proposal flow creates from a persisted gap finding, reads the tenant-scoped proposal, prepares its immutable artifact through `POST /api/v1/remediation-proposals/:id/prepare-artifact`, and displays the artifact hash and approved base before explicit approval. Artifact preparation reuses the trusted snapshot reader and performs no GitHub writes. Approval/rejection remains server-authorized and audited. The API reports organization-scoped preparation/approval permissions for UI affordances; these are informational and every mutation is reauthorized by the backend. Worker activation remains rejected, so approval does not execute GitHub mutations.

Stage 3E.2.10.4D adds an internal artifact-only Git object writer foundation. It accepts only the runtime-branded persisted execution context, capability, and server-owned lease guard; it revalidates persisted authorization before each request and writes only the approved rendered bytes at the approved path from the exact base commit. It verifies the full tree delta and commit parent by reading the Git objects back. Ambiguous writes are not retried; unprovable outcomes require manual review. This writer creates no branch or pull request, is not connected to the remediation runner, and does not enable the worker. Its capability requests exactly `{ contents: "write", metadata: "read" }`; the separate existing token method retains pull-request scope for a future reviewed PR stage. GitHub acceptance and database lease ownership cannot be atomic, so a request already accepted by GitHub cannot be undone by lease loss; the writer stops further requests and returns a manual-review result when that risk exists.

Stage 3E.2.10.4E adds an internal deterministic branch/draft-PR publisher foundation. It accepts only a writer-produced runtime-branded commit result and its matching live artifact capability. Branch names derive from proposal and artifact identity; existing refs are accepted only at the exact verified commit, and unexpected refs are never overwritten. PR creation uses a separate token capability with exactly `{ pull_requests: "write", metadata: "read" }`; Git ref/tree/commit writes remain limited to the contents capability. The publisher verifies PR repository IDs, head ref/SHA, base ref/SHA, and current base ref, and performs one-page bounded reconciliation rather than retrying ambiguous non-idempotent requests. If the base moves after PR creation, it attempts to close only the matching draft; failure returns the unresolved PR number and URL for manual review. No rebase, regeneration, force update, merge, or automatic retry occurs. A GitHub request already accepted cannot be atomically cancelled by database lease loss. This publisher remains disconnected from the remediation runner; no live GitHub operation or production readiness is established.

The human `POST /api/v1/remediation-executions/:executionId/reconciliation/resolve` endpoint supports only `failed` and `manual_review_required`. It cannot assert successful completion because that requires runtime-branded evidence from the trusted execution workflow; completion is recorded through that workflow, not from a human-supplied outcome.
