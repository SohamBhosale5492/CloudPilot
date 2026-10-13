# Architecture and Product Decisions

Append decisions with date, status, context, alternatives, consequences and review trigger.

## D-001: Modular monolith first
- **Date:** 2026-10-13
- **Status:** Proposed for review
- **Decision:** Start with explicit module boundaries in one deployable backend.
- **Context:** Early development needs simple deployment; no measured need for multiple services.
- **Alternative:** Microservices from day one.
- **Consequence:** Simpler development; boundaries must be maintained.
- **Review trigger:** Measured scaling, isolation, reliability or deployment needs justify splitting.

## D-002: Deterministic rules own gap detection
- **Date:** 2026-10-13
- **Status:** Proposed for review
- **Decision:** Versioned deterministic rules are the source of truth for gap existence.
- **Context:** Findings must be reproducible and explainable.
- **Alternative:** LLM decides findings directly.
- **Consequence:** Rule maintenance required; AI may assist with explanations/fixes but not policy outcomes.
- **Review trigger:** Evidence shows bounded AI assistance improves outcomes without reducing safety.

## D-003: Pull requests for remediation
- **Date:** 2026-10-13
- **Status:** Proposed for review
- **Decision:** Source changes go through branch, PR, required checks and authorized review.
- **Context:** Remediation must be reviewable, auditable, reversible and compatible with existing repository policies.
- **Alternative:** Direct application mutation.
- **Consequence:** Reviewability and traceability; deployment still needs runtime verification.
- **Review trigger:** A supported remediation cannot reasonably be represented as a repository change.

## D-004: Azure AKS initial target
- **Date:** 2026-10-13
- **Status:** Proposed for review
- **Decision:** Azure AKS is the first cloud target; core domain logic remains provider-agnostic where practical.
- **Context:** The project needs one concrete cloud deployment path for validation without making provider-specific behavior the core model.
- **Alternative:** Multi-cloud deployment simultaneously.
- **Consequence:** Azure adapters exist but should not leak into core domain types.
- **Review trigger:** Validated demand for another provider.

## D-005: TypeScript/React/PostgreSQL/Prisma baseline
- **Date:** 2026-10-13
- **Status:** Proposed for review
- **Decision:** TypeScript backend/frontend, React + Vite UI, PostgreSQL persistence, Prisma migrations.
- **Context:** A shared typed stack should reduce early integration overhead across API, UI and persistence.
- **Alternative:** Polyglot services, a different frontend framework, or a different persistence/migration stack.
- **Consequence:** Consistent language and typed contracts; requires migration discipline.
- **Review trigger:** Demonstrated requirements exceed this baseline.

## Open decisions
Authentication/session model; tenant isolation and row-level security; GitHub App permissions and exact minimum scopes; source of expected observability requirements; verification evidence windows and inconclusive thresholds; job queue; local logs/traces backend; policy engine; audit retention/integrity; AI provider and data boundaries.
