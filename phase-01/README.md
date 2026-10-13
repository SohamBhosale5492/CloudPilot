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
| `http://localhost:4318` | Collector OTLP HTTP receiver |

The Collector's Prometheus exporter is internal-only at `otel-collector:8889`; Prometheus scrapes it inside the Compose network.

## Telemetry Flow
`demo-service -> OTLP HTTP -> otel-collector -> Prometheus exporter -> prometheus`

`demo-service -> OTLP HTTP -> otel-collector -> OTLP gRPC -> jaeger`

The service records bounded-cardinality metrics with `method`, `route`, and `status_code` labels. It does not use raw URLs, request IDs or user IDs as metric labels.

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
