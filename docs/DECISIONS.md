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
