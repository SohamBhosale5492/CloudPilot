# CloudPilot Architecture

**Status:** Approved SaaS direction with proposed implementation architecture; planned components are not necessarily implemented.

## Style
Start as a modular monolith with explicit boundaries. Add background jobs when needed; split services only when measured requirements justify it.

## Modules
- Web UI: projects, scans, findings, evidence, remediation status.
- API/application layer: provider-neutral authentication context, database-backed organization authorization, validation, orchestration, pagination.
- Repository connector: scoped GitHub operations.
- Discovery/parser: safely parses supported manifests/configuration.
- Service model: normalized services, dependencies, environments and expected requirements from versioned CloudPilot policies and service templates.
- Rule engine: deterministic, versioned comparison rules that classify outcomes as `pass`, `gap`, `unknown` or `inconclusive`.
- Telemetry adapters: read-only queries to supported telemetry backends.
- Remediation planner: minimal supported patch generation; no arbitrary command execution.
- Policy/approval: permissions, checks, environment restrictions and approval records.
- Verification: post-change configuration and telemetry checks.
- Persistence/audit: projects, scans, findings, remediation and audit history.
- Job runner: bounded jobs, timeouts, retries and idempotency.

## Data flow
`UI → API → scan orchestration → discovery → normalized model → read-only telemetry inspection → rule engine → findings`
Remediation: `finding → planner → patch validation → Git branch/PR → human approval + required checks → existing CI/CD → deployment → verification → audit/history`

## Evidence outcomes
- `pass`: sufficient evidence shows the requirement is satisfied.
- `gap`: sufficient evidence shows a requirement is violated.
- `unknown`: required evidence is unavailable, unsupported or not configured.
- `inconclusive`: evidence exists but is ambiguous, stale, incomplete or outside the configured verification window.

Missing telemetry is not automatically a gap. Verification uses configurable observation windows and rule-specific success criteria.

## Trust boundaries
1. Browser/API: authentication, authorization, validation, rate limits.
2. CloudPilot/GitHub: minimum scopes; redact tokens; separate read/write operations.
3. Parser/repository: untrusted input; bound file size/depth/time; allowlist formats.
4. Telemetry backend: read-only credentials, query/response limits.
5. Generator/source control: allowlisted paths, bounded diffs, path traversal prevention.
6. CI/CD/cloud: federated/workload identity where supported; avoid long-lived production keys.
7. Organization boundary: resolve the local user from validated `(issuer, subject)`, load that user's membership in the requested organization, and enforce permission on every scoped request, query, cursor, and worker operation. An organization ID supplied by the client is a locator, not authorization.

## Identity and organization boundary
CloudPilot owns stable UUIDs for `User` and `Organization`. `ExternalIdentity` maps a user through the exact `(issuer, subject)` pair; email alone must never automatically link accounts. `OrganizationMember` associates a user and organization with one of the database-backed roles `owner`, `admin`, `operator`, or `viewer`. One user may have different roles in different organizations. Roles and permissions are loaded server-side; token role claims and frontend state do not authorize organization access. The active organization is request/UI context and is rechecked for each request, not a trusted token claim.

The identity-provider adapter validates provider tokens and produces a provider-neutral external identity. Local identity resolution and membership authorization are separate steps. Identity-provider selection is deferred; Entra is a possible enterprise SSO provider. Do not claim a provider-neutral integration is implemented until an actual provider adapter and its configuration have been verified.

## Proposed entities
`User`, `ExternalIdentity`, `Organization`, `OrganizationMember`, `OrganizationInvitation`, `Tenant` (retained for compatibility), `Project`, `RepositoryConnection`, `Environment`, `Service`, `Scan`, `Rule/RuleVersion`, `Finding`, `Evidence`, `Remediation`, `Approval`, `VerificationRun`, `AuditEvent`, and organization-bound integration records containing secret references only. The initial identity foundation needs only User, ExternalIdentity, Organization, and OrganizationMember. Invitations and integrations are later milestones. Secret material belongs in a secrets manager, not ordinary database records.

