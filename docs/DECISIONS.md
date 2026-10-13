# Architecture and Product Decisions

Append decisions with date, status, context, alternatives, consequences and review trigger.

## D-001: Modular monolith first
- **Status:** Proposed for review
- **Decision:** Start with explicit module boundaries in one deployable backend.
- **Context:** Early development needs simple deployment; no measured need for multiple services.
- **Alternative:** Microservices from day one.
- **Consequence:** Simpler development; boundaries must be maintained.
- **Review trigger:** Measured scaling, isolation, reliability or deployment needs justify splitting.

## D-002: Deterministic rules own gap detection
- **Status:** Proposed for review
- **Decision:** Versioned deterministic rules are the source of truth for gap existence.
- **Context:** Findings must be reproducible and explainable.
- **Alternative:** LLM decides findings directly.
- **Consequence:** Rule maintenance required; AI may assist with explanations/fixes but not policy outcomes.
- **Review trigger:** Evidence shows bounded AI assistance improves outcomes without reducing safety.

## D-003: Pull requests for remediation
- **Status:** Proposed for review
- **Decision:** Source changes go through branch, PR, required checks and authorized review.
- **Alternative:** Direct application mutation.
- **Consequence:** Reviewability and traceability; deployment still needs runtime verification.
- **Review trigger:** A supported remediation cannot reasonably be represented as a repository change.

## D-004: Azure AKS initial target
- **Status:** Proposed for review
- **Decision:** Azure AKS is the first cloud target; core domain logic remains provider-agnostic where practical.
- **Alternative:** Multi-cloud deployment simultaneously.
- **Consequence:** Azure adapters exist but should not leak into core domain types.
- **Review trigger:** Validated demand for another provider.

## D-005: TypeScript/React/PostgreSQL/Prisma baseline
- **Status:** Proposed for review
- **Decision:** TypeScript backend/frontend, React + Vite UI, PostgreSQL persistence, Prisma migrations.
- **Consequence:** Consistent language and typed contracts; requires migration discipline.
- **Review trigger:** Demonstrated requirements exceed this baseline.

## Open decisions
Authentication/session model; tenant isolation and row-level security; GitHub App permissions; job queue; local logs/traces backend; policy engine; audit retention/integrity; AI provider and data boundaries.
