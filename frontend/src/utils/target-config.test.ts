import { describe, expect, it } from "vitest";
import { localPhase01TargetExample, validateTelemetryTargetConfig } from "./target-config";

describe("telemetry target configuration", () => {
  it("accepts supported HTTP telemetry targets and requirement-specific metric settings", () => {
    expect(validateTelemetryTargetConfig({
      prometheusBaseUrl: "http://127.0.0.1:9090", healthBaseUrl: "http://127.0.0.1:3000", traceBackendUrl: "http://127.0.0.1:16686",
      metricConfigs: { requests: { serviceName: "demo-service", route: "/api/demo", method: "GET", minimumCount: 1, maxEvidenceAgeMs: 60_000 } }
    })).toBeNull();
  });
  it("rejects malformed URLs, unsupported protocols and unimplemented target types", () => {
    expect(validateTelemetryTargetConfig({ prometheusBaseUrl: "not a url" })).toMatch(/valid HTTP/);
    expect(validateTelemetryTargetConfig({ healthBaseUrl: "ftp://example.test/" })).toMatch(/HTTP\(S\)/);
    expect(validateTelemetryTargetConfig({ traceBackendUrl: "ftp://jaeger:16686" })).toMatch(/HTTP\(S\)/);
  });
  it("rejects secrets and incomplete metric rules and constructs the local lab example from metric IDs", () => {
    expect(validateTelemetryTargetConfig({ prometheusBaseUrl: "http://user:password@localhost:9090" })).toMatch(/credentials/);
    expect(validateTelemetryTargetConfig({ metricConfigs: { requests: { serviceName: "", route: "api", minimumCount: -1, maxEvidenceAgeMs: 0 } } })).toMatch(/Invalid metric config/);
    expect(localPhase01TargetExample({ requirements: [{ id: "requests", signal: "metric" }, { id: "health", signal: "health" }] })).toEqual({
      prometheusBaseUrl: "http://127.0.0.1:9090", healthBaseUrl: "http://127.0.0.1:3000",
      metricConfigs: { requests: { serviceName: "demo-service", route: "/api/demo", method: "GET", minimumCount: 1, maxEvidenceAgeMs: 60_000 } }
    });
  });
});
