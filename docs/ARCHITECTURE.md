# CloudPilot Architecture

**Status:** Proposed logical architecture, not implemented components.

## Style
Start as a modular monolith with explicit boundaries. Add background jobs when needed; split services only when measured requirements justify it.

## Modules
- Web UI: projects, scans, findings, evidence, remediation status.
- API/application layer: authentication context, authorization, validation, orchestration, pagination.
- Repository connector: scoped GitHub operations.
- Discovery/parser: safely parses supported manifests/configuration.
- Service model: normalized services, dependencies, environments and expected requirements.
- Rule engine: deterministic, versioned comparison rules.
- Telemetry adapters: read-only queries to supported telemetry backends.
- Remediation planner: minimal supported patch generation; no arbitrary command execution.
- Policy/approval: permissions, checks, environment restrictions and approval records.
- Verification: post-change configuration and telemetry checks.
- Persistence/audit: projects, scans, findings, remediation and audit history.
- Job runner: bounded jobs, timeouts, retries and idempotency.

## Data flow
`UI → API → scan orchestration → discovery → normalized model → read-only telemetry inspection → rule engine → findings`
Remediation: `finding → planner → patch validation → Git branch/PR → human approval + required checks → existing CI/CD → deployment → verification → audit/history`

## Trust boundaries
1. Browser/API: authentication, authorization, validation, rate limits.
2. CloudPilot/GitHub: minimum scopes; redact tokens; separate read/write operations.
3. Parser/repository: untrusted input; bound file size/depth/time; allowlist formats.
4. Telemetry backend: read-only credentials, query/response limits.
5. Generator/source control: allowlisted paths, bounded diffs, path traversal prevention.
6. CI/CD/cloud: federated/workload identity where supported; avoid long-lived production keys.
7. Tenant boundary: enforce authorization on every project-scoped request and query.

## Proposed entities
Tenant, User/IdentityMapping, Project, RepositoryConnection, Environment, Service, Scan, Rule/RuleVersion, Finding, Evidence, Remediation, Approval, VerificationRun, AuditEvent, IntegrationCredentialReference. Secret material belongs in a secrets manager, not ordinary database records.

## API and operations
Version APIs (e.g. `/api/v1`); validate inputs; use consistent errors and correlation IDs; paginate; authorize every scoped operation; make long scans asynchronous; define idempotency; redact secrets. Use structured logs, health/readiness endpoints, bounded retries, timeouts, resource limits, migrations, backups and restore tests.

## Initial deployment
Local Docker Compose: frontend, API, PostgreSQL, demo services, OpenTelemetry Collector and Prometheus. First cloud target: Azure AKS with Helm/Terraform and managed/workload identity where supported.

## Open decisions
Authentication provider, tenant isolation and row-level security, job queue, local logs/traces backend, GitHub App model, policy engine, audit integrity/retention.
