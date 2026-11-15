import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTracingConfig, parseTracingConfig } from "./tracing-config";

test("parseTracingConfig parses enabled tracing and propagators", () => {
  const cfg = parseTracingConfig(`
tracing:
  enabled: true
  service_name: demo-service
  propagators:
    - tracecontext
    - baggage
  sample_ratio: 0.5
`);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.serviceName, "demo-service");
  assert.deepEqual(cfg.propagators, ["tracecontext", "baggage"]);
  assert.equal(cfg.sampleRatio, 0.5);
  assert.equal(cfg.configured, true);
});

test("parseTracingConfig handles disabled tracing and malformed YAML safely", () => {
  const disabled = parseTracingConfig(`
tracing:
  enabled: false
  propagators: []
`);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.propagators, []);
  assert.equal(disabled.configured, true);

  const malformed = parseTracingConfig("not: [valid: yaml");
  assert.equal(malformed.enabled, true);
  assert.equal(malformed.configured, false);
});

test("loadTracingConfig loads explicit path and falls back on missing explicit path", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tracing-test-"));
  const tmpFile = path.join(tmpDir, "tracing.yaml");
  try {
    fs.writeFileSync(
      tmpFile,
      `
tracing:
  enabled: false
  service_name: custom-svc
`
    );
    const loaded = loadTracingConfig(tmpFile);
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.serviceName, "custom-svc");

    const missing = loadTracingConfig(path.join(tmpDir, "missing.yaml"));
    assert.equal(missing.configured, false);
    assert.equal(missing.enabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
