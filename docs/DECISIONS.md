# Architecture and Product Decisions

Append decisions with date, status, rationale, alternatives, consequences and review trigger.

## D-001: Modular monolith first
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Start with explicit module boundaries in one deployable backend.
- **Rationale:** Early development needs simple deployment and clear boundaries; there is no measured need for multiple services.
- **Alternatives:** Microservices from day one; serverless-first split.
- **Consequences:** Simpler development and deployment; module boundaries must be maintained deliberately.
- **Review trigger:** Measured scaling, isolation, reliability or deployment needs justify splitting.

## D-002: Deterministic rules own gap detection
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Versioned deterministic rules decide gap existence using repository/configuration evidence and optional read-only runtime telemetry.
- **Rationale:** Findings must be reproducible, explainable and testable before any AI assistance is considered.
- **Alternatives:** LLM decides findings directly; manual-only review.
- **Consequences:** Rule maintenance is required; AI may later assist with explanations or remediation drafts but not policy outcomes.
- **Review trigger:** Seeded evaluations show deterministic rules are insufficient for a bounded use case and safety controls are defined.

## D-003: Pull requests for remediation
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Source changes go through branch, PR, required checks and authorized review.
- **Rationale:** Remediation must be reviewable, auditable, reversible and compatible with existing repository policies.
- **Alternatives:** Direct application mutation; generated instructions only.
- **Consequences:** Reviewability and traceability improve; deployment still needs runtime verification.
- **Review trigger:** A supported remediation cannot reasonably be represented as a repository change.

## D-004: Azure AKS initial target
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Azure AKS is the first cloud target; core domain logic remains provider-agnostic where practical.
- **Rationale:** The project needs one concrete cloud deployment path without making provider-specific behavior the core model.
- **Alternatives:** Multi-cloud deployment simultaneously; local-only release.
- **Consequences:** Azure adapters exist but should not leak into core domain types.
- **Review trigger:** Validated demand or implementation evidence supports another provider.

## D-005: TypeScript/React/PostgreSQL/Prisma baseline
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Use TypeScript backend/frontend, React + Vite UI, PostgreSQL persistence and Prisma migrations.
- **Rationale:** A shared typed stack reduces early integration overhead across API, UI and persistence.
- **Alternatives:** Polyglot services; a different frontend framework; a different persistence/migration stack.
- **Consequences:** Consistent language and typed contracts; requires migration discipline.
- **Review trigger:** Demonstrated requirements exceed this baseline.

## D-006: Expected observability requirements
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Define expected observability through versioned CloudPilot policies and service templates.
- **Rationale:** Requirements need an auditable source that can evolve independently from individual scans.
- **Alternatives:** Infer requirements entirely from current manifests; hard-code requirements in rules; require all requirements to live in application code.
- **Consequences:** Policy/template versioning is required; findings can reference the exact requirement version evaluated.
- **Review trigger:** Real projects need requirement sources that policies/templates cannot express clearly.

## D-007: Evidence outcomes
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Classify rule outcomes as `pass`, `gap`, `unknown` or `inconclusive`; `gap` requires sufficient evidence to establish a violated requirement.
- **Rationale:** Missing or partial evidence should not be mislabeled as success or failure.
- **Alternatives:** Binary pass/fail; treating missing telemetry as a gap.
- **Consequences:** UI, APIs and reports must preserve uncertainty explicitly.
- **Review trigger:** Evaluation shows additional states are needed for useful triage.

## D-008: Verification criteria
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Verification uses configurable observation windows and explicit rule-specific success criteria.
- **Rationale:** Runtime signals vary by service and cannot be validated safely with one fixed window or generic success rule.
- **Alternatives:** Fixed global verification window; PR merge equals verified.
- **Consequences:** Rules must define verification criteria; verification may remain inconclusive when evidence is insufficient.
- **Review trigger:** Baseline experiments identify simpler criteria that remain accurate.

## D-009: GitHub integration model
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Use a GitHub App with minimum necessary permissions and a sandbox repository for write-integration testing.
- **Rationale:** App-scoped permissions and sandbox testing reduce blast radius for branch/PR operations.
- **Alternatives:** Personal access tokens; direct Git credentials; production repository write testing.
- **Consequences:** Permission design must be explicit; write flows are validated before production-like use.
- **Review trigger:** Required GitHub operations cannot be supported with scoped App permissions.

