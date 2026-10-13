# CloudPilot

CloudPilot is a continuous observability consistency assurance platform for cloud-native applications. It discovers service/deployment configuration, compares expected observability requirements with configuration and runtime evidence, identifies explainable gaps, guides remediation through reviewable pull requests, and verifies outcomes.

**Current status:** Phase 00 foundation draft. Documentation is not implementation.

Read `docs/PROJECT_BIBLE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/THREAT_MODEL.md`, and `docs/DECISIONS.md`.

Initial scope: Kubernetes workloads, OpenTelemetry, Prometheus, GitHub pull requests, GitHub Actions, and Azure AKS. Core analysis should avoid unnecessary cloud-provider coupling. Deterministic rules own gap detection. Production-impacting changes require explicit authorization and policy checks.
