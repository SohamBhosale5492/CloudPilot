# CloudPilot Phase 04 Inspectors

Status: implemented for review; not marked complete until acceptance evidence is reviewed.

## Scope
Phase 04 implements read-only inspectors that return typed, provenance-aware evidence for expected observability requirements. It inspects configuration and supported runtime endpoints, reporting explicit availability, completeness, and diagnostic states without mutating systems, evaluating gaps, or generating remediation.

The implementation lives in `phase-01/demo-service/src/inspectors.ts` to reuse the existing TypeScript build and test harness.

## Inspector Adapters

### 1. Prometheus Metric Inspector
- Reuses `collectPrometheusRequestMetricEvidence()` from Phase 01 without duplicating query or scrape logic.
- Verifies scrape coverage and range increases over bounded observation windows.
- Maps unavailable or incomplete Prometheus scrapes to typed evidence with `METRIC_UNAVAILABLE` or `SCRAPE_INCOMPLETE` diagnostics.

### 2. HTTP Health Check Inspector
- Executes bounded HTTP probes (`GET`) against target endpoints.
- Measures status code, status text, and probe latency in milliseconds.
- Enforces strict bounded body consumption (default 16 KB) and request timeouts via `AbortController`.
- Evaluates redirects safely with maximum redirect limits (default 3), ensuring redirects cannot target blocked SSRF endpoints.
- Records HTTP probe outcome (`healthy`, `unhealthy`, `timeout`, `error`) without claiming that an HTTP status proves the entire application is healthy.

### 3. Trace, Log, and Alert Inspectors
- Return typed `available: false` and `complete: false` evidence with diagnostic code `BACKEND_UNCONFIGURED`.
- Never generate synthetic data or classify missing telemetry as an automatic gap.

## Security Controls
- **URL Validation**: Rejects malformed URLs and non-HTTP/HTTPS protocols.
- **SSRF Protection**: By default, blocks loopback (`127.0.0.0/8`, `localhost`, `::1`), private RFC 1918 networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), unique local IPv6 (`fc00::/7`), and link-local/cloud metadata (`169.254.0.0/16`, `fe80::/10`, `metadata.google.internal`).
- **Alternative Encodings**: Evaluates and blocks alternative numeric IPv4 representations (decimal integers, hex, octal) and IPv4-mapped IPv6 addresses (`::ffff:x.x.x.x`).
- **Credential & Query Redaction**: Strips embedded username/password authority credentials and automatically redacts sensitive query parameters (e.g. `token`, `key`, `secret`, `auth`, `password`) in all persisted target provenance and diagnostic outputs.
- **Incremental Stream Limits**: Enforces `maxResponseBytes` via incremental stream chunks, canceling the stream reader immediately upon exceeding the threshold to prevent unbounded memory consumption on chunked responses without `Content-Length`.
- **Bounded Redirects**: Re-validates every redirect hop against the SSRF and protocol policy, enforcing a maximum redirect budget to prevent redirect loops or metadata bypass.

## Evidence Contract
Every inspector returns an `InspectorEvidence<T>` record:
- `signal`: `metric`, `log`, `trace`, `health`, or `alert`
- `requirementId`: identifier of the requirement evaluated
- `collectedAt`: ISO-8601 timestamp of collection
- `available`: boolean indicating if target/adapter produced an evidence response
- `complete`: boolean indicating if evidence satisfies observation criteria
- `provenance`: `{ target, adapter, source? }`
- `data`: typed signal-specific payload
- `diagnostics`: list of `{ code, severity, message }`

## Limitations
- No gap detection or policy evaluation (deferred to Phase 05).
- No automated remediation or PR generation (deferred to Phase 07).
- No database persistence or REST APIs (deferred to Phase 06).
- Trace backends (e.g. Jaeger/Tempo), log backends, and alert managers are not integrated in Phase 04 and return explicit `BACKEND_UNCONFIGURED` states.
- **DNS Resolution & Rebinding**: The SSRF policy operates at the URL parsing/hostname layer. It does not perform pre-flight DNS pinning or socket-level IP binding; DNS rebinding protections require custom network agent dispatchers deferred to Phase 11.
