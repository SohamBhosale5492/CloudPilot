import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient, Scan } from "@prisma/client";
import { BoundedScanRunner } from "../../src/jobs/scan-runner.js";

function setup(expectedModel: unknown) {
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
        targetConfig: { healthBaseUrl: "http://127.0.0.1:3000" }, expectedModel
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
