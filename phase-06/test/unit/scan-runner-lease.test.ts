import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient, Scan } from "@prisma/client";
import { BoundedScanRunner } from "../../src/jobs/scan-runner.js";
import type { ScanLease } from "../../src/db/scan-repo.js";

test("heartbeat ownership loss aborts inspection and prevents completion, failure, and terminal audit", async () => {
  const lease: ScanLease = {
    tenantId: "tenant-1",
    projectId: "project-1",
    scanId: "scan-1",
    workerId: "worker-1",
    leaseToken: "11111111-1111-4111-8111-111111111111"
  };
  let aborted = false;
  let completions = 0;
  let failures = 0;
  const runner = new BoundedScanRunner({} as PrismaClient, {
    workerId: lease.workerId,
    heartbeatIntervalMs: 2,
    autoStart: false
  });
  const fakes = {
    scanRepo: {
      recordRunningAudit: async () => true,
      renewLease: async () => false,
      completeScanWithFindings: async () => { completions++; },
      failScanWithLease: async () => { failures++; return true; }
    },
    projectRepo: {
      findById: async () => ({
        targetConfig: { healthBaseUrl: "http://127.0.0.1:12345" },
        expectedModel: {
          schemaVersion: "cloudpilot.expected-observability.v1",
          serviceId: "test-service",
          requirements: [{ id: "health-1", signal: "health", kind: "http", endpoint: "/health" }]
        }
      })
    }
  };
  Object.assign(runner as unknown as Record<string, unknown>, fakes);

  const scan = {
    ...lease,
    id: lease.scanId,
    status: "running",
    triggeredById: "user-1",
    modelOverride: null
  } as unknown as Scan;
  await runner.executeClaimedScan(scan, async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return reject(new Error("expected abort signal"));
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  }));

  assert.equal(aborted, true, "lease loss should abort the in-flight request");
  assert.equal(completions, 0);
  assert.equal(failures, 0);
  await runner.shutdown();
});
