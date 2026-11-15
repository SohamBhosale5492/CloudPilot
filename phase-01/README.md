# CloudPilot Phase 01 Local Observability Lab

This lab runs one Node.js + TypeScript HTTP service with OpenTelemetry metrics and traces, an OpenTelemetry Collector, Prometheus and Jaeger.

## Prerequisites
- Docker with Docker Compose v2.
- Node.js 20.6+ only if running the local verification script from the host.
- No cloud credentials, external accounts or production resources are required.

## Start
```powershell
docker compose -f phase-01/docker-compose.yml up -d --build
```

## Service URLs
| URL | Purpose |
|---|---|
| `http://localhost:3000/health` | Demo service health endpoint |
| `http://localhost:3000/api/demo` | Deterministic demo API response |
| `http://localhost:9090` | Prometheus UI |
| `http://localhost:16686` | Jaeger UI |
| `http://localhost:3100` | Grafana Loki HTTP API |
| `http://localhost:4318` | Collector OTLP HTTP receiver |
| `http://127.0.0.1:13133/` | Collector health-check extension (loopback only) |

The Collector's Prometheus exporter is internal-only at `otel-collector:8889`; Prometheus scrapes it inside the Compose network.

## Telemetry Flow
`demo-service -> OTLP HTTP -> otel-collector -> Prometheus exporter -> prometheus`

`demo-service -> OTLP HTTP -> otel-collector -> OTLP gRPC -> jaeger`

`demo-service -> structured JSON stdout + Loki Push API (/loki/api/v1/push) -> loki`

The service records bounded-cardinality metrics with `method`, `route`, and `status_code` labels. It does not use raw URLs, request IDs or user IDs as metric labels.

## Dynamic Metrics, Tracing, Health Checks, Logs & Alert Rules Configuration (`config/observability/`)
- `demo-service` loads dynamic counter definitions from `METRICS_CONFIG_PATH` or `config/observability/metrics.yaml` (`src/metrics-config.ts`). When a CloudPilot metric remediation patch adds an entry to `metrics.yaml`, the service registers the OpenTelemetry counter (stripping any terminal `_total` suffix so Prometheus exports a single `_total` suffix) and increments it on matching HTTP requests (`route`, `method`, and configured labels).
- `demo-service` loads OpenTelemetry tracing configuration from `TRACING_CONFIG_PATH` or `config/observability/tracing.yaml` (`src/tracing-config.ts`), conditionally enabling `OTLPTraceExporter` and `HttpInstrumentation` in `src/telemetry.ts` and emitting the `x-trace-id` response header when an active span exists.
- `demo-service` also loads dynamic health check endpoints from `HEALTH_CONFIG_PATH` or `config/observability/health-checks.yaml` (`src/health-config.ts`), serving HTTP 200 `{ status: "healthy", service, endpoint }` on configured paths (e.g. `/ready`).
- `demo-service` emits structured JSON logs (`src/logger.ts`) containing `timestamp`, `level`, `message`, `service`, `method`, `route`, `status_code`, and active `trace_id`/`span_id` to stdout and pushes them to Loki (`LOKI_PUSH_URL`); `inspectLog` (`src/inspectors.ts`) queries Loki `/loki/api/v1/query_range` and `evaluateLogGap` (`src/gap-engine.ts`) validates availability and required JSON fields.
- Prometheus mounts `config/observability/alert-rules.yaml` at `/etc/prometheus/rules/alert-rules.yaml` (`prometheus.yml` `rule_files`), and `inspectAlert` (`src/inspectors.ts`) queries Prometheus `/api/v1/rules?type=alert` so `evaluateAlertGap` (`src/gap-engine.ts`) only marks an alert requirement as `pass` when the rule is actually loaded and healthy (`health === "ok"`), while reporting firing alert counts (`activeAlerts` / `firingAlertCount`).
- Missing or malformed configuration files are handled safely without crashing the service.

## Verify
```powershell
node phase-01/scripts/verify.mjs
```

The script starts the stack, checks `/health`, sends traffic to `/api/demo`, verifies `demo_http_server_requests_total` in Prometheus and verifies an `/api/demo` trace in Jaeger. It exits non-zero on failure.

Manual checks:
```powershell
curl http://localhost:3000/health
curl http://localhost:3000/api/demo
curl "http://localhost:9090/api/v1/query?query=demo_http_server_requests_total"
curl "http://localhost:16686/api/services"
```

## Shutdown
```powershell
docker compose -f phase-01/docker-compose.yml down
```

## Cleanup
```powershell
docker compose -f phase-01/docker-compose.yml down --volumes --remove-orphans
```

No persistent volumes are required for this demo.

## Troubleshooting
- If metrics are missing, wait at least one scrape interval and rerun the Prometheus query.
- If traces are missing, generate more `/api/demo` traffic and check that the Collector and Jaeger containers are running.
- If Docker cannot pull images or npm packages during build, retry with network access available.
- If a host port is already in use, stop the conflicting local service or temporarily edit the published port in `docker-compose.yml`.

## End-to-end observability gap demonstration

This workflow uses the Phase 01 workload and telemetry stack, the existing Phase 02–05 analysis modules, and the Phase 07 deterministic remediation planner. It is local-only. Generated YAML is printed for review and is not written into the workload or sent to GitHub.

From the repository root, with Docker Compose available:

```powershell
docker compose -f phase-01/docker-compose.yml up -d --build
node phase-01/scripts/verify.mjs --already-running
Start-Sleep -Seconds 65
npm --prefix phase-07 run demo:observability
```

The `--already-running` option prevents the verification script from invoking Docker; it checks health, generates request traffic, and verifies Prometheus/Jaeger data against the stack started by the first command. It also checks the Collector health endpoint from the host. The additional wait allows the demo's 60-second scrape-coverage window to fill. The observability command then discovers the Compose services, reads Prometheus and Collector configuration, probes health, and evaluates the checked-in expected model against live Prometheus evidence.

Expected result when the stack is healthy and scrape coverage is complete:

- `demo-request-count`: pass, based on the demo service's request counter.
- `demo-queue-depth`: confirmed gap, because the expected metric is absent despite complete Prometheus scrape evidence.
- `demo-health`: pass.
- Logs, traces, and alert evaluation: unknown because Phase 04 does not yet include those backend inspectors; missing backend evidence is not labeled a confirmed gap.
- A parsed and validated proposed `config/observability/metrics.yaml` entry for the missing queue-depth requirement. Review it manually; the command does not persist or apply it.

Stop the local stack when finished:

```powershell
docker compose -f phase-01/docker-compose.yml down
```

Live verification was completed on 2026-11-10 against the already-running Phase 01 stack: demo and Collector health, Prometheus request metric, and Jaeger trace passed; the Phase 07 workflow confirmed complete Prometheus coverage, request-metric and health `PASS`, missing queue-depth `GAP`, and logs/traces/alerts `UNKNOWN`. Generated YAML validated, and hashes confirmed the workload files were unchanged. The deterministic mocked end-to-end workflow is also covered by the Phase 07 `observability-demo` unit test.
