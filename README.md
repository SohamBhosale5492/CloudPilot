# CloudPilot

CloudPilot is a continuous observability consistency assurance platform for cloud-native applications. It discovers service/deployment configuration, compares expected observability requirements with configuration and runtime evidence, identifies explainable gaps, guides remediation through reviewable pull requests, and verifies outcomes.

**Current status:** The repository contains implemented Phase 01–08 components and a local observability demo workflow, but phase acceptance is not uniformly signed off. This repository-level status is not a production-readiness claim; see `docs/ROADMAP.md` and the phase READMEs for scope and limitations.

The foundation documents are `docs/PROJECT_BIBLE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/THREAT_MODEL.md`, and `docs/DECISIONS.md`.

Initial product scope: Kubernetes workloads, OpenTelemetry, Prometheus, GitHub pull requests, GitHub Actions, and Azure AKS as the first cloud target. Phase 00 itself is documentation-only; local behavior must be validated before cloud deployment work begins. Core analysis should avoid unnecessary cloud-provider coupling. Deterministic rules own gap detection. Production-impacting changes require explicit authorization and policy checks.

## Local observability demonstration

The Phase 01 lab supplies the demo workload, OpenTelemetry Collector, Prometheus, and Jaeger. The local review workflow connects existing Phase 02–05 discovery, inspection, deterministic assessment, and Phase 07 allowlisted configuration generation. It prints a proposed configuration for review and does not write workload files or create a GitHub pull request.

See [`phase-01/README.md`](phase-01/README.md#cloudpilot-phase-01-local-observability-lab) for setup, execution, expected findings, and limitations. The documented live verification on 2026-11-10 is historical evidence from the earlier acceptance run; it was not repeated during this submission-closure task. The demo requires Docker Compose to be run by the operator.

The web frontend provides project registration, scan and findings views, persisted remediation proposal review, organization-scoped GitHub repository binding, and audit views where those APIs are enabled. Proposal approval remains an explicit audited decision; the remediation worker is still disabled, so approval does not create a branch or pull request. The legacy remediation create/retrigger endpoints remain intentionally disabled. A first-class incident lifecycle/dashboard is not implemented because the backend has no incident persistence model or configured alert-event ingestion source; scan findings remain findings and are not relabeled as incidents. See the phase READMEs for verified scope and database-dependent acceptance limits.
