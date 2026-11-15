# CloudPilot Phase 07 — GitHub Remediation & Sandbox Pull Request Automation

Phase 07 implements automated, explainable remediation via GitHub sandbox branches and pull requests, adhering to foundation decisions D-002, D-003, D-009, and D-014.

## Architecture

```
[ Gap Findings (Phase 05 / 06) ]
               │
               ▼
   [ Remediation Planner ] ──── Deterministic & Allowlisted Patches
               │
               ▼
 [ Remediation Orchestrator ] ── PostgreSQL Idempotency Key Check
               │
               ├─► Check Existing GitHub PR (findOpenPullRequest)
               ├─► Create Sandbox Branch from base (e.g. main)
               ├─► Read File Content (or supply standard placeholder)
               ├─► Apply Minimal Allowlisted Patch (idempotent YAML transformation)
               ├─► Commit File with Semantic Message
               └─► Open Draft Pull Request & Persist Outcome
```

## Security & Operational Controls

### 1. Minimal Allowlisted Patching (D-002, D-003)
- Only verified gap findings for allowlisted observability signals (`metric`, `health`, `alert`, `trace`) produce remediation patches.
- Unsupported signals (`log`) and non-gap outcomes (`pass`, `unknown`, `inconclusive`) are safely skipped with explicit audit attribution.
- No arbitrary code or command execution is permitted. File modification is strictly restricted to designated observability configuration paths (`config/observability/metrics.yaml`, `config/observability/health-checks.yaml`, `config/observability/alert-rules.yaml`, `config/observability/tracing.yaml`).
- For the `demo-service` workflow, `config/observability/metrics.yaml` (`phase-01/demo-service/src/metrics-config.ts`), `config/observability/health-checks.yaml` (`phase-01/demo-service/src/health-config.ts`), and `config/observability/tracing.yaml` (`phase-01/demo-service/src/tracing-config.ts`) are consumed at runtime by `demo-service`.
- `config/observability/alert-rules.yaml` generates validated Prometheus `groups[].rules[]` YAML (`validatePrometheusAlertRulesYaml` / `patchPrometheusAlertRulesYaml`), is mounted into Prometheus (`/etc/prometheus/rules/alert-rules.yaml`), and is verified at runtime by `inspectAlert` querying `/api/v1/rules?type=alert` and `evaluateAlertGap` checking loaded rule presence and `health === "ok"`.
- `trace` remediation patches `config/observability/tracing.yaml` (`validateTracingConfigYaml` / `patchTracingYaml`) and is verified at runtime by `inspectTrace` querying Jaeger `/api/traces`; `log` is inspected via Grafana Loki (`inspectLog` querying `/loki/api/v1/query_range`) but remains unsupported by the remediation planner (`UnsupportedFindingError`).
- PR delivery (`draft_pr_created`, `pr_merged`) is tracked separately from actual finding resolution: a finding is marked `resolved` only after a subsequent completed scan reports `outcome = "pass"` with live telemetry evidence.

### 2. Path Traversal & Sandbox Protection
- All repository paths, branch names, and repository identifiers are strictly validated against strict regex allowlists before network dispatch.
- Directory traversal sequences (`..`), leading slashes, and control characters are rejected immediately.
- Branches are created under an isolated sandbox prefix (`cloudpilot/remediate/<base64url-hash>`), guaranteeing zero collisions with protected production branches.

### 3. Strict Idempotency & Concurrency Safety
- Every remediation generates a stable idempotency key derived from:
  `${tenantId}:${findingId}:${ruleId}:${ruleVersion}`
- The PostgreSQL `remediations` table enforces a database-level unique constraint (`@unique([idempotencyKey])`).
- Concurrent remediation requests are race-safe: exactly one winner creates the record, while concurrent workers catch `P2002` and cleanly return the active record without creating duplicate branches or PRs.
- `findOpenPullRequest` detects if a GitHub PR is already open for the sandbox branch, reusing the existing PR rather than creating duplicates.

### 4. Bounded Execution & Failure Budget
- Bounded network timeout (default: 10,000ms) and bounded payload sizes (1MB JSON, 2MB file content).
- Token sanitization in all error logs and audit records; tokens are never exposed in exception strings.
- Outbound redirects to non-GitHub domains are unconditionally blocked (`redirect: "error"`).
- Decrementing retry budget (`retries_left`, default 3) transitions persistent failures into terminal `failed` status without unbounded loops.

## Database schema and migrations

The authoritative schema for the composed application is [`phase-08/prisma/schema.prisma`](../phase-08/prisma/schema.prisma); the authoritative ordered migration history is its adjacent `migrations/` directory. It includes the Phase 06 core models, Phase 07 remediation records, and Phase 08 lease/fencing fields. The Phase 07 schema and migrations are retained as historical references and compatibility evidence, not as an independent deployment source. Phase 07 exposes no separate Prisma generation or migration deployment script; its package configuration points install-time client generation to the canonical schema.

Generate the client using `npm --prefix phase-08 run prisma:generate`. Verify the canonical schema, duplicated historical SQL, package pins, and composed runtime client using `npm --prefix phase-08 run prisma:check`. Only deployment operators may apply the ordered migrations with `npm --prefix phase-08 run prisma:migrate` after verifying the target database and migration history. Application hosts never apply migrations automatically.

## Running Tests

### Unit Tests
Unit tests run completely in-process using mocked interfaces (no network or database required):
```bash
npm --prefix phase-07 run test:unit
```

### Integration Tests
Integration tests require `CLOUDPILOT_FIXTURE_TEST_DATABASE_URL`, guarded for the dedicated `cloudpilot_runtime_role_test` database and `cloudpilot_integration_test` role on loopback port `56440`; they also use a local mock GitHub HTTP server. This fixture-only role is separate from the restricted runtime role and is configured by the target-guarded SQL script in Phase 08. It does not receive ownership, DDL, TRUNCATE, or append-only journal update/delete permissions. The tests perform database-backed fixture writes and are not part of the database-independent unit suite:
```bash
npm --prefix phase-07 run test:integration
```

## Local observability demo workflow

Phase 07 also exposes `npm --prefix phase-07 run demo:observability`. It composes the existing Phase 02 architecture discovery, Phase 03 expected model, Phase 04 inspectors, Phase 05 deterministic gap engine, and this phase's allowlisted YAML planner. It is separate from GitHub execution: it uses no GitHub credentials, does not open a pull request, and prints generated YAML without writing it to the inspected workload.

The workflow's full analysis chain is covered with mocked local inspector responses by `test/unit/observability-demo.test.ts`. A live run requires the Phase 01 Compose services and loopback access; see [`../phase-01/README.md`](../phase-01/README.md). Logs, traces, and alerts remain unknown when their Phase 04 adapters are unconfigured. PostgreSQL-backed GitHub remediation integration tests are a separate acceptance gate and were not run by this demo workflow.
# Composed application bootstrap

Phase 07 provides GitHub remediation components and a backward-compatible orchestration layer for controlled tests and internal use. The production application process is `phase-08/src/main.ts`; the Phase 08 host currently rejects `CLOUDPILOT_ENABLE_REMEDIATION_WORKER=true`, so this legacy executor is not activated by the production host. Build and start through the Phase 08 package; Phase 07 is not a separate production host or migration deployment entry point. See the Phase 08 README for runtime configuration and lifecycle details.