## D-010: Authentication and authorization
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Defer provider selection, but require OIDC-compatible identity and server-side authorization for every scoped operation.
- **Rationale:** Provider choice should follow implementation constraints while authorization requirements are known now.
- **Alternatives:** Pick a provider in Phase 00; rely on client-side authorization.
- **Consequences:** Early APIs must be designed around identity claims and project/tenant authorization.
- **Review trigger:** Phase implementation requires provider-specific capabilities that affect the architecture.

## D-011: Tenant isolation
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Enforce tenant-scoped authorization everywhere and evaluate database row-level security before persistence implementation.
- **Rationale:** Tenant isolation is a security invariant, while the exact database enforcement mechanism should be chosen with the schema.
- **Alternatives:** Application-only checks; mandatory row-level security from day one.
- **Consequences:** Tests must include negative cross-tenant cases; persistence design must revisit row-level security.
- **Review trigger:** Persistence schema design begins or tenant isolation tests expose gaps.

## D-012: Background execution
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Choose the simplest reliable job/worker design for the initial workload and avoid extra infrastructure until need is demonstrated.
- **Rationale:** Scans and verification need bounded async work, but premature queue infrastructure adds operational cost.
- **Alternatives:** Full external queue from day one; synchronous-only scans.
- **Consequences:** Job abstractions should allow later replacement; initial workloads must remain bounded and idempotent.
- **Review trigger:** Scan duration, retry, concurrency or reliability requirements exceed the simple design.

## D-013: Local telemetry stack
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Use OpenTelemetry Collector, Prometheus and one compatible trace backend locally; choose the trace backend in Phase 01 based on setup and resource cost.
- **Rationale:** Metrics and traces are needed for the lab, but trace-backend selection should be evidence-based.
- **Alternatives:** Prometheus-only lab; choose Jaeger/Tempo/other backend in Phase 00.
- **Consequences:** Phase 01 must record the trace backend choice and rationale.
- **Review trigger:** Local lab setup begins or resource constraints make a backend unsuitable.

## D-014: Policy enforcement
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Enforce policy through deterministic backend checks plus GitHub branch protection and CI/CD environment controls.
- **Rationale:** Production-impacting actions require controls both inside CloudPilot and in the delivery system.
- **Alternatives:** CloudPilot-only policy; CI/CD-only policy.
- **Consequences:** Approval and policy records must be auditable; external protection settings become part of validation.
- **Review trigger:** Required policies cannot be expressed with deterministic checks and repository/environment controls.

## D-015: Audit model
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Use a restricted append-only application workflow for audit records; specify retention and stronger integrity controls before production.
- **Rationale:** Early audit history needs traceability without claiming production-grade tamper resistance.
- **Alternatives:** Mutable audit log; fully external immutable ledger from day one.
- **Consequences:** Production readiness depends on a later retention and integrity decision.
- **Review trigger:** Production use is planned or compliance requirements are identified.

## D-016: AI integration boundary
- **Date:** 2026-10-13
- **Status:** Accepted for initial implementation
- **Decision:** Defer model integration until deterministic detection is tested; before enabling AI, define data minimization, provider retention, logging and approval boundaries.
- **Rationale:** AI assistance should not precede reproducible detection or explicit data-boundary controls.
- **Alternatives:** Add AI remediation/explanation during initial implementation; forbid AI permanently.
- **Consequences:** Initial product claims remain deterministic; later AI work needs a separate reviewed decision.
- **Review trigger:** Deterministic detection baseline exists and a bounded AI use case is proposed.

## Deferred choices
Authentication provider; database row-level security mechanism; exact job/worker implementation; Phase 01 trace backend; production audit retention/integrity controls; AI provider/model and data-boundary configuration.

## SaaS architecture decisions

The following decisions extend, and where stated refine, the historical D-001–D-016 record. Historical entries are retained unchanged. “Approved” records the reviewed SaaS direction; “Proposed for review” identifies policy or implementation detail still requiring approval; “Deferred” is intentionally not selected or implemented.

## D-017: Provider-neutral identity contract
- **Date:** 2026-11-01
- **Status:** Approved; identity-provider selection deferred
- **Decision:** Use a provider-neutral OIDC integration boundary. Validate provider tokens before resolving a CloudPilot identity. Entra remains a possible enterprise SSO provider, not the mandatory SaaS identity model.
- **Rationale:** CloudPilot needs its own user and organization model that is independent of one identity vendor.
- **Alternatives:** Make Entra the only identity provider; implement local passwords; couple domain authorization directly to a vendor SDK.
- **Consequences:** A managed OIDC provider must be selected before production integration. Vendor capability and pricing remain unassessed and unresolved. Provider adapters must not define organization roles.
- **Review trigger:** Provider selection or a provider-specific capability changes the identity contract.

