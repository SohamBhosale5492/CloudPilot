import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExpectedAlertRequirement,
  ExpectedHealthCheckRequirement,
  ExpectedLogRequirement,
  ExpectedMetricRequirement,
  ExpectedTraceRequirement
} from "./expected-observability";
import {
  inspectAlert,
  inspectExpectedObservabilityRequirement,
  inspectHealthCheck,
  inspectLog,
  inspectMetric,
  inspectTrace,
  validateAndSanitizeUrl
} from "./inspectors";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { "content-type": "application/json", ...headers }
  });
}

function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { "content-type": "text/plain", ...headers }
  });
}

function chunkedStreamResponse(chunks: string[], status = 200, headers: Record<string, string> = {}): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { "transfer-encoding": "chunked", ...headers }
  });
}

test("validateAndSanitizeUrl validates URLs, redacts credentials and sensitive query parameters", () => {
  const valid = validateAndSanitizeUrl("http://health.example.com/health");
  assert.equal(valid.valid, true);
  assert.equal(valid.sanitizedUrl, "http://health.example.com/health");

  const withCredsAndQuery = validateAndSanitizeUrl(
    "http://admin:secret123@metrics.example.com/data?token=supersecret&key=12345&format=json&auth_token=abc"
  );
  assert.equal(withCredsAndQuery.valid, true);
  assert.ok(!withCredsAndQuery.sanitizedUrl?.includes("admin"));
  assert.ok(!withCredsAndQuery.sanitizedUrl?.includes("secret123"));
  assert.ok(withCredsAndQuery.sanitizedUrl?.includes("token=REDACTED"));
  assert.ok(withCredsAndQuery.sanitizedUrl?.includes("key=REDACTED"));
  assert.ok(withCredsAndQuery.sanitizedUrl?.includes("auth_token=REDACTED"));
  assert.ok(withCredsAndQuery.sanitizedUrl?.includes("format=json"));

  const nonHttp = validateAndSanitizeUrl("gopher://metadata/data");
  assert.equal(nonHttp.valid, false);
  assert.equal(nonHttp.diagnosticCode, "TARGET_INVALID");

  const invalidPort = validateAndSanitizeUrl("http://health.example.com:99999/health");
  assert.equal(invalidPort.valid, false);
  assert.equal(invalidPort.diagnosticCode, "TARGET_INVALID");
});

test("validateAndSanitizeUrl rejects loopback, private, link-local, and alternative IP representations", () => {
  // Loopback
  assert.equal(validateAndSanitizeUrl("http://127.0.0.1/health").diagnosticCode, "SSRF_BLOCKED");
  assert.equal(validateAndSanitizeUrl("http://localhost/health").diagnosticCode, "SSRF_BLOCKED");
  assert.equal(validateAndSanitizeUrl("http://[::1]/health").diagnosticCode, "SSRF_BLOCKED");

  // Private RFC 1918
  assert.equal(validateAndSanitizeUrl("http://10.0.0.1/health").diagnosticCode, "SSRF_BLOCKED");
  assert.equal(validateAndSanitizeUrl("http://172.16.0.1/health").diagnosticCode, "SSRF_BLOCKED");
  assert.equal(validateAndSanitizeUrl("http://172.31.255.1/health").diagnosticCode, "SSRF_BLOCKED");
  assert.equal(validateAndSanitizeUrl("http://192.168.1.1/health").diagnosticCode, "SSRF_BLOCKED");

  // Link-local / metadata
  assert.equal(validateAndSanitizeUrl("http://169.254.169.254/latest").diagnosticCode, "SSRF_BLOCKED");
  assert.equal(validateAndSanitizeUrl("http://metadata.google.internal/").diagnosticCode, "SSRF_BLOCKED");

  // Alternative IPv4 integer/hex/octal encodings
  assert.equal(validateAndSanitizeUrl("http://2852039166/health").diagnosticCode, "SSRF_BLOCKED"); // 169.254.169.254
  assert.equal(validateAndSanitizeUrl("http://0xa9fea9fe/health").diagnosticCode, "SSRF_BLOCKED"); // 169.254.169.254
  assert.equal(validateAndSanitizeUrl("http://2130706433/health").diagnosticCode, "SSRF_BLOCKED"); // 127.0.0.1
  assert.equal(validateAndSanitizeUrl("http://0x7f000001/health").diagnosticCode, "SSRF_BLOCKED"); // 127.0.0.1

  // IPv4-mapped IPv6
  assert.equal(validateAndSanitizeUrl("http://[::ffff:169.254.169.254]/health").diagnosticCode, "SSRF_BLOCKED");
  assert.equal(validateAndSanitizeUrl("http://[::ffff:127.0.0.1]/health").diagnosticCode, "SSRF_BLOCKED");

  // When allowPrivateIps is explicitly enabled, private/loopback are allowed but metadata remains blocked
  assert.equal(validateAndSanitizeUrl("http://127.0.0.1/health", { allowPrivateIps: true }).valid, true);
  assert.equal(validateAndSanitizeUrl("http://10.0.0.1/health", { allowPrivateIps: true }).valid, true);
  assert.equal(validateAndSanitizeUrl("http://169.254.169.254/latest", { allowPrivateIps: true }).diagnosticCode, "SSRF_BLOCKED");
});

