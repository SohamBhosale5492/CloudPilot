import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExpectedAlertRequirement,
  ExpectedHealthCheckRequirement,
  ExpectedLogRequirement,
  ExpectedMetricRequirement,
  ExpectedObservabilityModel,
  ExpectedTraceRequirement
} from "./expected-observability";
import type { HealthEvidenceData, InspectorEvidence, MetricEvidenceData } from "./inspectors";
import {
  alertGapRule,
  evaluateExpectedObservabilityModel,
  evaluateGap,
  healthGapRule,
  logGapRule,
  metricGapRule,
  traceGapRule,
  type GapEngineConfig,
  type MetricEvaluationConfig
} from "./gap-engine";

// ─── Shared fixture values ─────────────────────────────────────────────────────

/** Fixed evaluation time used across all fixture tests for determinism. */
const NOW = new Date("2026-10-14T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const FIVE_MINUTES_MS = 5 * 60 * 1000;

// ─── Metric fixtures ───────────────────────────────────────────────────────────

const metricReq: ExpectedMetricRequirement = {
  id: "metric-req-1",
  signal: "metric",
  metricName: "http_requests_total",
  dimensions: ["method", "route", "status_code"]
};

const standardMetricConfig: MetricEvaluationConfig = {
  serviceName: "my-service",
  route: "/api/data",
  minimumCount: 1,
  maxEvidenceAgeMs: FIVE_MINUTES_MS
};

function makeMetricEvidence(
  overrides: Partial<InspectorEvidence<MetricEvidenceData>> = {}
): InspectorEvidence<MetricEvidenceData> {
  return {
    signal: "metric",
    requirementId: "metric-req-1",
    collectedAt: NOW_ISO,
    available: true,
    complete: true,
    provenance: {
      target: "http://prometheus.example.com:9090",
      adapter: "prometheus",
      source: "prometheus"
    },
    data: {
      samples: [
        {
          metricName: "http_requests_total",
          labels: {
            serviceName: "my-service",
            route: "/api/data",
            method: "GET",
            statusCode: "200"
          },
          value: 42
        }
      ],
      source: "prometheus"
    },
    diagnostics: [],
    ...overrides
  };
}

// ─── Health fixtures ───────────────────────────────────────────────────────────

const healthReq: ExpectedHealthCheckRequirement = {
  id: "health-req-1",
  signal: "health",
  kind: "http",
  endpoint: "/healthz"
};

function makeHealthEvidence(
  overrides: Partial<InspectorEvidence<HealthEvidenceData>> = {}
): InspectorEvidence<HealthEvidenceData> {
  return {
    signal: "health",
    requirementId: "health-req-1",
    collectedAt: NOW_ISO,
    available: true,
    complete: true,
    provenance: {
      target: "http://service.example.com/healthz",
      adapter: "http-health-probe"
    },
    data: {
      endpoint: "/healthz",
      statusCode: 200,
      statusText: "OK",
      latencyMs: 25,
      probeOutcome: "healthy"
    },
    diagnostics: [],
    ...overrides
  };
}

// ─── Unconfigured-signal fixtures ──────────────────────────────────────────────

function makeUnconfiguredEvidence(
  signal: "log" | "trace" | "alert",
  requirementId: string
): InspectorEvidence {
  return {
    signal,
    requirementId,
    collectedAt: NOW_ISO,
    available: false,
    complete: false,
    provenance: { target: "<unconfigured>", adapter: `unconfigured-${signal}-adapter` },
    data: { reason: `${signal} backend adapter is not configured.` },
    diagnostics: [
      {
        code: "BACKEND_UNCONFIGURED",
        severity: "info",
        message: `${signal.charAt(0).toUpperCase()}${signal.slice(1)} inspection backend is not configured in Phase 04.`
      }
    ]
  };
}

// ─── Metric tests ──────────────────────────────────────────────────────────────

test("metric gap rule: pass when complete evidence meets minimumCount threshold", () => {
  const config: GapEngineConfig = {
    metricConfigs: { "metric-req-1": standardMetricConfig },
    evaluatedAt: NOW
  };
  const finding = evaluateGap(metricReq, makeMetricEvidence(), config);

  assert.equal(finding.outcome, "pass");
  assert.equal(finding.signal, "metric");
  assert.equal(finding.requirementId, "metric-req-1");
  assert.equal(finding.rule.id, metricGapRule.id);
  assert.ok(finding.id.startsWith(metricGapRule.id));
  assert.equal(finding.evidenceProvenance.adapter, "prometheus");
});

test("metric gap rule: gap when complete evidence has zero matching samples (false-negative challenge — must not return unknown)", () => {
  // Challenge: complete evidence with no matching samples must produce gap, not unknown.
  // A naive implementation that checks only `available` would miss this.
  const evidence = makeMetricEvidence({
    available: true,
    complete: true,
    data: {
      samples: [
        {
          metricName: "unrelated_metric",
          labels: { serviceName: "other-service", route: "/other", method: "POST" },
          value: 99
        }
      ],
      source: "prometheus"
    }
  });
  const config: GapEngineConfig = {
    metricConfigs: { "metric-req-1": standardMetricConfig },
    evaluatedAt: NOW
  };

  const finding = evaluateGap(metricReq, evidence, config);

  assert.equal(finding.outcome, "gap");
  assert.ok(finding.observed.toLowerCase().includes("no matching"), `observed: ${finding.observed}`);
});

test("metric gap rule: unknown when evidence is unavailable", () => {
  const evidence = makeMetricEvidence({ available: false, complete: false, data: undefined });
  const config: GapEngineConfig = {
    metricConfigs: { "metric-req-1": standardMetricConfig },
    evaluatedAt: NOW
  };

  const finding = evaluateGap(metricReq, evidence, config);

  assert.equal(finding.outcome, "unknown");
});

test("metric gap rule: unknown when evidence is incomplete", () => {
  const evidence = makeMetricEvidence({ available: true, complete: false });
  const config: GapEngineConfig = {
    metricConfigs: { "metric-req-1": standardMetricConfig },
    evaluatedAt: NOW
  };

  const finding = evaluateGap(metricReq, evidence, config);

  assert.equal(finding.outcome, "unknown");
});

test("metric gap rule: unknown when no metric config is provided for the requirement", () => {
  // No metricConfigs at all — should not silently default, must return unknown
  const config: GapEngineConfig = { evaluatedAt: NOW };

  const finding = evaluateGap(metricReq, makeMetricEvidence(), config);

  assert.equal(finding.outcome, "unknown");
  assert.ok(
    finding.reason.toLowerCase().includes("metricconfigs"),
    `reason should mention metricConfigs: ${finding.reason}`
  );
});

test("metric gap rule: inconclusive when evidence is stale", () => {
  const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
  const evidence = makeMetricEvidence({ collectedAt: tenMinutesAgo });
  const config: GapEngineConfig = {
    metricConfigs: {
      "metric-req-1": { ...standardMetricConfig, maxEvidenceAgeMs: FIVE_MINUTES_MS }
    },
    evaluatedAt: NOW
  };

  const finding = evaluateGap(metricReq, evidence, config);

  assert.equal(finding.outcome, "inconclusive");
  assert.ok(finding.observed.toLowerCase().includes("age"), `observed: ${finding.observed}`);
});

test("metric gap rule: inconclusive when metric config has invalid fields", () => {
  const config: GapEngineConfig = {
    metricConfigs: {
      "metric-req-1": {
        serviceName: "",
        route: "/api/data",
        minimumCount: 1,
        maxEvidenceAgeMs: FIVE_MINUTES_MS
      }
    },
    evaluatedAt: NOW
  };

  const finding = evaluateGap(metricReq, makeMetricEvidence(), config);

  assert.equal(finding.outcome, "inconclusive");
});

test("metric gap rule: inconclusive when evidence source is not prometheus or synthetic-fixture", () => {
  const evidence = makeMetricEvidence({
    provenance: { target: "http://prometheus.example.com:9090", adapter: "prometheus", source: "unknown-source" }
  });
  const config: GapEngineConfig = {
    metricConfigs: { "metric-req-1": standardMetricConfig },
    evaluatedAt: NOW
  };

  const finding = evaluateGap(metricReq, evidence, config);

  assert.equal(finding.outcome, "inconclusive");
  assert.ok(finding.observed.toLowerCase().includes("source"), `observed: ${finding.observed}`);
});

// ─── Health tests ──────────────────────────────────────────────────────────────

test("health gap rule: pass when probe returns healthy and evidence is fresh", () => {
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, makeHealthEvidence(), config);

  assert.equal(finding.outcome, "pass");
  assert.equal(finding.signal, "health");
  assert.equal(finding.rule.id, healthGapRule.id);
  assert.ok(finding.observed.includes("200"));
});

