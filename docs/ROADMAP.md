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

Keep pull requests small. Use a sandbox repository for write integrations. Never use production credentials in development. Record deviations in `DECISIONS.md`. Cloud deployment follows reliable local behavior.