test("inspectHealthCheck produces healthy evidence on 200 OK", async () => {
  const requirement: ExpectedHealthCheckRequirement = {
    id: "health-http-demo",
    signal: "health",
    kind: "http",
    endpoint: "/healthz"
  };

  const mockFetch: typeof fetch = async (url) => {
    assert.equal(url, "http://health.example.com:8080/healthz");
    return textResponse("OK", 200);
  };

  const evidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    fetchImpl: mockFetch
  });

  assert.equal(evidence.signal, "health");
  assert.equal(evidence.requirementId, "health-http-demo");
  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.data?.statusCode, 200);
  assert.equal(evidence.data?.probeOutcome, "healthy");
  assert.equal(evidence.diagnostics.length, 0);
  assert.ok(typeof evidence.data?.latencyMs === "number");
});

test("inspectHealthCheck reports unhealthy outcome and STATUS_ERROR on non-2xx HTTP responses", async () => {
  const requirement: ExpectedHealthCheckRequirement = {
    id: "health-http-demo",
    signal: "health",
    kind: "http",
    endpoint: "/healthz"
  };

  const mockFetch: typeof fetch = async () => {
    return textResponse("Internal Error", 500);
  };

  const evidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    fetchImpl: mockFetch
  });

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.data?.statusCode, 500);
  assert.equal(evidence.data?.probeOutcome, "unhealthy");
  assert.equal(evidence.diagnostics[0]?.code, "STATUS_ERROR");
});

test("inspectHealthCheck reports PROBE_TIMEOUT when request exceeds configured timeout", async () => {
  const requirement: ExpectedHealthCheckRequirement = {
    id: "health-http-timeout",
    signal: "health",
    kind: "http",
    endpoint: "/healthz"
  };

  const mockFetch: typeof fetch = async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };

  const evidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    timeoutMs: 20,
    fetchImpl: mockFetch
  });

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.data?.probeOutcome, "timeout");
  assert.equal(evidence.diagnostics[0]?.code, "PROBE_TIMEOUT");
});

test("inspectHealthCheck reports PROBE_FAILED on network connection errors", async () => {
  const requirement: ExpectedHealthCheckRequirement = {
    id: "health-http-net-err",
    signal: "health",
    kind: "http",
    endpoint: "/healthz"
  };

  const mockFetch: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  const evidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    fetchImpl: mockFetch
  });

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.data?.probeOutcome, "error");
  assert.equal(evidence.diagnostics[0]?.code, "PROBE_FAILED");
});

test("inspectHealthCheck handles relative redirects, safe redirects, and SSRF traps during redirects", async () => {
  const requirement: ExpectedHealthCheckRequirement = {
    id: "health-http-redirect",
    signal: "health",
    kind: "http",
    endpoint: "/api/check"
  };

  // Safe relative redirect test (resolving ../v1/health from /api/check)
  let callCount = 0;
  const mockFetchSafe: typeof fetch = async (url) => {
    callCount += 1;
    if (callCount === 1) {
      assert.equal(url, "http://health.example.com:8080/api/check");
      return textResponse("Redirecting", 302, { location: "../v1/health" });
    }
    assert.equal(url, "http://health.example.com:8080/v1/health");
    return textResponse("OK", 200);
  };

  const safeEvidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    maxRedirects: 2,
    fetchImpl: mockFetchSafe
  });

  assert.equal(safeEvidence.available, true);
  assert.equal(safeEvidence.complete, true);
  assert.equal(safeEvidence.data?.statusCode, 200);

  // SSRF redirect trap test (redirect pointing to metadata service)
  const mockFetchSsrf: typeof fetch = async () => {
    return textResponse("Redirect to metadata", 302, { location: "http://169.254.169.254/secret" });
  };

  const ssrfEvidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    maxRedirects: 2,
    fetchImpl: mockFetchSsrf
  });

  assert.equal(ssrfEvidence.available, false);
  assert.equal(ssrfEvidence.complete, false);
  assert.equal(ssrfEvidence.diagnostics[0]?.code, "SSRF_BLOCKED");

  // Alternating redirect loop test (/a -> /b -> /a)
  let loopHop = 0;
  const mockFetchLoop: typeof fetch = async () => {
    loopHop += 1;
    const nextPath = loopHop % 2 === 1 ? "/b" : "/a";
    return textResponse("Redirecting", 302, { location: `http://health.example.com:8080${nextPath}` });
  };

  const loopEvidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    maxRedirects: 2,
    fetchImpl: mockFetchLoop
  });

  assert.equal(loopEvidence.available, false);
  assert.equal(loopEvidence.complete, false);
  assert.equal(loopEvidence.diagnostics[0]?.code, "REDIRECT_LIMIT_EXCEEDED");
});

