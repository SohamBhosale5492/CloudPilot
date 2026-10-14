import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { BoundedScanRunner, ActiveScanConflictError, ScanQueueFullError } from "../../src/jobs/scan-runner.js";

// Minimal mock prisma for unit-testing queue behaviors without DB
function createMockPrisma(activeScan?: Record<string, unknown>): PrismaClient {
  return {
    scan: {
      findFirst: async () => activeScan ?? null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      create: async () => ({})
    },
    project: {
      findFirst: async () => null
    },
    finding: {
      createMany: async () => ({ count: 0 })
    },
    auditEvent: {
      create: async () => ({})
    }
  } as unknown as PrismaClient;
}

test("BoundedScanRunner: rejects enqueue when queue capacity is reached", async () => {
  // 0 concurrency: nothing drains the queue
  const runner = new BoundedScanRunner(createMockPrisma(), {
    maxConcurrency: 0,
    maxQueueCapacity: 2
  });

  await runner.enqueue({
    tenantId: "t1",
    projectId: "p1",
    scanId: "s1",
    actorId: "u1"
  });

  await runner.enqueue({
    tenantId: "t1",
    projectId: "p2",
    scanId: "s2",
    actorId: "u1"
  });

  // Third enqueue exceeds capacity of 2
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

test("BoundedScanRunner: rejects queued duplicate project (in-memory conflict)", async () => {
  const runner = new BoundedScanRunner(createMockPrisma(), {
    maxConcurrency: 0,
    maxQueueCapacity: 10
  });

  await runner.enqueue({
    tenantId: "t1",
    projectId: "proj-dup",
    scanId: "s1",
    actorId: "u1"
  });

  // Same project second time: should detect it's in the inProcessProjects set
  await assert.rejects(
    async () => {
      await runner.enqueue({
        tenantId: "t1",
        projectId: "proj-dup",
        scanId: "s2",
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

test("BoundedScanRunner: rejects DB-persisted active scan for same project", async () => {
  // Mock DB returns an active scan (already persisted in DB from another replica)
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
  // Same projectId but different tenantIds must NOT conflict
  const runner = new BoundedScanRunner(createMockPrisma(), {
    maxConcurrency: 0,
    maxQueueCapacity: 10
  });

  await runner.enqueue({
    tenantId: "tenant-a",
    projectId: "same-project-id",
    scanId: "s1",
    actorId: "u1"
  });

  // Different tenant — should succeed
  await assert.doesNotReject(async () => {
    await runner.enqueue({
      tenantId: "tenant-b",
      projectId: "same-project-id",
      scanId: "s2",
      actorId: "u2"
    });
  });
});

test("BoundedScanRunner: queueLength and activeWorkers properties", async () => {
  const runner = new BoundedScanRunner(createMockPrisma(), {
    maxConcurrency: 0,
    maxQueueCapacity: 10
  });

  assert.equal(runner.queueLength, 0);
  assert.equal(runner.activeWorkers, 0);

  await runner.enqueue({ tenantId: "t1", projectId: "p1", scanId: "s1", actorId: "u1" });
  assert.equal(runner.queueLength, 1);

  await runner.enqueue({ tenantId: "t1", projectId: "p2", scanId: "s2", actorId: "u1" });
  assert.equal(runner.queueLength, 2);
});

test("BoundedScanRunner: same scanId in DB does not conflict (this replica created it)", async () => {
  // activeScan.id === task.scanId means THIS call created the scan — no conflict
  const runner = new BoundedScanRunner(
    createMockPrisma({ id: "my-own-scan", status: "pending" }),
    { maxConcurrency: 0, maxQueueCapacity: 10 }
  );

  await assert.doesNotReject(async () => {
    await runner.enqueue({
      tenantId: "t1",
      projectId: "proj-self",
      scanId: "my-own-scan", // matches DB active scan id
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
