# CloudPilot Phase 03 Expected Observability Model

Status: implemented for review; not marked complete until acceptance evidence is reviewed.

## Scope
Phase 03 defines a versioned expected-observability requirements model. It describes what a service is expected to provide, but it does not inspect runtime systems, query telemetry, evaluate gaps, generate remediation, or persist data.

The implementation lives in `phase-01/demo-service/src/expected-observability.ts` to reuse the existing TypeScript build and test harness.

## Schema Version
The first supported schema version is:

```text
cloudpilot.expected-observability.v1
```

Inputs with other schema versions are reported as unsupported.

## Requirement Families
The model currently supports five requirement families:

- Metrics: required metric names and dimensions.
- Logs: required structured log fields.
- Traces: required trace signal and service identity.
- Health checks: required HTTP health endpoint.
- Alerts: required alert condition, associated signal, and severity.

Every requirement has a stable `id` that must be unique across all requirement families in one document.

## Example
```json
{
  "schemaVersion": "cloudpilot.expected-observability.v1",
  "serviceId": "demo-service",
  "requirements": {
    "metrics": [
      {
        "id": "metric-http-requests",
        "signal": "metric",
        "metricName": "demo_http_server_requests_total",
        "dimensions": ["method", "route", "status_code"]
      }
    ],
    "logs": [
      {
        "id": "log-request",
        "signal": "log",
        "fields": ["level", "message", "service.name", "trace_id"]
      }
    ],
    "traces": [
      {
        "id": "trace-service-identity",
        "signal": "trace",
        "serviceName": "demo-service"
      }
    ],
    "healthChecks": [
      {
        "id": "health-http",
        "signal": "health",
        "kind": "http",
        "endpoint": "/health"
      }
    ],
    "alerts": [
      {
        "id": "alert-error-rate",
        "signal": "alert",
        "associatedSignal": "metric",
        "condition": "5xx_rate > 0.05 for 5m",
        "severity": "critical"
      }
    ]
  }
}
```

## Normalization
Normalization is deterministic:

- Requirements are sorted by requirement ID.
- Repeated dimensions and log fields are deduplicated.
- Dimensions and fields are sorted.
- Unsupported fields and unsupported values are diagnostics, not silently ignored.

## Limitations
- No runtime evidence collection.
- No Prometheus, log backend, trace backend, Kubernetes, Docker, or cloud API queries.
- No gap evaluation or remediation.
- Only HTTP health checks are supported in this schema version.
- Alert conditions are modeled as explicit strings and are not parsed into executable expressions in this schema version.
