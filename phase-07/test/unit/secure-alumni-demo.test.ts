import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExpectedObservability } from "../../../phase-01/demo-service/src/expected-observability";
import { evaluateExpectedObservabilityModel } from "../../../phase-01/demo-service/src/gap-engine";
import { inspectExpectedObservabilityRequirement } from "../../../phase-01/demo-service/src/inspectors";
import { createSecureAlumniDemoInput } from "../../src/demo-secure-alumni";

test("Secure Alumni demo binds the verified request, backend identity, trace and supplied health URL", () => {
  const evaluatedAt = new Date("2026-11-12T10:00:00.000Z");
  const input = createSecureAlumniDemoInput("C:/work/secure-alumni", "http://127.0.0.1:8080/health", evaluatedAt);
  const normalized = normalizeExpectedObservability(input.expectedObservability);

  assert.equal(normalized.status, "valid");
  assert.equal(normalized.model?.serviceId, "secure-alumni-backend");
  assert.deepEqual(normalized.model?.requirements.filter((item) => item.signal === "metric"), [{
    id: "secure-alumni-forgot-password-count",
    signal: "metric",
    metricName: "alumni_http_server_requests_total",
    dimensions: ["exported_job", "method", "route", "status_code"]
  }]);
  assert.deepEqual(normalized.model?.requirements.filter((item) => item.signal === "trace"), [{
    id: "secure-alumni-http-traces",
    signal: "trace",
    serviceName: "secure-alumni-backend"
  }]);
  assert.deepEqual(normalized.model?.requirements.filter((item) => item.signal === "health"), [{
    id: "secure-alumni-health",
    signal: "health",
    kind: "http",
    endpoint: "/health"
  }]);
  assert.deepEqual(input.gapEngine?.metricConfigs?.["secure-alumni-forgot-password-count"], {
    serviceName: "secure-alumni-backend",
    route: "/api/auth/forgot-password",
    method: "POST",
    minimumCount: 1,
    maxEvidenceAgeMs: 120_000
  });
  assert.deepEqual(input.inspector.metricConfigs?.["secure-alumni-forgot-password-count"], input.gapEngine?.metricConfigs?.["secure-alumni-forgot-password-count"]);
  assert.equal(input.inspector.prometheusBaseUrl, "http://127.0.0.1:9090");
  assert.equal(input.inspector.traceBackendUrl, "http://127.0.0.1:16686");
  assert.equal(input.inspector.healthBaseUrl, "http://127.0.0.1:8080");
  assert.equal(input.evaluatedAt, evaluatedAt);
});

for (const scenario of [
  {
    name: "matching Secure Alumni Prometheus series produces PASS",
    result: [{
      metric: {
        exported_job: "secure-alumni-backend",
        route: "/api/auth/forgot-password",
        method: "POST",
        status_code: "200",
        job: "otel-collector",
        instance: "127.0.0.1:8889"
      },
      // This is the response to the existing increase(...[60s]) query, not the raw cumulative counter.
      value: [1794477600, "2"]
    }],
    expected: "pass"
  },
  { name: "complete query with no matching Secure Alumni series produces GAP", result: [], expected: "gap" }
]) {
  test(scenario.name, async () => {
    const evaluatedAt = new Date("2026-11-12T10:00:00.000Z");
    const input = createSecureAlumniDemoInput("C:/work/secure-alumni", "http://127.0.0.1:8080/health", evaluatedAt);
    const normalized = normalizeExpectedObservability(input.expectedObservability);
    assert.equal(normalized.status, "valid");
    const metricRequirement = normalized.model?.requirements.find((item) => item.id === "secure-alumni-forgot-password-count");
    assert.ok(metricRequirement);

    const evidence = await inspectExpectedObservabilityRequirement(metricRequirement, {
      ...input.inspector,
      evaluatedAt,
      collectedAt: evaluatedAt,
      fetchImpl: async (request) => {
        const url = new URL(String(request));
        if (url.pathname.endsWith("query_range")) {
          const start = Number(url.searchParams.get("start"));
          const end = Number(url.searchParams.get("end"));
          const values: Array<[number, string]> = [];
          for (let timestamp = start; timestamp <= end; timestamp += 5) values.push([timestamp, String(timestamp)]);
          return Response.json({ status: "success", data: { resultType: "matrix", result: [{ metric: { job: "otel-collector", instance: "127.0.0.1:8889" }, values }] } });
        }
        const query = url.searchParams.get("query") ?? "";
        assert.match(query, /alumni_http_server_requests_total/);
        assert.match(query, /exported_job="secure-alumni-backend"/);
        assert.match(query, /route="\/api\/auth\/forgot-password"/);
        assert.match(query, /method="POST"/);
        assert.match(query, /increase\(.*\[60s\]\)/);
        return Response.json({ status: "success", data: { resultType: "vector", result: scenario.result } });
      }
    });
    const findings = evaluateExpectedObservabilityModel(normalized.model!, [evidence], {
      ...input.gapEngine,
      evaluatedAt
    });
    assert.equal(findings.find((item) => item.requirementId === "secure-alumni-forgot-password-count")?.outcome, scenario.expected);
  });
}

test("Secure Alumni demo rejects non-loopback or credential-bearing health targets", () => {
  assert.throws(() => createSecureAlumniDemoInput("C:/work/secure-alumni", "https://example.com/health"), /must target loopback/);
  assert.throws(() => createSecureAlumniDemoInput("C:/work/secure-alumni", "http://user:pass@127.0.0.1:8080/health"), /must target loopback/);
  assert.throws(() => createSecureAlumniDemoInput("C:/work/secure-alumni", "not-a-url"), /must be a valid local HTTP\(S\) URL/);
});
