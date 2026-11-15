import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient, Scan } from "@prisma/client";
import { BoundedScanRunner } from "../../src/jobs/scan-runner.js";

function setup(
  expectedModel: unknown,
  targetConfig: Record<string, unknown> = { healthBaseUrl: "http://127.0.0.1:3000" }
) {
  const state: { completed?: unknown[]; failed?: string } = {};
  const runner = new BoundedScanRunner({} as PrismaClient, { autoStart: false });
  Object.assign(runner as unknown as Record<string, unknown>, {
    scanRepo: {
      recordRunningAudit: async () => true,
      renewLease: async () => true,
      completeScanWithFindings: async (_lease: unknown, findings: unknown[]) => { state.completed = findings; },
      failScanWithLease: async (_lease: unknown, error: string) => { state.failed = error; return true; }
    },
    projectRepo: {
      findById: async () => ({
        targetConfig, expectedModel
      })
    }
  });
  const scan = {
    id: "scan-1", tenantId: "tenant-1", projectId: "project-1", status: "running", triggeredById: "user-1",
    workerId: "worker-1", leaseToken: "11111111-1111-4111-8111-111111111111", modelOverride: null
  } as unknown as Scan;
  return { runner, scan, state };
}

const healthModel = {
  schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "demo-service",
  requirements: [{ id: "health", signal: "health", kind: "http", endpoint: "/health" }]
};

test("scan persists the collected health evidence beside its deterministic finding", async () => {
  const { runner, scan, state } = setup(healthModel);
  await runner.executeClaimedScan(scan, async () => new Response("healthy", { status: 200 }));
  assert.equal(state.failed, undefined);
  assert.equal(state.completed?.length, 1);
  const finding = state.completed?.[0] as { outcome: string; evidenceJson: { evidence: { available: boolean; data: { statusCode: number } } } };
  assert.equal(finding.outcome, "pass");
  assert.equal(finding.evidenceJson.evidence.available, true);
  assert.equal(finding.evidenceJson.evidence.data.statusCode, 200);
  await runner.shutdown();
});

