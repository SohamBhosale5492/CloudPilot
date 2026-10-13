import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExpectedObservability } from "./expected-observability";

function validFixture() {
  return {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "demo-service",
    requirements: {
      metrics: [
        {
          id: "metric-http-requests",
          signal: "metric",
          metricName: "demo_http_server_requests_total",
          dimensions: ["route", "method", "status_code"]
        }
      ],
      logs: [
        {
          id: "log-request",
          signal: "log",
          fields: ["level", "message", "service.name", "trace_id"]
        }
      ],
      traces: [
        {
          id: "trace-service-identity",
          signal: "trace",
          serviceName: "demo-service"
        }
      ],
      healthChecks: [
        {
          id: "health-http",
          signal: "health",
          kind: "http",
          endpoint: "/health"
        }
      ],
      alerts: [
        {
          id: "alert-error-rate",
          signal: "alert",
          associatedSignal: "metric",
          condition: "5xx_rate > 0.05 for 5m",
          severity: "critical"
        }
      ]
    }
  };
}

test("normalizes a valid expected observability document", () => {
  const result = normalizeExpectedObservability(validFixture());

  assert.equal(result.status, "valid");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.model, {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "demo-service",
    requirements: [
      {
        id: "alert-error-rate",
        signal: "alert",
        associatedSignal: "metric",
        condition: "5xx_rate > 0.05 for 5m",
        severity: "critical"
      },
      {
        id: "health-http",
        signal: "health",
        kind: "http",
        endpoint: "/health"
      },
      {
        id: "log-request",
        signal: "log",
        fields: ["level", "message", "service.name", "trace_id"]
      },
      {
        id: "metric-http-requests",
        signal: "metric",
        metricName: "demo_http_server_requests_total",
        dimensions: ["method", "route", "status_code"]
      },
      {
        id: "trace-service-identity",
        signal: "trace",
        serviceName: "demo-service"
      }
    ]
  });
});

test("reports unsupported schema versions explicitly", () => {
  const input = validFixture();
  input.schemaVersion = "cloudpilot.expected-observability.v2";

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "unsupported");
  assert.equal(result.diagnostics[0].code, "UNSUPPORTED_SCHEMA_VERSION");
  assert.equal(result.model, undefined);
});

test("reports missing required top-level and group fields", () => {
  const result = normalizeExpectedObservability({
    schemaVersion: "cloudpilot.expected-observability.v1",
    requirements: {
      metrics: [],
      logs: [],
      traces: [],
      healthChecks: []
    }
  });

  assert.equal(result.status, "invalid");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.path),
    ["$.serviceId", "$.requirements.alerts"]
  );
});

test("reports invalid requirement fields", () => {
  const input = validFixture();
  input.requirements.metrics[0] = {
    id: "",
    signal: "metric",
    metricName: "",
    dimensions: ["route", ""]
  };

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "invalid");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["INVALID_FIELD", "INVALID_FIELD", "INVALID_FIELD"]
  );
});

test("reports unsupported fields and values without guessing", () => {
  const input = validFixture() as ReturnType<typeof validFixture> & {
    extra?: string;
  };
  input.extra = "ignored?";
  input.requirements.healthChecks[0].kind = "tcp";
  input.requirements.alerts[0].severity = "page";

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "invalid");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["UNSUPPORTED_FIELD", "UNSUPPORTED_VALUE", "UNSUPPORTED_VALUE"]
  );
});

test("reports duplicate requirement identifiers across signal groups", () => {
  const input = validFixture();
  input.requirements.logs[0].id = "metric-http-requests";

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "DUPLICATE_REQUIREMENT_ID"));
});

test("produces deterministic normalization for identical semantic input", () => {
  const left = validFixture();
  const right = validFixture();

  left.requirements.metrics[0].dimensions = ["status_code", "method", "route", "method"];
  right.requirements.metrics[0].dimensions = ["route", "method", "status_code"];
  left.requirements.logs[0].fields = ["trace_id", "level", "message", "service.name"];
  right.requirements.logs[0].fields = ["message", "service.name", "level", "trace_id"];

  assert.deepEqual(
    normalizeExpectedObservability(left),
    normalizeExpectedObservability(right)
  );
});

test("rejects malformed non-object input", () => {
  const result = normalizeExpectedObservability(null);

  assert.equal(result.status, "invalid");
  assert.equal(result.diagnostics[0].code, "MALFORMED_INPUT");

  const arrayResult = normalizeExpectedObservability([]);
  assert.equal(arrayResult.status, "invalid");
  assert.equal(arrayResult.diagnostics[0].code, "MALFORMED_INPUT");
});

test("reports invalid trace, log, health, and alert requirement fields", () => {
  const input = validFixture();
  input.requirements.traces[0] = {
    id: "",
    signal: "trace",
    serviceName: "  "
  };
  input.requirements.logs[0] = {
    id: "log-1",
    signal: "log",
    fields: ["valid", " "]
  };
  input.requirements.healthChecks[0] = {
    id: "health-1",
    signal: "health",
    kind: "http",
    endpoint: ""
  };
  input.requirements.alerts[0] = {
    id: "alert-1",
    signal: "alert",
    associatedSignal: "metric",
    condition: "",
    severity: "critical"
  };

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "invalid");
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("INVALID_FIELD"));
  assert.ok(result.diagnostics.some((d) => d.path === "$.requirements.traces[0].id"));
  assert.ok(result.diagnostics.some((d) => d.path === "$.requirements.traces[0].serviceName"));
  assert.ok(result.diagnostics.some((d) => d.path === "$.requirements.logs[0].fields"));
  assert.ok(result.diagnostics.some((d) => d.path === "$.requirements.healthChecks[0].endpoint"));
  assert.ok(result.diagnostics.some((d) => d.path === "$.requirements.alerts[0].condition"));
});

test("reports duplicate requirement identifiers within the same signal family", () => {
  const input = validFixture();
  input.requirements.metrics.push({
    id: "metric-http-requests",
    signal: "metric",
    metricName: "demo_another_metric",
    dimensions: ["dim1"]
  });

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some((d) => d.code === "DUPLICATE_REQUIREMENT_ID"));
});

test("reports unsupported signal discriminators and extra fields in requirements", () => {
  const input = validFixture();
  (input.requirements.metrics[0] as unknown as Record<string, unknown>).signal = "invalid-signal";
  (input.requirements.logs[0] as unknown as Record<string, unknown>).unexpectedProp = "extra";

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some((d) => d.code === "UNSUPPORTED_VALUE" && d.path === "$.requirements.metrics[0].signal"));
  assert.ok(result.diagnostics.some((d) => d.code === "UNSUPPORTED_FIELD" && d.path === "$.requirements.logs[0].unexpectedProp"));
});

test("reports non-object items and non-array collections inside requirements", () => {
  const input = validFixture();
  (input.requirements.metrics as unknown[])[0] = "not-an-object";
  (input.requirements.logs as unknown[])[0] = {
    id: "log-bad-fields",
    signal: "log",
    fields: "not-an-array"
  };

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some((d) => d.code === "INVALID_FIELD" && d.path === "$.requirements.metrics[0]"));
  assert.ok(result.diagnostics.some((d) => d.code === "INVALID_FIELD" && d.path === "$.requirements.logs[0].fields"));
});

test("normalizes empty requirement groups successfully", () => {
  const input = {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "empty-service",
    requirements: {
      metrics: [],
      logs: [],
      traces: [],
      healthChecks: [],
      alerts: []
    }
  };

  const result = normalizeExpectedObservability(input);

  assert.equal(result.status, "valid");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.model, {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "empty-service",
    requirements: []
  });
});