test("health gap rule: gap when probe returns unhealthy and evidence is fresh", () => {
  const evidence = makeHealthEvidence({
    available: true,
    complete: true,
    data: {
      endpoint: "/healthz",
      statusCode: 503,
      statusText: "Service Unavailable",
      latencyMs: 12,
      probeOutcome: "unhealthy"
    },
    diagnostics: [{ code: "STATUS_ERROR", severity: "warning", message: "Non-2xx status." }]
  });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.equal(finding.outcome, "gap");
  assert.ok(finding.observed.includes("503"), `observed: ${finding.observed}`);
  assert.ok(finding.reason.toLowerCase().includes("confirmed gap"));
});

test("health gap rule: unknown when healthy probe evidence is incomplete (must not pass)", () => {
  const evidence = makeHealthEvidence({
    available: true,
    complete: false,
    data: {
      endpoint: "/healthz",
      statusCode: 200,
      statusText: "OK",
      latencyMs: 25,
      probeOutcome: "healthy"
    }
  });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.notEqual(finding.outcome, "pass");
  assert.equal(finding.outcome, "unknown");
  assert.ok(finding.observed.toLowerCase().includes("incomplete"), `observed: ${finding.observed}`);
});

test("health gap rule: inconclusive when incomplete probe evidence is stale", () => {
  const elevenMinutesAgo = new Date(NOW.getTime() - 11 * 60 * 1000).toISOString();
  const evidence = makeHealthEvidence({
    available: true,
    complete: false,
    collectedAt: elevenMinutesAgo,
    data: {
      endpoint: "/healthz",
      statusCode: 200,
      statusText: "OK",
      latencyMs: 25,
      probeOutcome: "healthy"
    }
  });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.equal(finding.outcome, "inconclusive");
  assert.ok(finding.observed.toLowerCase().includes("age"), `observed: ${finding.observed}`);
});

