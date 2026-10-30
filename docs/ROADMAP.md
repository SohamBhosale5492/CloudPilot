# CloudPilot Roadmap

A phase is complete only when acceptance evidence exists and the completion report is reviewed.

| Phase | Deliverable | Acceptance gate |
|---|---|---|
| 00 | Product/engineering foundation | Documents consistent; risks/open decisions explicit; no feature implementation claimed |
| 01 | Local observability lab | Demo services run; traffic produces expected telemetry; setup reproducible |
| 02 | Architecture discovery | Supported files parse safely; normalized model has fixture tests; unsupported formats reported |
| 03 | Expected observability model | Versioned requirements cover signals/health/alerts with tests |
| 04 | Inspectors | Read-only adapters return typed evidence and explicit unknown/error states |
| 05 | Gap engine | Deterministic findings; seeded cases establish precision/recall baseline |
| 06 | API/persistence | Authenticated APIs, migrations, project authorization and integration tests |
| 07 | GitHub remediation | Sandbox branch/PR flow, minimal patch, idempotency and failure paths tested |
| 08 | Approval/policy/CI | Unauthorized changes blocked; approvals/checks auditable; production gate tested |
| 09 | Verification | Applied/verified/failed/inconclusive states distinct; explicit verification criteria |
| 10 | Dashboard | Projects, scans, findings, evidence and remediation lifecycle; loading/error states |
| 11 | Hardening | Security tests, dependency checks, secret scanning, tenant isolation, recovery exercises |
| 12 | Azure AKS | Reproducible infrastructure, identity/network validation, deployment and rollback docs |
| 13 | Evaluation/release | Benchmarks, seeded-fault experiments, test report, threat review, docs and reproducible demo |

## Phase 00 completion checklist
- The repository is initialized and the foundation documents are tracked.
- The six foundation documents agree on scope, safety boundaries, and phase ordering.
- Architecture/product/security decisions are reviewed in `docs/DECISIONS.md`, with deferred choices explicit.
- No document claims implemented behavior, benchmark results, production readiness, or external endorsement.
- Security assumptions, trust boundaries, and least-privilege controls are recorded before feature implementation starts.
- No application code is generated in Phase 00.
- `git status --short` is clean after the final Phase 00 documentation commit.

## Phase 02 implementation notes
- Initial architecture discovery supports a bounded allowlist of Docker Compose and Kubernetes YAML.
- The normalized model and diagnostic contracts are documented in `phase-02/README.md`.
- Phase 02 remains pending human review and is not marked complete by this note.

## Phase 03 implementation notes
- Defines a versioned expected-observability requirements model for metrics, logs, traces, health checks, and alerts.
- The model contract, examples, and limitations are documented in `phase-03/README.md`.
- Phase 03 remains pending human review and is not marked complete by this note.

## Phase 04 implementation notes
- Read-only inspectors return typed, provenance-aware evidence with explicit available, complete, and diagnostic states.
- The inspector contracts, adapters, and limitations are documented in `phase-04/README.md`.
- Phase 04 remains pending human review and is not marked complete by this note.

## Phase 05 implementation notes
- Deterministic gap engine evaluates expected observability requirements against pre-collected inspector evidence.
- Outcome semantics, per-signal rules, configuration contract, and known limitations are documented in `phase-05/README.md`.
- Phase 05 remains pending human review and is not marked complete by this note.

## Phase 06 implementation notes
- Authenticated REST API and persistence layer using PostgreSQL and Prisma.
- Enforces OIDC/JWT verification, tenant isolation, deny-by-default RBAC, bounded asynchronous scans, and append-only audit logging.
- Architecture, schema, endpoints, and limitations are documented in `phase-06/README.md`.
- Phase 06 remains pending human review and is not marked complete by this note.

## Phase 07 implementation notes
- Automated GitHub remediation via sandbox branches and pull requests.
- Enforces deterministic, minimal, allowlisted patches (`metric`, `health`, `alert`), path traversal prevention, and idempotency at both PostgreSQL and GitHub levels.
- Architecture, schema, security controls, and failure paths are documented in `phase-07/README.md`.
- Phase 07 remains pending human review and is not marked complete by this note.

Keep pull requests small. Use a sandbox repository for write integrations. Never use production credentials in development. Record deviations in `DECISIONS.md`. Cloud deployment follows reliable local behavior.