## D-018: External identity mapping and account-linking safeguards
- **Date:** 2026-11-01
- **Status:** Approved
- **Decision:** CloudPilot owns stable internal user UUIDs. Map an external identity by the validated exact pair `(issuer, subject)`. Email alone must never automatically link identities.
- **Rationale:** Provider subjects are identity keys within an issuer; email may change, be unverified, or be shared/reassigned.
- **Alternatives:** Use email as the account key; use provider tenant ID as the CloudPilot user or organization ID.
- **Consequences:** Account linking requires an explicit flow proving control of both identities; identity creation and linking must be audited. Existing email records do not establish identity ownership.
- **Review trigger:** The selected provider’s stable subject behavior or account-linking requirements need additional handling.

## D-019: Organization membership and role model
- **Date:** 2026-11-01
- **Status:** Approved for the domain model; detailed permission matrix proposed for review
- **Decision:** CloudPilot owns UUID organization identities. Users can belong to multiple organizations with different database-backed roles: `owner`, `admin`, `operator`, and `viewer`. Owner and admin have distinct privileges.
- **Rationale:** Customer organizations and per-organization authority must be independent of an identity-provider tenant and global user role.
- **Alternatives:** One CloudPilot tenant per identity-provider tenant; one global role per user; authorization from token role claims.
- **Consequences:** Every scoped API, repository, cursor, audit action, and worker operation must resolve membership for the target organization. The exact split of organization-management permissions remains proposed for review.
- **Review trigger:** The owner/admin permission matrix or additional organization roles require a product decision.

## D-020: Organization creation, ownership, and recovery
- **Date:** 2026-11-01
- **Status:** Proposed for review
- **Decision:** Recommended: create the organization and its initial owner membership atomically; define an audited owner recovery and ownership-transfer process before enabling organization lifecycle operations.
- **Rationale:** An organization without a valid owner is difficult to administer safely, and partial creation can leave inaccessible data.
- **Alternatives:** Create an organization first and assign an owner asynchronously; infer ownership from the first project, email, or legacy tenant user.
- **Consequences:** The organization bootstrap flow, recovery authority, and whether creation is open or gated require approval. Do not infer owners from existing resources or email matches.
- **Review trigger:** Before implementing organization creation, ownership transfer, recovery, or deletion.

## D-021: Organization request context and authorization
- **Date:** 2026-11-01
- **Status:** Approved for database-backed membership authorization; request-context details proposed for review
- **Decision:** Authorization is based on the authenticated local user’s membership in the requested CloudPilot organization. The organization identifier supplied by a client is not proof of access. Identity-provider roles and frontend state do not grant organization permissions.
- **Rationale:** A user may hold different roles across organizations, and each resource operation must be scoped to the intended organization.
- **Alternatives:** Put one active organization or global role in the token; trust the selected organization in the UI; authorize from identity-provider tenant IDs.
- **Consequences:** Server-side membership checks are required on every scoped operation. Recommended: keep active organization as UI/request context and revalidate it each time; decide route shape and non-enumerating error behavior before implementation.
- **Review trigger:** API route and active-organization context design is finalized or authorization tests reveal ambiguity.

## D-022: Legacy Tenant compatibility and migration
- **Date:** 2026-11-01
- **Status:** Approved
- **Decision:** Preserve the existing `Tenant` model during the initial identity foundation. Do not rename tenant identifiers directly to organization identifiers. Use additive migrations and an expand → backfill → validate → switch → contract sequence for later resource cutover.
- **Rationale:** Existing tenant-scoped resources and migration history must remain compatible while CloudPilot introduces independent organizations and memberships.
- **Alternatives:** Rename `tenantId` in place; rewrite or squash historical migrations; map resource ownership to an individual based on email.
- **Consequences:** Introduce an explicit legacy Tenant-to-Organization mapping and validate all resource relationships before authorization cutover. Existing resource ownership does not establish an individual user’s ownership; legacy ownership bootstrap remains a proposed process requiring verification.
- **Review trigger:** Before adding organization references to existing resources or switching any API/worker authorization path.