test("health gap rule: unknown when evidence is unavailable", () => {
  const evidence = makeHealthEvidence({
    available: false,
    complete: false,
    data: undefined
  });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.equal(finding.outcome, "unknown");
});

test("health gap rule: unknown when probe timed out", () => {
  // When available=false (as the inspector sets for timeout), the engine returns unknown
  // via the availability guard. The probeOutcome "timeout" branch is reached only when
  // available=true, which does not occur in practice for timed-out probes.
  const evidence = makeHealthEvidence({
    available: false,
    complete: false,
    data: { endpoint: "/healthz", latencyMs: 5000, probeOutcome: "timeout" },
    diagnostics: [{ code: "PROBE_TIMEOUT", severity: "error", message: "Timed out." }]
  });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.equal(finding.outcome, "unknown");
  // The unavailability guard fires before probeOutcome is inspected
  assert.ok(finding.observed.toLowerCase().includes("unavailable"), `observed: ${finding.observed}`);
});

test("health gap rule: unknown when probe encountered a network error", () => {
  const evidence = makeHealthEvidence({
    available: false,
    complete: false,
    data: { endpoint: "/healthz", latencyMs: 0, probeOutcome: "error" },
    diagnostics: [{ code: "PROBE_FAILED", severity: "error", message: "Connection refused." }]
  });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.equal(finding.outcome, "unknown");
});

