# CloudPilot Phase 02 Architecture Discovery

Status: implemented for review; not marked complete until acceptance evidence is reviewed.

## Scope
Phase 02 adds a deterministic, read-only architecture discovery module. It parses a deliberately small allowlist of repository configuration files and returns a normalized architecture model plus diagnostics. It never executes repository code, starts containers, contacts cloud APIs, or modifies the inspected repository.

The implementation lives in `phase-01/demo-service/src/architecture-discovery.ts` to reuse the existing TypeScript build and test harness.

## Supported Formats
- Docker Compose files named `compose.yaml`, `compose.yml`, `docker-compose.yaml`, or `docker-compose.yml`.
- Kubernetes YAML documents with `apiVersion` and `kind`.

Supported Docker Compose attributes:
- Services: name, image, build context, ports, and `depends_on`.
- Resources: top-level volumes and networks.

Supported Kubernetes attributes:
- Workloads: `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, and `CronJob`.
- Resources: `Service`, `ConfigMap`, `Secret`, and `Ingress`.
- Captured fields: kind/name, first container image, container ports, and Service ports.

## Model Contract
Discovery returns:
- `status`: `success`, `partial`, `unsupported`, or `invalid`.
- `model.schemaVersion`: currently `cloudpilot.architecture.v1`.
- `model.services`: normalized service entries with stable IDs, workload type, optional image/build context, ports, declared dependencies, and source provenance.
- `model.resources`: normalized non-service resources with stable IDs, type/kind, ports when supported, and source provenance.
- `diagnostics`: explicit warnings/errors for malformed YAML, unsupported formats, unsupported constructs, duplicates, file limits, oversized files, path traversal, and invalid input.

Every model entry includes a source file and parser format. Kubernetes entries also include a document index.

## Safety Boundaries
- Input files are treated as untrusted text.
- Discovery uses bounded file count and file size limits.
- Include paths are resolved under the selected repository root; path traversal is rejected.
- `node_modules`, `dist`, and `.git` are skipped during automatic scanning.
- Dependencies are recorded only when explicitly declared in supported fields. Co-location in the same file is not a dependency.

## Limitations
- No Helm, Kustomize, Terraform, Dockerfiles, cloud APIs, dashboards, or policy inference.
- No template rendering, variable interpolation, Compose profile evaluation, or Kubernetes controller expansion.
- Unsupported and ambiguous input is diagnosed rather than guessed.