test("telemetry connection failure is persisted as unknown evidence, not an empty successful scan", async () => {
  const { runner, scan, state } = setup(healthModel);
  await runner.executeClaimedScan(scan, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(state.failed, undefined);
  const finding = state.completed?.[0] as { outcome: string; evidenceJson: { evidence: { available: boolean; diagnostics: Array<{ code: string }> } } };
  assert.equal(finding.outcome, "unknown");
  assert.equal(finding.evidenceJson.evidence.available, false);
  assert.equal(finding.evidenceJson.evidence.diagnostics[0]?.code, "PROBE_FAILED");
  await runner.shutdown();
});

test("scan with absent or empty expected requirements fails explicitly instead of completing with zero findings", async () => {
  for (const model of [null, { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "empty", requirements: [] }]) {
    const { runner, scan, state } = setup(model);
    await runner.executeClaimedScan(scan);
    assert.match(state.failed ?? "", /expected observability model has no requirements/);
    assert.equal(state.completed, undefined);
    await runner.shutdown();
  }
});

const metricModel = {
  schemaVersion: "cloudpilot.expected-observability.v1",
  serviceId: "demo-service",
  requirements: [{
    id: "demo-request-metric",
    signal: "metric",
    metricName: "demo_http_server_requests_total",
    dimensions: ["method", "route", "status_code"]
  }]
};

const metricTargetConfig = {
  prometheusBaseUrl: "http://127.0.0.1:9090",
  metricConfigs: {
    "demo-request-metric": {
      serviceName: "demo-service",
      route: "/api/demo",
      method: "GET",
      minimumCount: 1,
      maxEvidenceAgeMs: 60_000
    }
  }
};

function createPrometheusMockFetch(options: { coverageWindowSeconds?: number; resultValue: string }) {
  const capturedQueries: Array<{ path: string; query: string | null; start?: number; end?: number; step?: string | null }> = [];
  const fetchImpl: typeof fetch = async (request) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/query_range")) {
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      const step = url.searchParams.get("step");
      capturedQueries.push({ path: url.pathname, query: url.searchParams.get("query"), start, end, step });
      const coverageStart = options.coverageWindowSeconds === undefined ? start : end - options.coverageWindowSeconds;
      const steps = Math.round((end - coverageStart) / 5);
      const values: Array<[number, string]> = [];
      for (let i = 0; i <= steps; i += 1) {
        const ts = i === steps ? end : coverageStart + i * 5;
        values.push([ts, String(ts)]);
      }
      return new Response(JSON.stringify({
        status: "success",
        data: { resultType: "matrix", result: [{ metric: { job: "otel-collector", instance: "otel-collector:8889" }, values }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const promQl = url.searchParams.get("query") ?? "";
    capturedQueries.push({ path: url.pathname, query: promQl });
    const result = promQl.includes("exported_job=")
      ? []
      : [{
          metric: {
            service_name: "demo-service",
            job: "otel-collector",
            instance: "otel-collector:8889",
            route: "/api/demo",
            method: "GET",
            status_code: "200"
          },
          value: [Number(url.searchParams.get("time")), options.resultValue]
        }];
    return new Response(JSON.stringify({
      status: "success",
      data: { resultType: "vector", result }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, capturedQueries };
}

test("scan passes collectionWindowSeconds=300 to Prometheus inspector and preserves increase() pass evaluation", async () => {
  const { runner, scan, state } = setup(metricModel, metricTargetConfig);
  const { fetchImpl, capturedQueries } = createPrometheusMockFetch({ resultValue: "10.17" });

  await runner.executeClaimedScan(scan, fetchImpl);
  assert.equal(state.failed, undefined);
  assert.equal(state.completed?.length, 1);

  const coverageCall = capturedQueries.find((entry) => entry.path.endsWith("/query_range"));
  assert.ok(coverageCall);
  assert.equal(Math.round((coverageCall.end ?? 0) - (coverageCall.start ?? 0)), 300);
  assert.equal(coverageCall.step, "5s");

  const instantQueries = capturedQueries.filter((entry) => entry.path.endsWith("/query")).map((entry) => entry.query ?? "");
  assert.equal(instantQueries.length, 2);
  for (const promQl of instantQueries) {
    assert.match(promQl, /increase\(demo_http_server_requests_total\{[^}]+\}\[300s\]\)/);
    assert.doesNotMatch(promQl, /\[60s\]/);
  }

  const finding = state.completed?.[0] as {
    outcome: string;
    observed: string;
    evidenceJson: { evidence: { available: boolean; complete: boolean; data: { samples: Array<{ value: number }> } } };
  };
  assert.equal(finding.outcome, "pass");
  assert.equal(finding.observed, "Found 1 distinct matching series with aggregate value 10.17.");
  assert.equal(finding.evidenceJson.evidence.available, true);
  assert.equal(finding.evidenceJson.evidence.complete, true);
  assert.equal(finding.evidenceJson.evidence.data.samples[0]?.value, 10.17);
  await runner.shutdown();
});

test("scan keeps strict 300s scrape coverage validation when only 60s of scrapes exist", async () => {
  const { runner, scan, state } = setup(metricModel, metricTargetConfig);
  const { fetchImpl } = createPrometheusMockFetch({ coverageWindowSeconds: 60, resultValue: "10.17" });

  await runner.executeClaimedScan(scan, fetchImpl);
  assert.equal(state.failed, undefined);
  assert.equal(state.completed?.length, 1);

  const finding = state.completed?.[0] as {
    outcome: string;
    evidenceJson: { evidence: { available: boolean; complete: boolean } };
  };
  assert.equal(finding.evidenceJson.evidence.available, true);
  assert.equal(finding.evidenceJson.evidence.complete, false);
  assert.equal(finding.outcome, "unknown");
  await runner.shutdown();
});