test("health gap rule: inconclusive when evidence is stale (false-positive challenge — stale healthy probe must not pass)", () => {
  // Challenge: stale evidence with a healthy probe outcome must NOT produce pass.
  // A naive check of only probeOutcome would return pass, hiding stale data.
  const elevenMinutesAgo = new Date(NOW.getTime() - 11 * 60 * 1000).toISOString();
  const evidence = makeHealthEvidence({ collectedAt: elevenMinutesAgo });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.equal(finding.outcome, "inconclusive");
  assert.ok(finding.observed.toLowerCase().includes("age"), `observed: ${finding.observed}`);
});

test("health gap rule: inconclusive when maxHealthEvidenceAgeMs is not configured", () => {
  // Without a freshness threshold, pass and gap verdicts cannot be safely issued.
  const config: GapEngineConfig = { evaluatedAt: NOW };

  const finding = evaluateGap(healthReq, makeHealthEvidence(), config);

  assert.equal(finding.outcome, "inconclusive");
  assert.ok(
    finding.reason.toLowerCase().includes("maxhealthevidenceagems"),
    `reason: ${finding.reason}`
  );
});

test("health gap rule: inconclusive when probe response exceeded body size limit", () => {
  const evidence = makeHealthEvidence({
    available: true,
    complete: false,
    data: { endpoint: "/healthz", statusCode: 200, probeOutcome: "error" },
    diagnostics: [
      { code: "RESPONSE_TOO_LARGE", severity: "warning", message: "Body exceeded limit." }
    ]
  });
  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const finding = evaluateGap(healthReq, evidence, config);

  assert.equal(finding.outcome, "inconclusive");
  assert.ok(finding.observed.toLowerCase().includes("body size"), `observed: ${finding.observed}`);
});

// ─── Unconfigured-signal tests ─────────────────────────────────────────────────

test("log, trace, and alert gap rules return unknown with BACKEND_UNCONFIGURED", () => {
  const logReq: ExpectedLogRequirement = { id: "log-req-1", signal: "log", fields: ["trace_id"] };
  const traceReq: ExpectedTraceRequirement = { id: "trace-req-1", signal: "trace", serviceName: "my-service" };
  const alertReq: ExpectedAlertRequirement = {
    id: "alert-req-1",
    signal: "alert",
    associatedSignal: "metric",
    condition: "error_rate > 0.05",
    severity: "critical"
  };

  const logFinding = evaluateGap(logReq, makeUnconfiguredEvidence("log", "log-req-1"), { evaluatedAt: NOW });
  const traceFinding = evaluateGap(traceReq, makeUnconfiguredEvidence("trace", "trace-req-1"), { evaluatedAt: NOW });
  const alertFinding = evaluateGap(alertReq, makeUnconfiguredEvidence("alert", "alert-req-1"), { evaluatedAt: NOW });

  assert.equal(logFinding.outcome, "unknown");
  assert.equal(logFinding.signal, "log");
  assert.equal(logFinding.rule.id, logGapRule.id);
  assert.ok(logFinding.observed.toLowerCase().includes("not configured"));

  assert.equal(traceFinding.outcome, "unknown");
  assert.equal(traceFinding.signal, "trace");
  assert.equal(traceFinding.rule.id, traceGapRule.id);

  assert.equal(alertFinding.outcome, "unknown");
  assert.equal(alertFinding.signal, "alert");
  assert.equal(alertFinding.rule.id, alertGapRule.id);
});

// ─── Batch evaluation tests ────────────────────────────────────────────────────

