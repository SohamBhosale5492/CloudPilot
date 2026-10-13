# CloudPilot Project Bible

**Status:** Phase 00 draft for human review.

## Product definition
CloudPilot is a continuous observability consistency assurance platform. It compares intended observability requirements with repository configuration and supported runtime evidence, identifies explainable gaps, prioritizes them, proposes remediation, routes changes through reviewable pull requests, and verifies outcomes after deployment. It complements existing tools; it does not replace OpenTelemetry, Prometheus, GitHub, CI/CD, or telemetry backends.

## Problem hypothesis
Cloud-native systems span services, deployment manifests, collectors, dashboards, alert rules, and delivery workflows. As systems change, observability configuration can drift. CloudPilot hypothesizes that a repeatable evidence-backed workflow can reduce manual effort and make gaps easier to prioritize. This must be evaluated, not assumed.

## Users
Platform engineers, SREs, DevOps engineers, and service owners.

## Workflow
1. Connect an authorized repository/environment.
2. Discover supported source and deployment artifacts.
3. Build a normalized service/dependency model.
4. Inspect supported configuration and, when explicitly configured, query telemetry through read-only adapters.
5. Compare expected and observed state with versioned deterministic rules and versioned CloudPilot policies/service templates.
6. Explain each finding with evidence, scope, severity, and limitations.
7. Generate a minimal supported patch when a safe fix is known.
8. Open a branch/pull request for authorized human review.
9. Let existing CI/CD apply approved changes under repository/environment policy.
10. Verify post-change configuration and telemetry, recording success, failure, or inconclusive status.

## Initial scope
- Kubernetes demo workloads and Docker Compose local environment.
- OpenTelemetry and Prometheus.
- GitHub repository/pull-request integration.
- Evidence-backed deterministic gap detection.
- Review and policy gates.
- Post-deployment verification.
- Azure AKS as first cloud deployment target.

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
