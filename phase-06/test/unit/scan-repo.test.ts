import test from "node:test";
import assert from "node:assert/strict";
import { ScanRepository, StaleWorkerError, type ScanLease } from "../../src/db/scan-repo.js";
import type { PrismaClient } from "@prisma/client";

function mockPrisma(overrides: Record<string, unknown> = {}): PrismaClient {
  return overrides as unknown as PrismaClient;
}

const lease: ScanLease = {
  tenantId: "tenant-1",
  projectId: "project-1",
  scanId: "scan-1",
  workerId: "same-worker",
  leaseToken: "11111111-1111-4111-8111-111111111111"
};

test("claim generates a fresh UUID per successful claim and returns no token when no row is claimed", async () => {
  const claimTokens: string[] = [];
  let claimsRemaining = 2;
  const prisma = mockPrisma({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      assert.match(sql, /lease_token = \?::uuid/);
      const token = values.find((value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) as string;
      claimTokens.push(token);
      if (claimsRemaining === 0) return [];
      claimsRemaining--;
      return [{
        id: lease.scanId,
        tenantId: lease.tenantId,
        projectId: lease.projectId,
        status: "running",
        workerId: "same-worker",
        leaseToken: token,
        createdAt: new Date()
      }];
    }
  });
  const repo = new ScanRepository(prisma);
  const claimedA = await repo.claimNextPendingScan("same-worker");
  const claimedB = await repo.claimNextPendingScan("same-worker");
  assert.ok(claimedA?.leaseToken);
  assert.ok(claimedB?.leaseToken);
  assert.notEqual(claimedA.leaseToken, claimedB.leaseToken);
  assert.equal(await repo.claimNextPendingScan("same-worker"), null);
  assert.equal(claimTokens.length, 3, "no active lease should be written unless a row was claimed");
});

test("heartbeat is fenced by tenant, project, worker, token, running status, and database lease expiry", async () => {
  let sql = "";
  const repo = new ScanRepository(mockPrisma({
    $executeRaw: async (strings: TemplateStringsArray) => { sql = strings.join("?"); return 0; }
  }));
  assert.equal(await repo.renewLease(lease), false);
  for (const expected of ["tenant_id = ?", "project_id = ?", "worker_id = ?", "lease_token = ?::uuid", "status = 'running'", "lease_expires_at > NOW()"]){
    assert.ok(sql.includes(expected), `missing fence predicate ${expected}`);
  }
});

test("failed completion predicate rolls back before findings or success audit are written", async () => {
  let findingWrites = 0;
  let auditWrites = 0;
  const tx = {
    $executeRaw: async () => 0,
    finding: { deleteMany: async () => { findingWrites++; }, createMany: async () => { findingWrites++; } },
    auditEvent: { create: async () => { auditWrites++; } }
  };
  const repo = new ScanRepository(mockPrisma({ $transaction: async (fn: (value: unknown) => unknown) => fn(tx) }));
  await assert.rejects(repo.completeScanWithFindings(lease, [], "actor"), StaleWorkerError);
  assert.equal(findingWrites, 0);
  assert.equal(auditWrites, 0);
});

test("failure audit is written only after a fenced failure transition succeeds", async () => {
  let auditWrites = 0;
  let updated = 0;
  const tx = {
    $executeRaw: async () => updated,
    auditEvent: { create: async () => { auditWrites++; } }
  };
  const repo = new ScanRepository(mockPrisma({ $transaction: async (fn: (value: unknown) => unknown) => fn(tx) }));
  assert.equal(await repo.failScanWithLease(lease, "old attempt", "actor"), false);
  assert.equal(auditWrites, 0);
  updated = 1;
  assert.equal(await repo.failScanWithLease(lease, "current attempt", "actor"), true);
  assert.equal(auditWrites, 1);
});

test("expired-lease recovery rechecks the observed token and database expiry atomically", async () => {
  const sqlStatements: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      sqlStatements.push(sql);
      return [];
    }
  };
  const repo = new ScanRepository(mockPrisma({ $transaction: async (fn: (value: unknown) => unknown) => fn(tx) }));
  assert.deepEqual(await repo.reclaimExpiredLeases(), { requeued: 0, permanentlyFailed: 0 });
  assert.equal(sqlStatements.length, 2);
  for (const sql of sqlStatements) {
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /lease_token IS NOT DISTINCT FROM/);
    assert.match(sql, /lease_expires_at <= NOW\(\)/);
    assert.match(sql, /lease_token = NULL/);
  }
});