test("batch evaluation produces deterministic findings for all five signal families", () => {
  const model: ExpectedObservabilityModel = {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "test-service",
    requirements: [
      { id: "metric-req-1", signal: "metric", metricName: "http_requests_total", dimensions: ["method"] },
      { id: "health-req-1", signal: "health", kind: "http", endpoint: "/healthz" },
      { id: "log-req-1", signal: "log", fields: ["level"] },
      { id: "trace-req-1", signal: "trace", serviceName: "test-service" },
      { id: "alert-req-1", signal: "alert", associatedSignal: "metric", condition: "rate > 0", severity: "warning" }
    ]
  };

  const evidences: InspectorEvidence[] = [
    makeMetricEvidence({ requirementId: "metric-req-1" }) as InspectorEvidence,
    makeHealthEvidence({ requirementId: "health-req-1" }) as InspectorEvidence,
    makeUnconfiguredEvidence("log", "log-req-1"),
    makeUnconfiguredEvidence("trace", "trace-req-1"),
    makeUnconfiguredEvidence("alert", "alert-req-1")
  ];

  const config: GapEngineConfig = {
    metricConfigs: { "metric-req-1": standardMetricConfig },
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const findings = evaluateExpectedObservabilityModel(model, evidences, config);

  assert.equal(findings.length, 5);

  // Output is sorted by requirementId
  const ids = findings.map((f) => f.requirementId);
  assert.deepEqual(ids, [...ids].sort());

  const byId = new Map(findings.map((f) => [f.requirementId, f]));

  assert.equal(byId.get("metric-req-1")?.outcome, "pass");
  assert.equal(byId.get("health-req-1")?.outcome, "pass");
  assert.equal(byId.get("log-req-1")?.outcome, "unknown");
  assert.equal(byId.get("trace-req-1")?.outcome, "unknown");
  assert.equal(byId.get("alert-req-1")?.outcome, "unknown");
});

test("batch evaluation returns unknown for requirements with no evidence supplied", () => {
  const model: ExpectedObservabilityModel = {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "test-service",
    requirements: [
      { id: "metric-req-orphan", signal: "metric", metricName: "orphan_metric", dimensions: [] }
    ]
  };

  const findings = evaluateExpectedObservabilityModel(model, [], { evaluatedAt: NOW });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].outcome, "unknown");
  assert.ok(findings[0].observed.toLowerCase().includes("no evidence"), `observed: ${findings[0].observed}`);
  assert.equal(findings[0].evidenceProvenance.target, "<no-evidence>");
});

test("batch evaluation returns inconclusive for requirements with duplicate evidence entries", () => {
  const model: ExpectedObservabilityModel = {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "test-service",
    requirements: [
      { id: "health-req-1", signal: "health", kind: "http", endpoint: "/healthz" }
    ]
  };

  const evidences: InspectorEvidence[] = [
    makeHealthEvidence({ requirementId: "health-req-1" }) as InspectorEvidence,
    makeHealthEvidence({ requirementId: "health-req-1", collectedAt: new Date(NOW.getTime() - 1000).toISOString() }) as InspectorEvidence
  ];

  const config: GapEngineConfig = {
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const findings = evaluateExpectedObservabilityModel(model, evidences, config);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].outcome, "inconclusive");
  assert.ok(findings[0].observed.includes("2 evidence entries"), `observed: ${findings[0].observed}`);
});

// ─── Determinism test ──────────────────────────────────────────────────────────

test("evaluateGap and evaluateExpectedObservabilityModel are deterministic for identical inputs", () => {
  const config: GapEngineConfig = {
    metricConfigs: { "metric-req-1": standardMetricConfig },
    maxHealthEvidenceAgeMs: FIVE_MINUTES_MS,
    evaluatedAt: NOW
  };

  const findingA = evaluateGap(metricReq, makeMetricEvidence(), config);
  const findingB = evaluateGap(metricReq, makeMetricEvidence(), config);

  assert.equal(findingA.id, findingB.id);
  assert.equal(findingA.outcome, findingB.outcome);
  assert.equal(findingA.observed, findingB.observed);
  assert.equal(findingA.reason, findingB.reason);

  const model: ExpectedObservabilityModel = {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: "det-service",
    requirements: [
      { id: "metric-req-1", signal: "metric", metricName: "http_requests_total", dimensions: [] },
      { id: "health-req-1", signal: "health", kind: "http", endpoint: "/healthz" }
    ]
  };
  const evidences: InspectorEvidence[] = [
    makeMetricEvidence({ requirementId: "metric-req-1" }) as InspectorEvidence,
    makeHealthEvidence({ requirementId: "health-req-1" }) as InspectorEvidence
  ];

  const batchA = evaluateExpectedObservabilityModel(model, evidences, config);
  const batchB = evaluateExpectedObservabilityModel(model, evidences, config);

  assert.deepEqual(batchA, batchB);
});