## D-023: PostgreSQL RLS and connection-pooling strategy
- **Date:** 2026-11-01
- **Status:** Deferred
- **Decision:** Do not enable PostgreSQL row-level security as part of the initial identity foundation. Reconsider it only after transaction-scoped organization context and Prisma connection-pooling behavior are proven.
- **Rationale:** A pooled connection must not retain organization context between requests; unverified RLS configuration can create false isolation confidence or cross-organization leakage.
- **Alternatives:** Enable RLS immediately; rely indefinitely on RLS alone; rely only on application checks without evaluating defense in depth.
- **Consequences:** Application membership checks and tenant-scoped constraints remain mandatory. Any later RLS work must fail closed without context, use a non-bypass application role, and test pooled connection reuse.
- **Historical clarification:** This refines D-011: RLS evaluation and deployment are deferred until a pool-safe transaction-context design can be demonstrated.
- **Review trigger:** A tested transaction-context design and RLS threat review are available.

## D-024: Organization-bound GitHub and cloud integrations
- **Date:** 2026-11-01
- **Status:** Organization-specific GitHub direction approved; Azure direction subject to reaffirmation; implementation details proposed for review
- **Decision:** GitHub integrations will be organization-specific and retain the existing remediation executor boundary. Azure remains the initial cloud integration direction, subject to reaffirmation. Billing is deferred.
- **Rationale:** Shared global credentials do not provide adequate organization isolation; the existing executor should remain reusable and database-independent.
- **Alternatives:** Continue a single global GitHub token; store raw provider credentials in ordinary database rows; implement multiple cloud providers simultaneously.
- **Consequences:** Recommended GitHub design uses organization-bound App installations and short-lived installation credentials. Cloud credential type, secret-reference service, Azure reaffirmation, and future provider order remain to be reviewed. D-004's Azure-first target is historical and must be reaffirmed before implementation; this ADR does not claim Azure adapters exist. No provider pricing or capability is assumed.
- **Review trigger:** Before implementing organization integrations, selecting a secret-management boundary, or expanding beyond Azure.

## D-025: Customer target network isolation
- **Date:** 2026-11-01
- **Status:** Approved that unrestricted shared-worker access is prohibited; isolation design proposed for review
- **Decision:** Customer-controlled network targets must not receive unrestricted network access through shared workers.
- **Rationale:** A configured target can be used to reach platform metadata, internal services, or another customer’s network.
- **Alternatives:** Permit arbitrary outbound access from shared workers; rely only on URL parsing or metadata-address checks.
- **Consequences:** Before SaaS exposure, choose and test an isolation approach such as customer-run agents, tightly constrained egress, or isolated workers. DNS resolution, redirects, private ranges, metadata endpoints, and cross-customer reachability require explicit controls.
- **Review trigger:** Before enabling customer-configured targets in a shared deployment.

## D-026: Organization deletion, audit retention, and data lifecycle
- **Date:** 2026-11-01
- **Status:** Deferred
- **Decision:** Defer organization deletion behavior and retention periods until export, audit, legal-hold, backup, and recovery requirements are defined.
- **Rationale:** Cascading deletion or indefinite retention can both conflict with customer expectations and legal obligations; current append-only application writes do not establish tamper-proof retention.
- **Alternatives:** Hard-delete all organization data immediately; retain all data indefinitely; promise immutable audit records without an integrity design.
- **Consequences:** Do not expose organization deletion until policy, authorization, audit treatment, and recovery are reviewed. Billing remains outside this decision and is separately deferred.
- **Review trigger:** Before customer onboarding terms or a production data deletion/export capability is finalized.

## D-027: Additive organization ownership foundation
- **Date:** 2026-11-01
- **Status:** Approved for additive schema implementation; migration application, adoption, backfill, and authorization cutover deferred
- **Decision:** Preserve legacy `Tenant` ownership and add nullable organization ownership to Project, Scan, Finding, Remediation, and project-associated audit records. Add project adoption records and compound ownership constraints so non-NULL organization tuples must be internally consistent. Leave existing rows NULL and retain all legacy constraints.
- **Rationale:** The schema can support a later verified project-level adoption flow without equating Tenant with Organization, changing legacy API behavior, or inferring individual ownership.
- **Alternatives:** Rename `tenantId`; backfill from Tenant identity; cut over authorization in the same migration; rely only on application checks for new ownership tuples.
- **Consequences:** Legacy rows remain valid and continue under Tenant authorization. Cross-resource organization tuple constraints apply when organization ownership is present. Full integrity for unadopted legacy resource chains remains governed by existing constraints until a separately reviewed data validation/backfill milestone. The new migration is additive and is not applied automatically.
- **Review trigger:** Before applying the migration, introducing adoption writes, validating production data, or changing any resource authorization path.
