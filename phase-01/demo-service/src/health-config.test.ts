import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findMatchingHealthCheck,
  isValidHealthEndpoint,
  loadHealthChecksConfig,
  parseHealthChecksConfig
} from "./health-config";

test("isValidHealthEndpoint validates safe endpoint paths", () => {
  assert.equal(isValidHealthEndpoint("/health"), true);
  assert.equal(isValidHealthEndpoint("/ready"), true);
  assert.equal(isValidHealthEndpoint("/healthz"), true);
  assert.equal(isValidHealthEndpoint("/api/v1/health"), true);

  assert.equal(isValidHealthEndpoint(""), false);
  assert.equal(isValidHealthEndpoint("no-leading-slash"), false);
  assert.equal(isValidHealthEndpoint("/../etc/passwd"), false);
  assert.equal(isValidHealthEndpoint("/double//slash"), false);
  assert.equal(isValidHealthEndpoint(null), false);
});

test("parseHealthChecksConfig handles valid, default endpoint, empty, and malformed YAML", () => {
  const validYaml = `
health_checks:
  - service: demo-service
    endpoint: /ready
  - service: default-endpoint-svc
`;
  const checks = parseHealthChecksConfig(validYaml);
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0], { service: "demo-service", endpoint: "/ready" });
  assert.deepEqual(checks[1], { service: "default-endpoint-svc", endpoint: "/health" });

  assert.deepEqual(parseHealthChecksConfig(""), []);
  assert.deepEqual(parseHealthChecksConfig("health_checks: []"), []);
  assert.deepEqual(parseHealthChecksConfig("invalid: yaml: : ["), []);
  assert.deepEqual(parseHealthChecksConfig("health_checks: not-an-array"), []);

  const invalidEntries = `
health_checks:
  - service: ""
  - service: bad-endpoint
    endpoint: /../escape
  - service: valid-svc
    endpoint: /healthz
`;
  assert.deepEqual(parseHealthChecksConfig(invalidEntries), [
    { service: "valid-svc", endpoint: "/healthz" }
  ]);
});

test("loadHealthChecksConfig and findMatchingHealthCheck work with file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-health-test-"));
  const tmpFile = path.join(tmpDir, "health-checks.yaml");

  try {
    fs.writeFileSync(
      tmpFile,
      `
health_checks:
  - service: demo-service
    endpoint: /ready
`
    );

    const loaded = loadHealthChecksConfig(tmpFile);
    assert.deepEqual(loaded, [{ service: "demo-service", endpoint: "/ready" }]);
    assert.deepEqual(findMatchingHealthCheck(loaded, "/ready"), {
      service: "demo-service",
      endpoint: "/ready"
    });
    assert.equal(findMatchingHealthCheck(loaded, "/unknown"), null);

    assert.deepEqual(loadHealthChecksConfig(path.join(tmpDir, "missing.yaml")), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
