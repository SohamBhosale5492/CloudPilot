import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isValidMetricName,
  normalizeOtelCounterName,
  parseMetricsConfig,
  loadMetricsConfig,
  recordMatchingMetrics,
  type ConfiguredMetricRuntime
} from "./metrics-config";

test("isValidMetricName validates according to Prometheus naming rules", () => {
  assert.equal(isValidMetricName("cloudpilot_pr_test_heartbeat_total"), true);
  assert.equal(isValidMetricName("demo_http_server_requests"), true);
  assert.equal(isValidMetricName("app_metric:count"), true);
  assert.equal(isValidMetricName("_private_metric"), true);

  assert.equal(isValidMetricName(""), false);
  assert.equal(isValidMetricName("123_invalid_start"), false);
  assert.equal(isValidMetricName("has-dashes"), false);
  assert.equal(isValidMetricName("has spaces"), false);
  assert.equal(isValidMetricName("a".repeat(201)), false);
  assert.equal(isValidMetricName(null), false);
  assert.equal(isValidMetricName(undefined), false);
});

test("normalizeOtelCounterName strips terminal _total suffix", () => {
  assert.equal(normalizeOtelCounterName("cloudpilot_pr_test_heartbeat_total"), "cloudpilot_pr_test_heartbeat");
  assert.equal(normalizeOtelCounterName("requests_total"), "requests");
  assert.equal(normalizeOtelCounterName("custom_metric"), "custom_metric");
  assert.equal(normalizeOtelCounterName("total"), "total");
});

test("parseMetricsConfig handles valid, empty, and malformed YAML", () => {
  const validYaml = `
metrics:
  - name: cloudpilot_pr_test_heartbeat_total
    labels:
      service: demo-service
      route: /api/demo
      method: GET
  - name: generic_heartbeat
`;
  const entries = parseMetricsConfig(validYaml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "cloudpilot_pr_test_heartbeat_total");
  assert.deepEqual(entries[0].labels, {
    service: "demo-service",
    route: "/api/demo",
    method: "GET"
  });
  assert.equal(entries[1].name, "generic_heartbeat");
  assert.equal(entries[1].labels, undefined);

  // Empty or whitespace
  assert.deepEqual(parseMetricsConfig(""), []);
  assert.deepEqual(parseMetricsConfig("   "), []);
  assert.deepEqual(parseMetricsConfig("metrics: []"), []);

  // Malformed YAML
  assert.deepEqual(parseMetricsConfig("invalid: yaml: : ["), []);

  // Non-array metrics
  assert.deepEqual(parseMetricsConfig("metrics: not-an-array"), []);

  // Invalid entries inside array
  const mixedYaml = `
metrics:
  - "string-instead-of-object"
  - name: "invalid name with spaces"
  - name: valid_metric_name
    labels:
      service: 12345
      route: /api/demo
`;
  const mixedEntries = parseMetricsConfig(mixedYaml);
  assert.equal(mixedEntries.length, 1);
  assert.equal(mixedEntries[0].name, "valid_metric_name");
  assert.deepEqual(mixedEntries[0].labels, { route: "/api/demo" });
});

test("recordMatchingMetrics routes increments to matching configured metrics only", () => {
  const addCallsA: Array<{ value: number; attributes?: Record<string, string> }> = [];
  const addCallsB: Array<{ value: number; attributes?: Record<string, string> }> = [];
  const addCallsC: Array<{ value: number; attributes?: Record<string, string> }> = [];

  const configured: ConfiguredMetricRuntime[] = [
    {
      definition: {
        name: "route_specific_total",
        labels: { service: "demo-service", route: "/api/demo", method: "GET" }
      },
      counter: { add: (val: number, attr?: Record<string, string>) => addCallsA.push({ value: val, attributes: attr }) } as any,
      otelMetricName: "route_specific"
    },
    {
      definition: {
        name: "post_only_total",
        labels: { route: "/api/demo", method: "POST" }
      },
      counter: { add: (val: number, attr?: Record<string, string>) => addCallsB.push({ value: val, attributes: attr }) } as any,
      otelMetricName: "post_only"
    },
    {
      definition: {
        name: "catch_all_metric",
        labels: { service: "demo-service" }
      },
      counter: { add: (val: number, attr?: Record<string, string>) => addCallsC.push({ value: val, attributes: attr }) } as any,
      otelMetricName: "catch_all_metric"
    }
  ];

  // Request 1: GET /api/demo 200 -> should match A and C, not B
  recordMatchingMetrics(configured, { route: "/api/demo", method: "GET", statusCode: 200 });

  assert.equal(addCallsA.length, 1);
  assert.deepEqual(addCallsA[0], {
    value: 1,
    attributes: {
      method: "GET",
      route: "/api/demo",
      status_code: "200",
      service: "demo-service"
    }
  });

  assert.equal(addCallsB.length, 0);

  assert.equal(addCallsC.length, 1);
  assert.deepEqual(addCallsC[0], {
    value: 1,
    attributes: {
      method: "GET",
      route: "/api/demo",
      status_code: "200",
      service: "demo-service"
    }
  });

  // Request 2: POST /api/demo 201 -> should match B and C, not A
  recordMatchingMetrics(configured, { route: "/api/demo", method: "POST", statusCode: 201 });
  assert.equal(addCallsA.length, 1);
  assert.equal(addCallsB.length, 1);
  assert.equal(addCallsC.length, 2);

  // Request 3: GET /health 200 -> should match C only (no route/method filter), not A or B
  recordMatchingMetrics(configured, { route: "/health", method: "GET", statusCode: 200 });
  assert.equal(addCallsA.length, 1);
  assert.equal(addCallsB.length, 1);
  assert.equal(addCallsC.length, 3);
});

test("loadMetricsConfig loads from file path and returns empty on non-existent path", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-metrics-test-"));
  const tmpFile = path.join(tmpDir, "metrics.yaml");

  try {
    fs.writeFileSync(
      tmpFile,
      `
metrics:
  - name: test_runtime_metric_total
    labels:
      service: demo-service
      route: /api/demo
`
    );

    const loaded = loadMetricsConfig(tmpFile);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].definition.name, "test_runtime_metric_total");
    assert.equal(loaded[0].otelMetricName, "test_runtime_metric");
    assert.equal(typeof loaded[0].counter.add, "function");

    // Non-existent path returns empty array
    const missing = loadMetricsConfig(path.join(tmpDir, "non_existent.yaml"));
    assert.deepEqual(missing, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