test("inspectHealthCheck enforces maxResponseBytes on chunked streaming responses without Content-Length", async () => {
  const requirement: ExpectedHealthCheckRequirement = {
    id: "health-http-stream",
    signal: "health",
    kind: "http",
    endpoint: "/stream"
  };

  // 10 chunks of 100 bytes = 1000 bytes, limit is 300 bytes
  const chunks = Array.from({ length: 10 }, () => "x".repeat(100));
  const mockFetch: typeof fetch = async () => {
    return chunkedStreamResponse(chunks, 200);
  };

  const evidence = await inspectHealthCheck({
    baseUrl: "http://health.example.com:8080",
    requirement,
    maxResponseBytes: 300,
    fetchImpl: mockFetch
  });

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.diagnostics[0]?.code, "RESPONSE_TOO_LARGE");
});

test("inspectMetric queries Prometheus and returns typed evidence reusing Prometheus adapter", async () => {
  const requirement: ExpectedMetricRequirement = {
    id: "metric-req-test",
    signal: "metric",
    metricName: "demo_http_server_requests_total",
    dimensions: ["method", "route", "status_code"]
  };

  const now = new Date("2026-10-14T00:00:00.000Z");

  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("query_range")) {
      return jsonResponse({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { job: "otel-collector", instance: "otel-collector:8889" },
              values: [
                [now.getTime() / 1000 - 60, String(now.getTime() / 1000 - 60)],
                [now.getTime() / 1000 - 55, String(now.getTime() / 1000 - 55)],
                [now.getTime() / 1000 - 50, String(now.getTime() / 1000 - 50)],
                [now.getTime() / 1000 - 45, String(now.getTime() / 1000 - 45)],
                [now.getTime() / 1000 - 40, String(now.getTime() / 1000 - 40)],
                [now.getTime() / 1000 - 35, String(now.getTime() / 1000 - 35)],
                [now.getTime() / 1000 - 30, String(now.getTime() / 1000 - 30)],
                [now.getTime() / 1000 - 25, String(now.getTime() / 1000 - 25)],
                [now.getTime() / 1000 - 20, String(now.getTime() / 1000 - 20)],
                [now.getTime() / 1000 - 15, String(now.getTime() / 1000 - 15)],
                [now.getTime() / 1000 - 10, String(now.getTime() / 1000 - 10)],
                [now.getTime() / 1000 - 5, String(now.getTime() / 1000 - 5)],
                [now.getTime() / 1000, String(now.getTime() / 1000)]
              ]
            }
          ]
        }
      });
    }

    return jsonResponse({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: {
              __name__: "demo_http_server_requests_total",
              exported_job: "demo-service",
              job: "otel-collector",
              instance: "otel-collector:8889",
              route: "/api/demo",
              method: "GET",
              status_code: "200"
            },
            value: [now.getTime() / 1000, "42"]
          }
        ]
      }
    });
  };

  const evidence = await inspectMetric({
    baseUrl: "http://prometheus.example.com:9090",
    requirement,
    serviceName: "demo-service",
    route: "/api/demo",
    evaluatedAt: now,
    collectedAt: now,
    fetchImpl: mockFetch
  });

  assert.equal(evidence.signal, "metric");
  assert.equal(evidence.requirementId, "metric-req-test");
  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.data?.samples.length, 1);
  assert.equal(evidence.data?.samples[0]?.value, 42);
  assert.equal(evidence.diagnostics.length, 0);
});

test("inspectMetric reports METRIC_UNAVAILABLE when Prometheus is unreachable", async () => {
  const requirement: ExpectedMetricRequirement = {
    id: "metric-req-unavail",
    signal: "metric",
    metricName: "demo_metric",
    dimensions: []
  };

  const mockFetch: typeof fetch = async () => {
    throw new Error("Connection refused");
  };

  const evidence = await inspectMetric({
    baseUrl: "http://prometheus.example.com:9090",
    requirement,
    fetchImpl: mockFetch
  });

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.diagnostics[0]?.code, "METRIC_UNAVAILABLE");
});

