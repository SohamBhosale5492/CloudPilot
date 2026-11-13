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

## SaaS foundation milestones (planning; not numbered phases)

These milestones add multi-organization SaaS capabilities without renumbering the existing phases or marking them complete. The identity-provider vendor and several operational policies remain unresolved. No milestone below is evidence of implementation.

| Milestone | Scope | Acceptance gate |
|---|---|---|
| 0.1 | Document approved SaaS architecture | Approved decisions are reflected in the five foundation documents; proposed and deferred choices remain labeled; no implementation is claimed |
| 1 | CloudPilot users, external identity mapping, organizations, memberships, and initial owner assignment | Validated `(issuer, subject)` maps to one local user; membership is organization-specific; organization creation and initial owner are atomic; legacy Tenant remains intact; cross-organization authorization tests pass |
| 2 | Organization member administration and invitations | Role changes and invitation lifecycle are authorized, audited, expiring, single-use, and safe under concurrent acceptance |
| 3 | Organization-scoped resource authorization and legacy resource migration | All API, repository, pagination, audit, and worker paths enforce organization membership; expand/backfill/validate/switch gates pass; rollback plan is reviewed |
| 4 | Organization-specific GitHub and cloud integrations | Credentials are isolated per organization, least-privilege, short-lived where supported, redacted, revocable, and tested for cross-organization denial |
| 5 | Customer target network isolation | Approved isolation model blocks prohibited network destinations and cross-customer reachability; network and DNS/redirect cases are tested |
| 6 | Frontend onboarding and organization workflows | UI uses backend membership data for organization selection and permissions; mocked identity tests are distinguished from real provider verification |
| 7 | SaaS operational controls | Quotas, retention, export/deletion, backup/restore, incident response, and audit controls have reviewed policies and operational tests |

### Milestone 2E — Additive organization ownership foundation
- Prepared the canonical schema and a new additive migration for nullable organization ownership on projects, scans, findings, remediations, and project-associated audit records, plus project adoption provenance.
- No migration has been applied as part of this work. Existing rows remain unowned (`organizationId = NULL`); no Tenant-to-Organization mapping, backfill, adoption API, authorization cutover, or deployment is performed.
- Milestone completion remains subject to review and offline validation; live PostgreSQL integration validation is a separate authorized step.

Milestone 1 depends on selecting an identity-provider integration approach and approving role semantics, organization creation, legacy ownership bootstrap, and migration compatibility. Billing is explicitly outside the identity foundation and remains deferred.

## Final completion sprint — local demo status

- A review-only local command now composes the existing Phase 02 discovery, Phase 03 expected model, Phase 04 inspectors, Phase 05 gap engine, and Phase 07 allowlisted YAML planner against the Phase 01 demo workload.
- The complete path is covered by a mocked end-to-end unit test and was run against the already-running Phase 01 Compose stack on 2026-11-10. Health, Collector health, Prometheus request metric, Jaeger trace, complete scrape coverage, gap assessment, and generated-YAML validation passed; workload files remained unchanged. Formal phase acceptance/review remains separate.
- Logs, traces, and alert backends are still unconfigured in Phase 04 and correctly remain `unknown` without evidence. A generated configuration is a proposal only and is not applied automatically.
- Phase acceptance remains evidence-based. This sprint did not run database migrations, PostgreSQL integration tests, live GitHub operations, cloud deployment, or the worker. The runtime-role database result is reused from the prior accepted run because its implementation was unchanged.

## Final integration work — 2026-11-10
- The frontend creates persisted proposals from supported gap findings, prepares/displays the immutable artifact and pinned base, and submits explicit approval/rejection through organization-authorized APIs. The API exposes execution state read-only. An opt-in Phase 08 worker now claims approved leases through the durable execution lifecycle and uses only the artifact writer/draft-PR publisher; it remains disabled by default. PostgreSQL and live GitHub execution acceptance remain unverified for this integration.
- Project details now expose organization membership selection and the existing installation/repository-discovery/immutable-ID binding APIs. The legacy project repository URL remains metadata only.
- Phase 06/07 legacy integration fixtures now require an explicit `cloudpilot_integration_test` role via `CLOUDPILOT_FIXTURE_TEST_DATABASE_URL`; a target-guarded optional grants script does not alter `cloudpilot_runtime`. The role and grants have not been provisioned or tested against PostgreSQL here.
- A first-class incident lifecycle remains unimplemented: there is no incident persistence model or configured alert-event ingestion source. Findings are not represented as incidents. PostgreSQL-backed integration, live API startup/readiness, Entra provider verification, and live GitHub behavior remain unverified in this environment.
