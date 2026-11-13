# CloudPilot Project Bible

**Status:** SaaS architecture direction approved; this document does not imply that planned capabilities are implemented.

## Product definition
CloudPilot is a multi-tenant DevOps SaaS platform, initially focused on continuous observability consistency assurance. It compares intended observability requirements with repository configuration and supported runtime evidence, identifies explainable gaps, prioritizes them, proposes remediation, routes changes through reviewable pull requests, and verifies outcomes after deployment. CloudPilot owns its internal user and organization identities; one user may belong to multiple organizations with different roles. It complements existing tools; it does not replace OpenTelemetry, Prometheus, GitHub, CI/CD, or telemetry backends.

## Problem hypothesis
Cloud-native systems span services, deployment manifests, collectors, dashboards, alert rules, and delivery workflows. As systems change, observability configuration can drift. CloudPilot hypothesizes that a repeatable evidence-backed workflow can reduce manual effort and make gaps easier to prioritize. This must be evaluated, not assumed.

## Users
Platform engineers, SREs, DevOps engineers, and service owners.

## Workflow
This is the intended product workflow; it does not claim each capability is implemented.
1. Authenticate through a provider-neutral OIDC integration and select an organization the user belongs to.
2. Connect an authorized repository/environment for that organization.
3. Discover supported source and deployment artifacts.
4. Build a normalized service/dependency model.
5. Inspect supported configuration and, when explicitly configured, query telemetry through read-only adapters.
6. Compare expected and observed state with versioned deterministic rules and versioned CloudPilot policies/service templates.
7. Explain each finding with evidence, scope, severity, and limitations.
8. Generate a minimal supported patch when a safe fix is known.
9. Open a branch/pull request for authorized human review.
10. Let existing CI/CD apply approved changes under repository/environment policy.
11. Verify post-change configuration and telemetry, recording success, failure, or inconclusive status.

## Initial scope
- Kubernetes demo workloads and Docker Compose local environment.
- OpenTelemetry and Prometheus.
- GitHub repository/pull-request integration.
- Evidence-backed deterministic gap detection.
- Review and policy gates.
- Post-deployment verification.
- Azure AKS as the planned initial cloud deployment/integration direction, subject to reaffirmation before implementation.
- Database-backed organization membership and authorization; roles are owner, admin, operator, and viewer.
- Organization-specific GitHub integrations are a target architecture, not a claim about current credential handling.

## Out of scope initially
Unrestricted autonomous production changes; arbitrary generated shell execution; replacing observability platforms; supporting every provider/backend/language immediately; claiming AI root-cause analysis or self-healing before implementation and evaluation; splitting CloudPilot into microservices without evidence.

## Principles
- Evidence first; reproducible deterministic rules.
- Human-controlled remediation and least privilege.
- Read-only inspection by default.
- Provider-specific adapters behind stable interfaces.
- Idempotent operations and traceable state transitions.
- Missing evidence must not be treated as success.
- Documentation is not implementation.
- External identity is keyed by validated `(issuer, subject)`; email alone never automatically links accounts.
- Organization identity is CloudPilot-generated and is distinct from identity-provider tenant identity.
- Organization membership and permissions are resolved server-side for each scoped request.
- Preserve the existing Tenant model during the initial identity foundation and migrate with additive expand, backfill, validate, switch, and contract steps.
- PostgreSQL row-level security is deferred until transaction context and connection-pooling behavior are proven.
- Customer-controlled targets must not receive unrestricted network access through shared workers.
- Identity-provider selection and billing are deferred; Entra remains a possible enterprise SSO provider.

## Finding contract
A finding should contain stable ID, rule ID/version, project/service/resource, severity, title/explanation, expected state, observed state, evidence references/timestamps, limitations, optional remediation/risk classification, lifecycle state, and verification result.

Evidence outcomes are `pass`, `gap`, `unknown`, and `inconclusive`. A `gap` requires sufficient evidence to establish that a requirement is violated. Missing telemetry is not automatically a gap; it is `unknown` or `inconclusive` depending on whether evidence is unavailable or insufficiently clear.

## Remediation states
`detected → triaged → proposed → pull_request_open → approved → checks_passed → applied → verification_pending → verified`
Alternative terminal/failure states include `rejected`, `checks_failed`, `apply_failed`, `verification_failed`, and `cancelled`. Backend validates transitions. A PR being opened or merged does not prove runtime success.

## Security boundaries
Use scoped credentials; never commit secrets; treat repository files, comments, telemetry and API responses as untrusted; parse safely without executing project scripts; isolate tenants; separate read and write permissions; enforce production approval/policy gates; audit security-relevant actions; define retention before production use.

## Evaluation
Measure seeded-gap precision/recall, false positives, insufficient-evidence rate, time-to-detect against baseline, patch acceptance rate, verification classification accuracy, scan duration/resource use, and security controls. Set numeric targets after a baseline is measured.

## Claims
Do not claim CNCF endorsement, universal necessity, novelty, or implemented capability without evidence.