## Legacy tenant compatibility
The initial identity foundation preserves the existing `Tenant` model and all existing tenant-scoped resource columns and constraints. The Milestone 2E schema foundation adds nullable `organizationId` fields and composite ownership constraints while retaining `tenantId`; its migration is additive and must be applied separately by an authorized operator. Existing rows are not backfilled, and NULL organization ownership remains valid for legacy records. A later project-level adoption process must not rename `tenantId` or assume that an existing tenant is permanently equivalent to one CloudPilot organization. Existing tenant/resource ownership does not identify an individual owner. Existing email fields and audit actor IDs are not sufficient proof to link a person. Initial ownership requires a separately verified, auditable bootstrap process. Authorization cutover is a later expand → backfill → validate → switch → contract migration, with rollback and relationship checks before constraints are tightened. Adoption APIs, backfill, authorization cutover, and production deployment are not part of this foundation. See `MILESTONE_2B_ORGANIZATION_OWNERSHIP_DESIGN.md` and `MILESTONE_2E_ORGANIZATION_OWNERSHIP_FOUNDATION.md`.

## API and operations
Version APIs (e.g. `/api/v1`); validate inputs; use consistent errors and correlation IDs; paginate; authorize every scoped operation; make long scans asynchronous; define idempotency; redact secrets. Use structured logs, health/readiness endpoints, bounded retries, timeouts, resource limits, migrations, backups and restore tests.

## Prisma schema and migration ownership
For the composed Phase 06–08 application, `phase-08/prisma/schema.prisma` and its adjacent `migrations/` directory are authoritative. Phase 06 and Phase 07 migration files remain historical references and are not independent deployment sources. Generate the composed Prisma client and deploy migrations through the Phase 08 package scripts. Production hosts must not migrate at startup; deployment operators verify the database target and applied history, take appropriate backups, apply migrations in order, and verify the result. Existing migration SQL is immutable; consolidation proceeds by applying missing forward migrations, never by resetting or rewriting applied history.

## Initial deployment
Local Docker Compose: frontend, API, PostgreSQL, demo services, OpenTelemetry Collector, Prometheus and one compatible trace backend selected during Phase 01. Planned initial cloud target: Azure AKS with Helm/Terraform and managed/workload identity where supported, subject to reaffirmation before implementation.

## Organization roles and authorization
Roles are organization-scoped: owner, admin, operator, and viewer. Owner and admin have distinct privileges. The approved direction does not yet settle every permission assignment; the proposed owner/admin split, organization lifecycle operations, invitation permissions, and owner recovery procedure are recorded for review in `DECISIONS.md`. Existing application permissions remain enforced server-side during migration.

## RLS and network boundaries
PostgreSQL RLS is deferred until organization context can be set transaction-locally and safely across Prisma transactions and pooled connections. If adopted, policies are defense in depth; application authorization and tenant-scoped constraints remain required. Customer-controlled targets must not have unrestricted access through shared workers. The isolation model, egress policy, DNS/redirect handling, and private-network support require an explicit design before SaaS exposure.

## Integration boundaries
GitHub connections are organization-specific and should use a GitHub App with minimum permissions and short-lived installation credentials. The existing remediation executor remains the execution boundary. Azure remains the initial cloud integration direction, subject to reaffirmation; other providers are deferred. Billing is deferred. The current global-token behavior must not be mistaken for the target organization-specific integration model.

## Open and deferred decisions
Managed OIDC provider selection and pricing; detailed owner/admin permission matrix and recovery; organization slug and onboarding policy; legacy ownership bootstrap; whether/when to enable RLS and its pool-safe context mechanism; customer target network isolation; Azure reaffirmation and future cloud sequence; invitation lifecycle details; audit retention, deletion, export and legal hold; billing. The exact job/worker implementation, Phase 01 trace backend, and AI provider/data-boundary decisions remain governed by their existing decisions.
