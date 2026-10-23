import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  BoundedScanRunner,
  ActiveScanConflictError,
  ScanQueueFullError,
  StaleWorkerError
} from "../../src/jobs/scan-runner.js";

function createMockPrisma(activeScan?: Record<string, unknown>, pendingCount = 0): PrismaClient {
  let countVal = pendingCount;
  return {
    scan: {
      findFirst: async () => activeScan ?? null,
      findUniqueOrThrow: async () => ({ id: "s1", attemptCount: 1, ...(activeScan ?? {}) }),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      create: async () => ({}),
      count: async () => countVal
    },
    project: {
      findFirst: async () => null
    },
    finding: {
      createMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 })
    },
    auditEvent: {
      create: async () => ({})
    },
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(createMockPrisma(activeScan, pendingCount))
  } as unknown as PrismaClient;
}

test("BoundedScanRunner: rejects enqueue when queue capacity is reached", async () => {
  // DB reports 2 pending scans, max capacity is 2
  const mockPrisma = createMockPrisma(undefined, 2);
  const runner = new BoundedScanRunner(mockPrisma, {
    maxConcurrency: 0,
    maxQueueCapacity: 2
  });

  await assert.rejects(
    async () => {
      await runner.enqueue({
        tenantId: "t1",
        projectId: "p3",
        scanId: "s3",
        actorId: "u1"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ScanQueueFullError);
      assert.equal((err as ScanQueueFullError).statusCode, 429);
      return true;
    }
  );
});

test("BoundedScanRunner: rejects DB-persisted active scan for same project", async () => {
  const runner = new BoundedScanRunner(
    createMockPrisma({ id: "db-active-scan", status: "running" }),
    { maxConcurrency: 0, maxQueueCapacity: 10 }
  );

  await assert.rejects(
    async () => {
      await runner.enqueue({
        tenantId: "t1",
        projectId: "proj-db-conflict",
        scanId: "new-scan-different-id",
        actorId: "u1"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ActiveScanConflictError);
      assert.equal((err as ActiveScanConflictError).statusCode, 409);
      return true;
    }
  );
});

test("BoundedScanRunner: different tenants with same projectId are independent", async () => {
  const runner = new BoundedScanRunner(createMockPrisma(), {
    maxConcurrency: 0,
    maxQueueCapacity: 10
  });

  await assert.doesNotReject(async () => {
    await runner.enqueue({
      tenantId: "tenant-a",
      projectId: "same-project-id",
      scanId: "s1",
      actorId: "u1"
    });
  });

  await assert.doesNotReject(async () => {
    await runner.enqueue({
      tenantId: "tenant-b",
      projectId: "same-project-id",
      scanId: "s2",
      actorId: "u2"
    });
  });
});

test("BoundedScanRunner: activeWorkers property tracks in-flight executions", async () => {
  const runner = new BoundedScanRunner(createMockPrisma(), {
    maxConcurrency: 5,
    maxQueueCapacity: 10
  });

  assert.equal(runner.activeWorkers, 0);
  assert.equal(runner.queueLength, 0);
});

test("BoundedScanRunner: same scanId in DB does not conflict (this replica created it)", async () => {
  const runner = new BoundedScanRunner(
    createMockPrisma({ id: "my-own-scan", status: "pending" }),
    { maxConcurrency: 0, maxQueueCapacity: 10 }
  );

  await assert.doesNotReject(async () => {
    await runner.enqueue({
      tenantId: "t1",
      projectId: "proj-self",
      scanId: "my-own-scan",
      actorId: "u1"
    });
  });
});

test("BoundedScanRunner: shutdown rejects new enqueue requests", async () => {
  const runner = new BoundedScanRunner(createMockPrisma(), {
    maxConcurrency: 0,
    maxQueueCapacity: 10
  });

  await runner.shutdown();

  await assert.rejects(
    async () => {
      await runner.enqueue({
        tenantId: "t1",
        projectId: "p-after-shutdown",
        scanId: "s-shut",
        actorId: "u1"
      });
    },
    /shutting down/i
  );
});

test("ScanRepository: P2002 unique constraint error throws ActiveScanConflictError", async () => {
  const { ScanRepository } = await import("../../src/db/scan-repo.js");
  const p2002Error = new Error("Unique constraint failed on idx_scans_active_project");
  (p2002Error as unknown as { code: string }).code = "P2002";

  const prismaMock = {
    scan: {
      create: async () => {
        throw p2002Error;
      }
    }
  } as unknown as PrismaClient;

  const repo = new ScanRepository(prismaMock);

  await assert.rejects(
    async () => {
      await repo.create({ tenantId: "t1", projectId: "p-conflict" });
    },
    (err: unknown) => {
      assert.ok(err instanceof ActiveScanConflictError);
      assert.equal((err as ActiveScanConflictError).statusCode, 409);
      return true;
    }
  );
});

test("ScanRepository: StaleWorkerError has status 409", () => {
  const err = new StaleWorkerError("scan-1", "worker-1");
  assert.equal(err.statusCode, 409);
  assert.match(err.message, /lost active lease/i);
});