test("inspectTrace reports unconfigured evidence while log and alert adapters remain unavailable", async () => {
  const traceReq: ExpectedTraceRequirement = {
    id: "trace-req-1",
    signal: "trace",
    serviceName: "demo-service"
  };
  const traceEvidence = await inspectTrace({ requirement: traceReq });
  assert.equal(traceEvidence.signal, "trace");
  assert.equal(traceEvidence.available, false);
  assert.equal(traceEvidence.complete, false);
  assert.equal(traceEvidence.diagnostics[0]?.code, "BACKEND_UNCONFIGURED");

  const logReq: ExpectedLogRequirement = {
    id: "log-req-1",
    signal: "log",
    fields: ["trace_id", "level"]
  };
  const logEvidence = inspectLog({ requirement: logReq });
  assert.equal(logEvidence.signal, "log");
  assert.equal(logEvidence.available, false);
  assert.equal(logEvidence.complete, false);
  assert.equal(logEvidence.diagnostics[0]?.code, "BACKEND_UNCONFIGURED");

  const alertReq: ExpectedAlertRequirement = {
    id: "alert-req-1",
    signal: "alert",
    associatedSignal: "metric",
    condition: "rate > 0.05",
    severity: "critical"
  };
  const alertEvidence = inspectAlert({ requirement: alertReq });
  assert.equal(alertEvidence.signal, "alert");
  assert.equal(alertEvidence.available, false);
  assert.equal(alertEvidence.complete, false);
  assert.equal(alertEvidence.diagnostics[0]?.code, "BACKEND_UNCONFIGURED");
});

test("inspectTrace queries Jaeger for the exact service and safely counts matching traces", async () => {
  const requirement: ExpectedTraceRequirement = { id: "trace-alumni", signal: "trace", serviceName: "secure-alumni-backend" };
  let requested = "";
  const evidence = await inspectTrace({
    requirement, backendUrl: "http://jaeger.example:16686", allowPrivateIps: true,
    fetchImpl: async (input) => {
      requested = String(input);
      return jsonResponse({ data: [
        { spans: [{ spanID: "1" }], processes: { p1: { serviceName: "secure-alumni-backend" } } },
        { spans: [{ spanID: "2" }], processes: { p1: { serviceName: "other-service" } } },
        { spans: [], processes: { p1: { serviceName: "secure-alumni-backend" } } }
      ] });
    }
  });
  assert.match(requested, /\/api\/traces\?/);
  assert.match(requested, /service=secure-alumni-backend/);
  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.data, { serviceName: "secure-alumni-backend", traceCount: 1 });
});

test("inspectTrace rejects malformed and oversized Jaeger results without making a positive claim", async () => {
  const requirement: ExpectedTraceRequirement = { id: "trace-malformed", signal: "trace", serviceName: "api" };
  const malformed = await inspectTrace({ requirement, backendUrl: "http://jaeger.example:16686", fetchImpl: async () => textResponse("not-json") });
  assert.equal(malformed.complete, false);
  assert.equal(malformed.diagnostics[0]?.code, "STATUS_ERROR");
  const oversized = await inspectTrace({ requirement, backendUrl: "http://jaeger.example:16686", maxResponseBytes: 4, fetchImpl: async () => textResponse('{"data":[]}') });
  assert.equal(oversized.complete, false);
  assert.equal(oversized.diagnostics[0]?.code, "RESPONSE_TOO_LARGE");
});

test("inspectExpectedObservabilityRequirement dispatches correctly across signal families", async () => {
  const healthReq: ExpectedHealthCheckRequirement = {
    id: "health-dispatch",
    signal: "health",
    kind: "http",
    endpoint: "/health"
  };

  const mockFetch: typeof fetch = async () => textResponse("OK", 200);

  const evidence = await inspectExpectedObservabilityRequirement(healthReq, {
    healthBaseUrl: "http://health.example.com:8080",
    fetchImpl: mockFetch
  });

  assert.equal(evidence.signal, "health");
  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
});

test("missing Prometheus and health targets return unconfigured evidence without contacting placeholder hosts", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; throw new Error("must not fetch"); };
  const metric = await inspectExpectedObservabilityRequirement({
    id: "metric-unconfigured", signal: "metric", metricName: "http_requests_total", dimensions: []
  }, { fetchImpl });
  const health = await inspectExpectedObservabilityRequirement({
    id: "health-unconfigured", signal: "health", kind: "http", endpoint: "/health"
  }, { fetchImpl });

  assert.equal(metric.available, false);
  assert.equal(metric.provenance.target, "<unconfigured>");
  assert.equal(metric.diagnostics[0]?.code, "BACKEND_UNCONFIGURED");
  assert.equal(health.available, false);
  assert.equal(health.provenance.target, "<unconfigured>");
  assert.equal(health.diagnostics[0]?.code, "BACKEND_UNCONFIGURED");
  assert.equal(requests, 0);
});
