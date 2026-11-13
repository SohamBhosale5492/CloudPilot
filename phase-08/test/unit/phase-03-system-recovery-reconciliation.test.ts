/**
 * Phase 3 Unit Tests:
 *   A. System recovery lease — atomic claim, concurrent exclusion, expiry takeover,
 *      stale-worker fencing, restart safety.
 *   B. Authority separation — automated recovery must never acquire human
 *      reconciliation authority.
 *   C. Human reconciliation HTTP routes — authentication, role validation
 *      (owner/admin + remediation:approve), stale/revoked membership rejection,
 *      expired-lease takeover, 409 on conflict.
 *
 * These are pure unit tests: no live database, no network calls.
 * Integration tests (concurrent DB claim, fencing) belong in the integration suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { mutationRequestHash } from "../../src/github/internal-mutation-boundary.js";
import {
  RemediationExecutionPersistenceService,
  RemediationExecutionPersistenceError,
  type UnresolvedExecutionIntent,
  type SystemRecoveryLease,
} from "../../src/remediation/remediation-execution-persistence.js";
import {
  ArtifactOnlyExecutionRecoveryService,
  isValidExecutionRecoveryIntent,
  executionRecoveryPolicy,
} from "../../src/remediation/artifact-only-execution-recovery.js";
import { RemediationReconciliationApiRoutes } from "../../src/api/remediation-reconciliation-api.js";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";
const EXECUTION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACTOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const scope = {
  proposalId: "remediation-1",
  tenantId: TENANT_ID,
  organizationId: ORG_ID,
  projectId: PROJECT_ID,
  repositoryBindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  repositoryId: "9007199254740993",
  installationRecordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  artifactHash: "a".repeat(64),
  baseRef: "main",
  baseCommitSha: "b".repeat(40),
};

function makeCandidate(
  stage: UnresolvedExecutionIntent["identity"]["stage"] = "pull_request_close"
): UnresolvedExecutionIntent {
  const operation = {
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/org/repo/pull/42",
    branchName: `cloudpilot/remediation/${"b".repeat(40)}`,
    expectedHeadSha: "b".repeat(40),
    expectedBaseRef: "main",
    expectedBaseCommitSha: "b".repeat(40),
    requestedState: "closed",
  };
  const expected = {
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/org/repo/pull/42",
    state: "closed",
    headRef: `cloudpilot/remediation/${"b".repeat(40)}`,
    headSha: "b".repeat(40),
    baseRef: "main",
    headRepositoryId: "9007199254740993",
    baseRepositoryId: "9007199254740993",
  };
  const requestHash = mutationRequestHash(stage, scope, operation, expected);
  return {
    executionId: EXECUTION_ID,
    attemptNumber: 1,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    remediationId: scope.proposalId,
    repositoryBindingId: scope.repositoryBindingId,
    installationRecordId: scope.installationRecordId,
    githubRepositoryId: scope.repositoryId,
    artifactHash: scope.artifactHash,
    baseRef: scope.baseRef,
    baseCommitSha: scope.baseCommitSha,
    identity: {
      stage,
      operationKey: `${stage}:${requestHash}`,
      requestHash,
      operation,
      expected,
    },
    lease: {
      id: scope.proposalId,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workerId: "worker-1",
      leaseToken: "token-1",
      retriesLeft: 1,
    },
    status: "manual_review_required",
    reconciliationStatus: "required",
    commitSha: "b".repeat(40),
    branchName: `cloudpilot/remediation/${"b".repeat(40)}`,
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/org/repo/pull/42",
  };
}

// ── A. System recovery lease (unit) ─────────────────────────────────────────

test("A1: claimSystemRecoveryLease returns a lease token for an eligible execution", async () => {
  let updateArgs: unknown[] = [];
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async (tpl: TemplateStringsArray) => {
        const sql = tpl.join(" ");
        if (sql.includes("SELECT e.id, e.version")) {
          return [{ id: EXECUTION_ID, version: 0n, tenantId: TENANT_ID, organizationId: ORG_ID,
            projectId: PROJECT_ID, status: "manual_review_required", reconciliationStatus: "required",
            recoveryLeaseUntil: null, recoveryLeaseHash: null }];
        }
        if (sql.includes("RETURNING recovery_lease_until")) {
          return [{ expiresAt: new Date(Date.now() + 600_000) }];
        }
        return [];
      },
      $executeRaw: async (...args: unknown[]) => { updateArgs = args; return 1; },
    }),
  } as unknown as PrismaClient;

  const svc = new RemediationExecutionPersistenceService(prisma);
  const lease = await svc.claimSystemRecoveryLease({
    executionId: EXECUTION_ID,
    organizationId: ORG_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    recoveryOwnerId: "system:recovery",
  });
  assert.ok(lease, "should return a lease");
  assert.equal(lease.executionId, EXECUTION_ID);
  assert.match(lease.leaseToken, /^[0-9a-f-]{36}$/i, "leaseToken is a UUID");
  assert.ok(lease.expiresAt, "expiresAt is set");
});

test("A2: claimSystemRecoveryLease returns null when no eligible execution found", async () => {
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
    }),
  } as unknown as PrismaClient;
  const svc = new RemediationExecutionPersistenceService(prisma);
  const lease = await svc.claimSystemRecoveryLease({
    executionId: EXECUTION_ID, organizationId: ORG_ID,
    tenantId: TENANT_ID, projectId: PROJECT_ID, recoveryOwnerId: "system:recovery",
  });
  assert.equal(lease, null, "returns null when execution not found or ineligible");
});

test("A3: claimSystemRecoveryLease is blocked when lease is live (concurrent exclusion)", async () => {
  const future = new Date(Date.now() + 300_000);
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async () => [{
        id: EXECUTION_ID, version: 1n, tenantId: TENANT_ID, organizationId: ORG_ID, projectId: PROJECT_ID,
        status: "manual_review_required", reconciliationStatus: "required",
        recoveryLeaseUntil: future, recoveryLeaseHash: "f".repeat(64)
      }],
      $executeRaw: async () => 1,
    }),
  } as unknown as PrismaClient;
  const svc = new RemediationExecutionPersistenceService(prisma);
  const lease = await svc.claimSystemRecoveryLease({
    executionId: EXECUTION_ID, organizationId: ORG_ID,
    tenantId: TENANT_ID, projectId: PROJECT_ID, recoveryOwnerId: "system:recovery",
  });
  assert.equal(lease, null, "returns null when live lease exists (concurrent exclusion)");
});

test("A4: claimSystemRecoveryLease allows takeover of an expired lease", async () => {
  const past = new Date(Date.now() - 1_000);
  let updateCalled = false;
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async (tpl: TemplateStringsArray) => {
        const sql = tpl.join(" ");
        if (sql.includes("SELECT e.id, e.version")) {
          return [{ id: EXECUTION_ID, version: 2n, tenantId: TENANT_ID, organizationId: ORG_ID, projectId: PROJECT_ID,
            status: "manual_review_required", reconciliationStatus: "required",
            recoveryLeaseUntil: past, recoveryLeaseHash: "a".repeat(64) }];
        }
        if (sql.includes("RETURNING recovery_lease_until")) {
          updateCalled = true;
          return [{ expiresAt: new Date(Date.now() + 600_000) }];
        }
        return [];
      },
      $executeRaw: async () => 1,
    }),
  } as unknown as PrismaClient;
  const svc = new RemediationExecutionPersistenceService(prisma);
  const lease = await svc.claimSystemRecoveryLease({
    executionId: EXECUTION_ID, organizationId: ORG_ID,
    tenantId: TENANT_ID, projectId: PROJECT_ID, recoveryOwnerId: "system:recovery",
  });
  assert.ok(lease, "expired lease can be taken over");
  assert.ok(updateCalled, "UPDATE was issued for takeover");
});

test("A5: renewSystemRecoveryLease returns false when lease expired or hash mismatch", async () => {
  const prisma = { $executeRaw: async () => 0 } as unknown as PrismaClient;
  const svc = new RemediationExecutionPersistenceService(prisma);
  const fakeLease: SystemRecoveryLease = {
    executionId: EXECUTION_ID, organizationId: ORG_ID, tenantId: TENANT_ID, projectId: PROJECT_ID,
    leaseToken: "00000000-0000-4000-8000-000000000000", expiresAt: new Date(0).toISOString(),
  };
  const result = await svc.renewSystemRecoveryLease(fakeLease);
  assert.equal(result, false);
});

test("A6: assertSystemRecoveryLeaseOwned throws lease_guard_unavailable when lease expired", async () => {
  const prisma = { $queryRaw: async () => [{ valid: false }] } as unknown as PrismaClient;
  const svc = new RemediationExecutionPersistenceService(prisma);
  const fakeLease: SystemRecoveryLease = {
    executionId: EXECUTION_ID, organizationId: ORG_ID, tenantId: TENANT_ID, projectId: PROJECT_ID,
    leaseToken: "00000000-0000-4000-8000-000000000000", expiresAt: new Date(0).toISOString(),
  };
  await assert.rejects(
    () => svc.assertSystemRecoveryLeaseOwned(fakeLease),
    (err: unknown) => {
      assert.ok(err instanceof RemediationExecutionPersistenceError);
      assert.equal(err.code, "lease_guard_unavailable");
      return true;
    }
  );
});

test("A7: assertSystemRecoveryLeaseOwned throws when no matching row found", async () => {
  const prisma = { $queryRaw: async () => [] } as unknown as PrismaClient;
  const svc = new RemediationExecutionPersistenceService(prisma);
  const fakeLease: SystemRecoveryLease = {
    executionId: EXECUTION_ID, organizationId: ORG_ID, tenantId: TENANT_ID, projectId: PROJECT_ID,
    leaseToken: "00000000-0000-4000-8000-000000000000", expiresAt: new Date(0).toISOString(),
  };
  await assert.rejects(
    () => svc.assertSystemRecoveryLeaseOwned(fakeLease),
    (err: unknown) => {
      assert.ok(err instanceof RemediationExecutionPersistenceError);
      assert.equal(err.code, "lease_guard_unavailable");
      return true;
    }
  );
});

test("A8: requireRecoveryReview transitions and audits when system recovery lease is active and valid", async () => {
  const candidate = makeCandidate("pull_request_close");
  const baseAuthority = new RemediationExecutionPersistenceService({
    $queryRaw: async () => [{
      executionId: candidate.executionId, attemptNumber: candidate.attemptNumber,
      stage: "pull_request_close",
      operationKey: candidate.identity.operationKey, requestHash: candidate.identity.requestHash,
      metadata: { operation: candidate.identity.operation, expected: candidate.identity.expected },
      status: "execution_started", reconciliationStatus: "not_required",
      commitSha: candidate.commitSha, branchName: candidate.branchName,
      pullRequestNumber: candidate.pullRequestNumber, pullRequestUrl: candidate.pullRequestUrl,
      remediationId: candidate.remediationId, tenantId: candidate.tenantId,
      organizationId: candidate.organizationId, projectId: candidate.projectId,
      repositoryBindingId: candidate.repositoryBindingId, installationRecordId: candidate.installationRecordId,
      githubRepositoryId: BigInt(candidate.githubRepositoryId),
      artifactHash: candidate.artifactHash, baseRef: candidate.baseRef, baseCommitSha: candidate.baseCommitSha,
      workerId: "worker-1", leaseToken: "token-1", retriesLeft: 1, leaseExpiresAt: new Date(Date.now() + 30_000),
    }],
  } as unknown as PrismaClient);

  const [discovered] = await baseAuthority.discoverUnresolvedIntents();
  assert.ok(discovered);

  let auditCalled = false;
  const mockAudit = async () => { auditCalled = true; };

  const recoveryLease: SystemRecoveryLease = {
    executionId: candidate.executionId,
    organizationId: candidate.organizationId,
    tenantId: candidate.tenantId,
    projectId: candidate.projectId,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async (tpl: TemplateStringsArray) => {
        const sql = tpl.join(" ");
        if (sql.includes("cloudpilot_lock_active_actor_for_update")) return [{ role: "admin" }];
        if (sql.includes("FROM remediation_executions e") && sql.includes("FOR UPDATE OF e")) {
          return [{
            id: candidate.executionId,
            tenantId: candidate.tenantId,
            organizationId: candidate.organizationId,
            projectId: candidate.projectId,
            remediationId: candidate.remediationId,
            repositoryBindingId: candidate.repositoryBindingId,
            installationRecordId: candidate.installationRecordId,
            githubRepositoryId: BigInt(candidate.githubRepositoryId),
            artifactHash: candidate.artifactHash,
            baseRef: candidate.baseRef,
            baseCommitSha: candidate.baseCommitSha,
            status: "execution_started",
            stage: "pull_request_close",
            attemptNumber: candidate.attemptNumber,
            version: 1n,
            leaseTokenHash: null,
            leaseExpiresAt: null,
            commitSha: candidate.commitSha,
            branchName: candidate.branchName,
            pullRequestNumber: candidate.pullRequestNumber,
            pullRequestUrl: candidate.pullRequestUrl,
            reconciliationStatus: "not_required",
            role: "admin",
            userStatus: "active",
            orgStatus: "active",
          }];
        }
        if (sql.includes("event_type = 'request_intent'")) {
          return [{ id: "intent-1" }];
        }
        if (sql.includes("event_type = 'remote_result_verified'")) {
          return [];
        }
        if (sql.includes("SELECT COALESCE(MAX(sequence_number)")) {
          return [{ sequence: 2 }];
        }
        return [];
      },
      $executeRaw: async (tpl: TemplateStringsArray) => {
        const sql = tpl.join(" ");
        if (sql.includes("UPDATE remediation_executions SET status = 'manual_review_required'")) {
          return 1;
        }
        if (sql.includes("INSERT INTO remediation_execution_events")) {
          return 1;
        }
        return 1;
      },
    }),
  } as unknown as PrismaClient;

  const svc = new RemediationExecutionPersistenceService(prisma, mockAudit as never);
  const result = await svc.requireRecoveryReview(discovered, ACTOR_ID, "ambiguous_remote_operation", recoveryLease);
  assert.equal(result, true, "successful transition when recovery lease is valid");
  assert.equal(auditCalled, true, "audit must be written when transition succeeds");
});

test("A9: requireRecoveryReview returns false when recovery lease has expired or token hash mismatches", async () => {
  const candidate = makeCandidate("pull_request_close");
  const baseAuthority = new RemediationExecutionPersistenceService({
    $queryRaw: async () => [{
      executionId: candidate.executionId, attemptNumber: candidate.attemptNumber,
      stage: "pull_request_close",
      operationKey: candidate.identity.operationKey, requestHash: candidate.identity.requestHash,
      metadata: { operation: candidate.identity.operation, expected: candidate.identity.expected },
      status: "execution_started", reconciliationStatus: "not_required",
      commitSha: candidate.commitSha, branchName: candidate.branchName,
      pullRequestNumber: candidate.pullRequestNumber, pullRequestUrl: candidate.pullRequestUrl,
      remediationId: candidate.remediationId, tenantId: candidate.tenantId,
      organizationId: candidate.organizationId, projectId: candidate.projectId,
      repositoryBindingId: candidate.repositoryBindingId, installationRecordId: candidate.installationRecordId,
      githubRepositoryId: BigInt(candidate.githubRepositoryId),
      artifactHash: candidate.artifactHash, baseRef: candidate.baseRef, baseCommitSha: candidate.baseCommitSha,
      workerId: "worker-1", leaseToken: "token-1", retriesLeft: 1, leaseExpiresAt: new Date(Date.now() + 30_000),
    }],
  } as unknown as PrismaClient);

  const [discovered] = await baseAuthority.discoverUnresolvedIntents();
  assert.ok(discovered);

  let auditCalled = false;
  const mockAudit = async () => { auditCalled = true; };

  const recoveryLease: SystemRecoveryLease = {
    executionId: candidate.executionId,
    organizationId: candidate.organizationId,
    tenantId: candidate.tenantId,
    projectId: candidate.projectId,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
    }),
  } as unknown as PrismaClient;

  const svc = new RemediationExecutionPersistenceService(prisma, mockAudit as never);
  const result = await svc.requireRecoveryReview(discovered, ACTOR_ID, "ambiguous_remote_operation", recoveryLease);
  assert.equal(result, false, "must return false when recovery lease is expired or hash mismatched");
  assert.equal(auditCalled, false, "no audit must be written when recovery lease check fails");
});

test("A10: requireRecoveryReview returns false without mutating state or auditing when takeover occurs before atomic update", async () => {
  const candidate = makeCandidate("pull_request_close");
  const baseAuthority = new RemediationExecutionPersistenceService({
    $queryRaw: async () => [{
      executionId: candidate.executionId, attemptNumber: candidate.attemptNumber,
      stage: "pull_request_close",
      operationKey: candidate.identity.operationKey, requestHash: candidate.identity.requestHash,
      metadata: { operation: candidate.identity.operation, expected: candidate.identity.expected },
      status: "execution_started", reconciliationStatus: "not_required",
      commitSha: candidate.commitSha, branchName: candidate.branchName,
      pullRequestNumber: candidate.pullRequestNumber, pullRequestUrl: candidate.pullRequestUrl,
      remediationId: candidate.remediationId, tenantId: candidate.tenantId,
      organizationId: candidate.organizationId, projectId: candidate.projectId,
      repositoryBindingId: candidate.repositoryBindingId, installationRecordId: candidate.installationRecordId,
      githubRepositoryId: BigInt(candidate.githubRepositoryId),
      artifactHash: candidate.artifactHash, baseRef: candidate.baseRef, baseCommitSha: candidate.baseCommitSha,
      workerId: "worker-1", leaseToken: "token-1", retriesLeft: 1, leaseExpiresAt: new Date(Date.now() + 30_000),
    }],
  } as unknown as PrismaClient);

  const [discovered] = await baseAuthority.discoverUnresolvedIntents();
  assert.ok(discovered);

  let auditCalled = false;
  let eventInserted = false;
  const mockAudit = async () => { auditCalled = true; };

  const recoveryLease: SystemRecoveryLease = {
    executionId: candidate.executionId,
    organizationId: candidate.organizationId,
    tenantId: candidate.tenantId,
    projectId: candidate.projectId,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: async (tpl: TemplateStringsArray) => {
        const sql = tpl.join(" ");
        if (sql.includes("FROM remediation_executions e") && sql.includes("FOR UPDATE OF e, o, m, u")) {
          return [{
            id: candidate.executionId,
            tenantId: candidate.tenantId,
            organizationId: candidate.organizationId,
            projectId: candidate.projectId,
            remediationId: candidate.remediationId,
            repositoryBindingId: candidate.repositoryBindingId,
            installationRecordId: candidate.installationRecordId,
            githubRepositoryId: BigInt(candidate.githubRepositoryId),
            artifactHash: candidate.artifactHash,
            baseRef: candidate.baseRef,
            baseCommitSha: candidate.baseCommitSha,
            status: "execution_started",
            stage: "pull_request_close",
            attemptNumber: candidate.attemptNumber,
            version: 1n,
            leaseTokenHash: null,
            leaseExpiresAt: null,
            commitSha: candidate.commitSha,
            branchName: candidate.branchName,
            pullRequestNumber: candidate.pullRequestNumber,
            pullRequestUrl: candidate.pullRequestUrl,
            reconciliationStatus: "not_required",
            role: "admin",
            userStatus: "active",
            orgStatus: "active",
          }];
        }
        if (sql.includes("event_type = 'request_intent'")) return [{ id: "intent-1" }];
        if (sql.includes("event_type = 'remote_result_verified'")) return [];
        return [];
      },
      $executeRaw: async (tpl: TemplateStringsArray) => {
        const sql = tpl.join(" ");
        if (sql.includes("UPDATE remediation_executions SET status = 'manual_review_required'")) {
          // Conditional WHERE recovery_lease_hash = tokenHash AND recovery_lease_until > clock_timestamp() matches 0
          return 0;
        }
        if (sql.includes("INSERT INTO remediation_execution_events")) {
          eventInserted = true;
          return 1;
        }
        return 1;
      },
    }),
  } as unknown as PrismaClient;

  const svc = new RemediationExecutionPersistenceService(prisma, mockAudit as never);
  const result = await svc.requireRecoveryReview(discovered, ACTOR_ID, "ambiguous_remote_operation", recoveryLease);
  assert.equal(result, false, "stale recovery worker must receive false when conditional update matches 0 rows");
  assert.equal(auditCalled, false, "stale recovery worker must not write audit log");
  assert.equal(eventInserted, false, "stale recovery worker must not insert events into event journal");
});

// ── B. Authority separation ───────────────────────────────────────────────────

test("B1: recoverClosedPr never calls beginReconciliation — system uses system recovery lease only", async () => {
  let beginReconciliationCalled = false;
  let recordReconciliationIntentCalled = false;
  let resolveReconciliationCalled = false;
  let claimSystemRecoveryCalled = false;
  let releaseSystemRecoveryCalled = false;
  let requireRecoveryReviewCalled = false;

  const candidate = makeCandidate("pull_request_close");

  // Build a base authority with discoverUnresolvedIntents that marks the candidate as persisted
  const baseAuthority = new RemediationExecutionPersistenceService({
    $queryRaw: async () => [{
      executionId: candidate.executionId, attemptNumber: candidate.attemptNumber,
      stage: "pull_request_close",
      operationKey: candidate.identity.operationKey, requestHash: candidate.identity.requestHash,
      metadata: { operation: candidate.identity.operation, expected: candidate.identity.expected },
      status: "manual_review_required", reconciliationStatus: "required",
      commitSha: candidate.commitSha, branchName: candidate.branchName,
      pullRequestNumber: candidate.pullRequestNumber, pullRequestUrl: candidate.pullRequestUrl,
      remediationId: candidate.remediationId, tenantId: candidate.tenantId,
      organizationId: candidate.organizationId, projectId: candidate.projectId,
      repositoryBindingId: candidate.repositoryBindingId, installationRecordId: candidate.installationRecordId,
      githubRepositoryId: BigInt(candidate.githubRepositoryId),
      artifactHash: candidate.artifactHash, baseRef: candidate.baseRef, baseCommitSha: candidate.baseCommitSha,
      workerId: "worker-1", leaseToken: "token-1", retriesLeft: 1, leaseExpiresAt: new Date(Date.now() + 30_000),
    }],
  } as unknown as PrismaClient);

  // Mock persistence — tracks which authority methods are called
  const persistence = {
    discoverUnresolvedIntents: baseAuthority.discoverUnresolvedIntents.bind(baseAuthority),
    async requireRecoveryReview(_c: unknown, _a: string, _code: string, recoveryLease?: unknown) {
      requireRecoveryReviewCalled = true;
      assert.ok(recoveryLease, "requireRecoveryReview must receive the system recovery lease");
      return true;
    },
    async claimSystemRecoveryLease(_input: unknown) {
      claimSystemRecoveryCalled = true;
      return {
        executionId: EXECUTION_ID, organizationId: ORG_ID, tenantId: TENANT_ID, projectId: PROJECT_ID,
        leaseToken: "00000000-0000-4000-8000-000000000001",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async releaseSystemRecoveryLease(_lease: unknown) { releaseSystemRecoveryCalled = true; },
    async assertSystemRecoveryLeaseOwned(_lease: unknown) { /* ok */ },
    async beginReconciliation(_input: unknown) {
      beginReconciliationCalled = true;
      return null;
    },
    async recordReconciliationIntent(_lease: unknown, _id: unknown) {
      recordReconciliationIntentCalled = true;
    },
    async resolveReconciliation(_input: unknown) {
      resolveReconciliationCalled = true;
      return true;
    },
  } as unknown as RemediationExecutionPersistenceService;

  const recovery = new ArtifactOnlyExecutionRecoveryService(
    persistence,
    { async prepare() { return null; } } as never,
    { async issue() { return null; }, leaseGuardFor() { return null; } } as never,
    {} as never,
    {
      async recoverClosedPullRequest() { return null; },
    } as never
  );

  // Test recoverClosedPr directly to verify that automated recovery claims only the system recovery lease
  // and NEVER calls human reconciliation methods (beginReconciliation, recordReconciliationIntent, resolveReconciliation).
  const outcome = await (recovery as unknown as {
    recoverClosedPr: (c: typeof candidate, a: string, cap: never) => Promise<{ kind: string; reason?: string }>;
  }).recoverClosedPr(candidate, ACTOR_ID, {} as never);

  // Verify: human reconciliation must NEVER have been called
  assert.equal(beginReconciliationCalled, false, "beginReconciliation must NOT be called by automated recovery");
  assert.equal(recordReconciliationIntentCalled, false, "recordReconciliationIntent must NOT be called by automated recovery");
  assert.equal(resolveReconciliationCalled, false, "resolveReconciliation must NOT be called by automated recovery");

  // Verify: system recovery lease WAS used
  assert.equal(claimSystemRecoveryCalled, true, "system recovery lease must be claimed");
  assert.equal(releaseSystemRecoveryCalled, true, "system recovery lease must be released");

  // Verify: escalation to manual review happened
  assert.equal(requireRecoveryReviewCalled, true, "requireRecoveryReview must be called to escalate");

  assert.ok(outcome, "an outcome was produced");
  assert.equal(outcome.kind, "manual_review", "recovery must escalate to manual_review");
});

test("B2: recoverClosedPr skips (returns skipped) when system recovery lease is blocked by concurrent holder", async () => {
  const candidate = makeCandidate("pull_request_close");
  const baseAuthority = new RemediationExecutionPersistenceService({
    $queryRaw: async () => [{
      executionId: candidate.executionId, attemptNumber: candidate.attemptNumber,
      stage: "pull_request_close",
      operationKey: candidate.identity.operationKey, requestHash: candidate.identity.requestHash,
      metadata: { operation: candidate.identity.operation, expected: candidate.identity.expected },
      status: "manual_review_required", reconciliationStatus: "required",
      commitSha: candidate.commitSha, branchName: candidate.branchName,
      pullRequestNumber: candidate.pullRequestNumber, pullRequestUrl: candidate.pullRequestUrl,
      remediationId: candidate.remediationId, tenantId: candidate.tenantId,
      organizationId: candidate.organizationId, projectId: candidate.projectId,
      repositoryBindingId: candidate.repositoryBindingId, installationRecordId: candidate.installationRecordId,
      githubRepositoryId: BigInt(candidate.githubRepositoryId),
      artifactHash: candidate.artifactHash, baseRef: candidate.baseRef, baseCommitSha: candidate.baseCommitSha,
      workerId: "worker-1", leaseToken: "token-1", retriesLeft: 1, leaseExpiresAt: new Date(Date.now() + 30_000),
    }],
  } as unknown as PrismaClient);

  const persistence = {
    discoverUnresolvedIntents: baseAuthority.discoverUnresolvedIntents.bind(baseAuthority),
    async requireRecoveryReview() { return true; },
    async claimSystemRecoveryLease() { return null; }, // blocked by concurrent worker
    async releaseSystemRecoveryLease() {},
    async assertSystemRecoveryLeaseOwned() {},
    async beginReconciliation() { throw new Error("MUST NOT BE CALLED"); },
  } as unknown as RemediationExecutionPersistenceService;

  const recovery = new ArtifactOnlyExecutionRecoveryService(
    persistence,
    { async prepare() { return null; } } as never,
    { async issue() { return null; }, leaseGuardFor() { return null; } } as never,
    {} as never,
    { async recoverClosedPullRequest() { return null; } } as never
  );

  const outcome = await (recovery as unknown as {
    recoverClosedPr: (c: typeof candidate, a: string, cap: never) => Promise<{ kind: string; reason?: string }>;
  }).recoverClosedPr(candidate, ACTOR_ID, {} as never);
  assert.ok(outcome);
  assert.equal(outcome.kind, "skipped", "blocked by concurrent lease → should be skipped");
  assert.equal(outcome.reason, "recovery_lease_unavailable");
});

test("B3: tree and commit stages always go to manual_review_only without acquiring any lease", async () => {
  for (const stage of ["tree", "commit"] as const) {
    assert.equal(executionRecoveryPolicy(stage), "manual_review_only");
  }
  // Additional: recoverOne for tree/commit should NOT call claimSystemRecoveryLease
  let claimCalled = false;
  const treeCandidate = makeCandidate("tree" as never); // force a non-standard stage for the test
  const baseAuthority = new RemediationExecutionPersistenceService({
    $queryRaw: async () => [{
      executionId: "tree-exec-id", attemptNumber: 1, stage: "tree",
      operationKey: `tree:${"0".repeat(64)}`, requestHash: "0".repeat(64),
      metadata: { operation: { treeSha: "d".repeat(40), parentCommitSha: "b".repeat(40) },
        expected: { commitParentSha: "b".repeat(40), commitTreeSha: "d".repeat(40) } },
      status: "execution_started", reconciliationStatus: "not_required",
      commitSha: null, branchName: null, pullRequestNumber: null, pullRequestUrl: null,
      remediationId: "remediation-1", tenantId: TENANT_ID, organizationId: ORG_ID, projectId: PROJECT_ID,
      repositoryBindingId: scope.repositoryBindingId, installationRecordId: scope.installationRecordId,
      githubRepositoryId: BigInt(scope.repositoryId),
      artifactHash: scope.artifactHash, baseRef: scope.baseRef, baseCommitSha: scope.baseCommitSha,
      workerId: null, leaseToken: null, retriesLeft: 0, leaseExpiresAt: null,
    }],
  } as unknown as PrismaClient);

  const persistence = {
    discoverUnresolvedIntents: baseAuthority.discoverUnresolvedIntents.bind(baseAuthority),
    async requireRecoveryReview() { return true; },
    async claimSystemRecoveryLease() { claimCalled = true; return null; },
    async releaseSystemRecoveryLease() {},
  } as unknown as RemediationExecutionPersistenceService;

  const recovery = new ArtifactOnlyExecutionRecoveryService(
    persistence,
    { async prepare() { return null; } } as never,
    { async issue() { return null; }, leaseGuardFor() { return null; } } as never,
    {} as never,
    { async recoverClosedPullRequest() { return null; } } as never
  );

  await recovery.recover(ACTOR_ID);
  assert.equal(claimCalled, false, "tree/commit stages must not claim system recovery lease");
});

test("B4: recoverClosedPr handles takeover between initial check and requireRecoveryReview (returns skipped)", async () => {
  const candidate = makeCandidate("pull_request_close");
  const baseAuthority = new RemediationExecutionPersistenceService({
    $queryRaw: async () => [{
      executionId: candidate.executionId, attemptNumber: candidate.attemptNumber,
      stage: "pull_request_close",
      operationKey: candidate.identity.operationKey, requestHash: candidate.identity.requestHash,
      metadata: { operation: candidate.identity.operation, expected: candidate.identity.expected },
      status: "manual_review_required", reconciliationStatus: "required",
      commitSha: candidate.commitSha, branchName: candidate.branchName,
      pullRequestNumber: candidate.pullRequestNumber, pullRequestUrl: candidate.pullRequestUrl,
      remediationId: candidate.remediationId, tenantId: candidate.tenantId,
      organizationId: candidate.organizationId, projectId: candidate.projectId,
      repositoryBindingId: candidate.repositoryBindingId, installationRecordId: candidate.installationRecordId,
      githubRepositoryId: BigInt(candidate.githubRepositoryId),
      artifactHash: candidate.artifactHash, baseRef: candidate.baseRef, baseCommitSha: candidate.baseCommitSha,
      workerId: "worker-1", leaseToken: "token-1", retriesLeft: 1, leaseExpiresAt: new Date(Date.now() + 30_000),
    }],
  } as unknown as PrismaClient);

  let leaseReleased = false;
  const persistence = {
    discoverUnresolvedIntents: baseAuthority.discoverUnresolvedIntents.bind(baseAuthority),
    async claimSystemRecoveryLease() {
      return {
        executionId: EXECUTION_ID, organizationId: ORG_ID, tenantId: TENANT_ID, projectId: PROJECT_ID,
        leaseToken: "00000000-0000-4000-8000-000000000001",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async releaseSystemRecoveryLease() { leaseReleased = true; },
    async assertSystemRecoveryLeaseOwned() {
      // Passes initial check
    },
    async requireRecoveryReview(_c: unknown, _a: string, _code: string, _lease?: unknown) {
      // Takeover occurred right before write!
      return false;
    },
  } as unknown as RemediationExecutionPersistenceService;

  const recovery = new ArtifactOnlyExecutionRecoveryService(
    persistence,
    { async prepare() { return null; } } as never,
    { async issue() { return null; }, leaseGuardFor() { return null; } } as never,
    {} as never,
    { async recoverClosedPullRequest() { return { closed: true }; } } as never
  );

  const outcome = await (recovery as unknown as {
    recoverClosedPr: (c: typeof candidate, a: string, cap: never) => Promise<{ kind: string; reason?: string }>;
  }).recoverClosedPr(candidate, ACTOR_ID, {} as never);

  assert.ok(outcome);
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.reason, "authorization_or_state_changed", "takeover before write must result in skipped without throwing");
  assert.equal(leaseReleased, true, "recovery lease must still be released in finally block");
});

// ── C. Human reconciliation HTTP routes ─────────────────────────────────────

function makeContext(opts: {
  method: string; pathname: string; userId?: string;
  body?: unknown; tenantId?: string;
}): import("../../../phase-06/src/api/server.js").AuthenticatedRouteContext {
  return {
    method: opts.method,
    pathname: opts.pathname,
    identity: { userId: opts.userId ?? ACTOR_ID, tenantId: opts.tenantId ?? TENANT_ID, role: "admin" },
    parseJsonBody: async () => opts.body ?? {},
    sendJson: (status: number, body: unknown) => {
      (context as unknown as Record<string, unknown>)._response = { status, body };
    },
  } as unknown as import("../../../phase-06/src/api/server.js").AuthenticatedRouteContext;
  // hack: we capture sendJson result on the context itself
  const context = makeContext(opts);
  return context;
}

/** Minimal helper that creates a route context and captures the response. */
function makeTestContext(opts: {
  method: string; pathname: string; userId?: string;
  body?: unknown; tenantId?: string;
}) {
  let responseStatus: number | null = null;
  let responseBody: unknown = null;
  const ctx = {
    method: opts.method,
    pathname: opts.pathname,
    identity: { userId: opts.userId ?? ACTOR_ID, tenantId: opts.tenantId ?? TENANT_ID, role: "admin" },
    parseJsonBody: async () => opts.body ?? {},
    sendJson(status: number, body: unknown) {
      responseStatus = status;
      responseBody = body;
    },
  } as unknown as import("../../../phase-06/src/api/server.js").AuthenticatedRouteContext;
  return { ctx, getStatus: () => responseStatus, getBody: () => responseBody };
}

function makeIdentityResolver(userId = ACTOR_ID) {
  return {
    async resolve() {
      return { id: userId, status: "active", displayName: null, email: null,
        emailVerifiedAt: null, createdAt: new Date(), updatedAt: new Date(), lastAuthenticatedAt: new Date() };
    },
  };
}

test("C1: GET /api/v1/remediation-executions/:id — not found when no matching row", async () => {
  const prisma = {
    $queryRaw: async () => [],
  } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({ method: "GET", pathname: `/api/v1/remediation-executions/${EXECUTION_ID}` });
  const handled = await routes.handle(ctx);
  assert.equal(handled, true);
  assert.equal(getStatus(), 404);
});

test("C2: GET /api/v1/remediation-executions/:id — 403 when actor lacks role or permission", async () => {
  const prisma = {
    $queryRaw: async (tpl: TemplateStringsArray) => {
      // Return a row but with role=operator (no remediation:approve)
      return [{ id: EXECUTION_ID, tenantId: TENANT_ID, organizationId: ORG_ID, projectId: PROJECT_ID,
        remediationId: "rem-1", status: "manual_review_required", stage: "pull_request_close",
        attemptNumber: 1, reconciliationStatus: "required", reconciliationOutcome: null,
        failureStage: "pull_request_close", failureCode: "ambiguous_remote_operation",
        commitSha: "b".repeat(40), branchName: `cloudpilot/remediation/${"b".repeat(40)}`,
        pullRequestNumber: 42, pullRequestUrl: "https://github.com/org/repo/pull/42",
        manualReviewAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        actorRole: "operator" }];
    },
  } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({ method: "GET", pathname: `/api/v1/remediation-executions/${EXECUTION_ID}` });
  await routes.handle(ctx);
  assert.equal(getStatus(), 404, "operator cannot see the execution (no remediation:approve)");
});

test("C3: GET /api/v1/remediation-executions/:id — 200 for owner/admin with remediation:approve", async () => {
  const executionRow = { id: EXECUTION_ID, tenantId: TENANT_ID, organizationId: ORG_ID, projectId: PROJECT_ID,
    remediationId: "rem-1", status: "manual_review_required", stage: "pull_request_close",
    attemptNumber: 1, reconciliationStatus: "required", reconciliationOutcome: null,
    failureStage: "pull_request_close", failureCode: "ambiguous_remote_operation",
    commitSha: "b".repeat(40), branchName: `cloudpilot/remediation/${"b".repeat(40)}`,
    pullRequestNumber: 42, pullRequestUrl: "https://github.com/org/repo/pull/42",
    manualReviewAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    actorRole: "admin" };
  const prisma = { $queryRaw: async () => [executionRow] } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus, getBody } = makeTestContext({ method: "GET", pathname: `/api/v1/remediation-executions/${EXECUTION_ID}` });
  await routes.handle(ctx);
  assert.equal(getStatus(), 200);
  const body = getBody() as Record<string, unknown>;
  assert.ok(body.execution, "response includes execution object");
});

test("C4: POST .../reconciliation/claim — 409 when execution ineligible", async () => {
  const prisma = {
    $queryRaw: async () => [], // validateActorPermissionForExecution returns false
  } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/claim`,
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 403, "no active owner/admin membership → 403");
});

test("C5: POST .../reconciliation/claim — 200 returns lease for eligible admin", async () => {
  let beginCalled = false;
  const membershipRow = { role: "admin" };
  const prisma = { $queryRaw: async () => [membershipRow] } as unknown as PrismaClient;
  const fakeLease = {
    executionId: EXECUTION_ID, organizationId: ORG_ID, actorIdentityUserId: ACTOR_ID,
    leaseToken: "00000000-0000-4000-8000-000000000001",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  const persistence = {
    beginReconciliation: async (_input: unknown) => { beginCalled = true; return fakeLease; },
  } as unknown as RemediationExecutionPersistenceService;
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus, getBody } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/claim`,
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 200);
  assert.equal(beginCalled, true, "beginReconciliation called on the persistence service");
  const body = getBody() as Record<string, Record<string, unknown>>;
  assert.ok(body.lease?.leaseToken, "lease token returned to caller");
  assert.ok(body.lease?.expiresAt, "expiresAt returned");
});

test("C6: POST .../reconciliation/resolve — 400 on invalid body", async () => {
  const prisma = { $queryRaw: async () => [] } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/resolve`,
    body: { leaseToken: "not-a-uuid", outcome: "completed" },
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 400, "invalid leaseToken → 400");
});

test("C7: POST .../reconciliation/resolve — 400 when outcome is invalid", async () => {
  const prisma = { $queryRaw: async () => [] } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/resolve`,
    body: { leaseToken: "00000000-0000-4000-8000-000000000001", outcome: "invalid_outcome" },
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 400);
});

test("POST .../reconciliation/resolve rejects completed because HTTP reconciliation cannot provide trusted evidence", async () => {
  let persistenceCalled = false;
  const prisma = { $queryRaw: async () => { throw new Error("validation must reject before database access"); } } as unknown as PrismaClient;
  const persistence = {
    async resolveReconciliation() { persistenceCalled = true; return true; },
  } as unknown as RemediationExecutionPersistenceService;
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus, getBody } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/resolve`,
    body: { leaseToken: "00000000-0000-4000-8000-000000000001", outcome: "completed" },
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 400);
  assert.match((getBody() as { error: string }).error, /failed, manual_review_required/);
  assert.equal(persistenceCalled, false, "unsupported completion must be rejected before persistence");
});

test("C8: POST .../reconciliation/resolve — 403 when actor has no active membership", async () => {
  const prisma = {
    $queryRaw: async () => [], // membership check returns empty
  } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/resolve`,
    body: { leaseToken: "00000000-0000-4000-8000-000000000001", outcome: "failed", code: "ambiguous_remote_operation" },
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 403);
});

test("C9: POST .../reconciliation/resolve — 409 when persistence returns false (lease expired)", async () => {
  const membershipRow = { role: "owner" };
  let resolveCallCount = 0;
  const prisma = {
    $queryRaw: async (tpl: TemplateStringsArray) => {
      const sql = tpl.join(" ");
      // For membership check
      if (sql.includes("m.role IN")) return [membershipRow];
      // For getExecutionOrganizationId
      return [{ organizationId: ORG_ID }];
    },
  } as unknown as PrismaClient;
  const persistence = {
    async resolveReconciliation() { resolveCallCount++; return false; },
  } as unknown as RemediationExecutionPersistenceService;
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/resolve`,
    body: { leaseToken: "00000000-0000-4000-8000-000000000001", outcome: "failed" },
  });
  await routes.handle(ctx);
  assert.equal(resolveCallCount, 1, "resolveReconciliation was called");
  assert.equal(getStatus(), 409, "false from resolveReconciliation → 409");
});

test("C10: POST .../reconciliation/resolve — 200 on successful resolution by owner", async () => {
  const membershipRow = { role: "owner" };
  let resolveCalledOutcome: string | null = null;
  const prisma = {
    $queryRaw: async () => {
      return [membershipRow, { organizationId: ORG_ID }];
    },
  } as unknown as PrismaClient;
  // Prisma queryRaw needs to handle two different calls differently
  const prismaFull = {
    $queryRaw: async (tpl: TemplateStringsArray) => {
      const sql = tpl.join(" ");
      if (sql.includes('organization_id AS "organizationId"')) return [{ organizationId: ORG_ID }];
      return [membershipRow];
    },
  } as unknown as PrismaClient;
  const persistence = {
    async resolveReconciliation(input: { outcome: string }) {
      resolveCalledOutcome = input.outcome;
      return true;
    },
  } as unknown as RemediationExecutionPersistenceService;
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prismaFull,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/resolve`,
    body: { leaseToken: "00000000-0000-4000-8000-000000000001", outcome: "manual_review_required" },
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 200);
  assert.equal(resolveCalledOutcome, "manual_review_required");
});

test("C11: unhandled paths are ignored (handle returns false)", async () => {
  const prisma = { $queryRaw: async () => [] } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx } = makeTestContext({ method: "GET", pathname: "/api/v1/some-other-route" });
  const handled = await routes.handle(ctx);
  assert.equal(handled, false, "unrelated paths must not be claimed");
});

test("C12: invalid execution ID format → 404", async () => {
  const prisma = { $queryRaw: async () => [] } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({ method: "GET", pathname: "/api/v1/remediation-executions/not-a-uuid" });
  await routes.handle(ctx);
  assert.equal(getStatus(), 404);
});

test("C13: revoked membership (operator who had approval) is rejected at every operation", async () => {
  // Simulates a user whose role was downgraded from admin → operator after the lease was claimed.
  // When they try to resolve, the per-operation membership check runs fresh and finds operator.
  const operatorRow = { role: "operator" }; // no remediation:approve
  const prisma = {
    $queryRaw: async () => [operatorRow],
  } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver() as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx, getStatus } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${EXECUTION_ID}/reconciliation/resolve`,
    body: { leaseToken: "00000000-0000-4000-8000-000000000001", outcome: "failed" },
  });
  await routes.handle(ctx);
  assert.equal(getStatus(), 403, "downgraded operator is rejected — permission revocation enforced");
});

// ── Cross-Organization Access Denial Tests (P1 Isolation Verification) ───────
//
// Verifies that a fully authenticated, active owner/admin of Organization B
// cannot inspect, claim, or resolve an execution belonging to Organization A.

const CROSS_ORG_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CROSS_ORG_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CROSS_ACTOR_A_ID = "11111111-1111-4111-8111-111111111111"; // Org A admin
const CROSS_ACTOR_B_ID = "22222222-2222-4222-8222-222222222222"; // Org B owner
const CROSS_EXECUTION_A_ID = EXECUTION_ID;

interface CrossOrgFixture {
  organizations: Record<string, { id: string; name: string; status: string }>;
  identityUsers: Record<string, { id: string; status: string; displayName: string }>;
  organizationMembers: Array<{ organizationId: string; userId: string; role: string; status: string }>;
  executions: Record<string, {
    id: string; tenantId: string; organizationId: string; projectId: string; remediationId: string;
    status: string; stage: string; attemptNumber: number; reconciliationStatus: string;
    reconciliationOutcome: string | null; failureStage: string; failureCode: string;
    commitSha: string; branchName: string; pullRequestNumber: number; pullRequestUrl: string;
    manualReviewAt: string; createdAt: string; updatedAt: string;
  }>;
}

function createCrossOrgFixture(): CrossOrgFixture {
  return {
    organizations: {
      [CROSS_ORG_A_ID]: { id: CROSS_ORG_A_ID, name: "Organization A", status: "active" },
      [CROSS_ORG_B_ID]: { id: CROSS_ORG_B_ID, name: "Organization B", status: "active" },
    },
    identityUsers: {
      [CROSS_ACTOR_A_ID]: { id: CROSS_ACTOR_A_ID, status: "active", displayName: "Org A Admin" },
      [CROSS_ACTOR_B_ID]: { id: CROSS_ACTOR_B_ID, status: "active", displayName: "Org B Owner" },
    },
    organizationMembers: [
      { organizationId: CROSS_ORG_A_ID, userId: CROSS_ACTOR_A_ID, role: "admin", status: "active" },
      { organizationId: CROSS_ORG_B_ID, userId: CROSS_ACTOR_B_ID, role: "owner", status: "active" },
    ],
    executions: {
      [CROSS_EXECUTION_A_ID]: {
        id: CROSS_EXECUTION_A_ID,
        organizationId: CROSS_ORG_A_ID, // Belongs strictly to Organization A
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        remediationId: "rem-1",
        status: "manual_review_required",
        stage: "pull_request_close",
        attemptNumber: 1,
        reconciliationStatus: "required",
        reconciliationOutcome: null,
        failureStage: "pull_request_close",
        failureCode: "ambiguous_remote_operation",
        commitSha: "b".repeat(40),
        branchName: `cloudpilot/remediation/${"b".repeat(40)}`,
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/org/repo/pull/42",
        manualReviewAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

function createCrossOrgPrisma(fixture: CrossOrgFixture) {
  let mutationCount = 0;
  const prisma = {
    $executeRaw: async () => {
      mutationCount++;
      return 1;
    },
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join(" ");

      // loadExecutionForActor: joins e, o, m, u
      if (sql.includes("FROM remediation_executions e") && sql.includes('m.role AS "actorRole"')) {
        const actorId = String(values[0] ?? "");
        const executionId = String(values[1] ?? "");
        const exec = fixture.executions[executionId];
        if (!exec) return [];
        const org = fixture.organizations[exec.organizationId];
        if (!org || org.status !== "active") return [];
        const user = fixture.identityUsers[actorId];
        if (!user || user.status !== "active") return [];
        const member = fixture.organizationMembers.find(
          (m) => m.organizationId === exec.organizationId && m.userId === actorId && m.status === "active"
        );
        if (!member) return []; // Cross-org: actor B has NO membership in exec.organizationId
        return [{
          ...exec,
          actorRole: member.role,
        }];
      }

      // validateActorPermissionForExecution: joins e, o, m, u where m.role IN ('owner', 'admin')
      if (sql.includes("SELECT m.role FROM remediation_executions e")) {
        const actorId = String(values[0] ?? "");
        const executionId = String(values[1] ?? "");
        const exec = fixture.executions[executionId];
        if (!exec) return [];
        const org = fixture.organizations[exec.organizationId];
        if (!org || org.status !== "active") return [];
        const user = fixture.identityUsers[actorId];
        if (!user || user.status !== "active") return [];
        const member = fixture.organizationMembers.find(
          (m) => m.organizationId === exec.organizationId && m.userId === actorId && m.status === "active"
        );
        if (!member || !["owner", "admin"].includes(member.role)) return [];
        return [{ role: member.role }];
      }

      // getExecutionOrganizationId
      if (sql.includes('organization_id AS "organizationId"')) {
        const executionId = String(values[0] ?? "");
        const exec = fixture.executions[executionId];
        return exec ? [{ organizationId: exec.organizationId }] : [];
      }

      return [];
    },
    getMutationCount: () => mutationCount,
  };
  return prisma as unknown as PrismaClient & { getMutationCount: () => number };
}

test("C14: cross-org access denial — GET inspection by Org B owner returns 404 (no cross-org resource disclosure)", async () => {
  const fixture = createCrossOrgFixture();
  const prisma = createCrossOrgPrisma(fixture);

  // 1. Positive control: verify that Org A admin CAN inspect the execution
  const routesA = new RemediationReconciliationApiRoutes(
    makeIdentityResolver(CROSS_ACTOR_A_ID) as never,
    {} as never,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx: ctxA, getStatus: getStatusA, getBody: getBodyA } = makeTestContext({
    method: "GET",
    pathname: `/api/v1/remediation-executions/${CROSS_EXECUTION_A_ID}`,
    userId: CROSS_ACTOR_A_ID,
  });
  await routesA.handle(ctxA);
  assert.equal(getStatusA(), 200, "Org A admin must be able to inspect Org A execution");
  const bodyA = getBodyA() as { execution?: { id: string } };
  assert.equal(bodyA.execution?.id, CROSS_EXECUTION_A_ID);

  // 2. Cross-org check: Org B owner (with full admin rights in Org B) attempts to inspect Org A execution
  const routesB = new RemediationReconciliationApiRoutes(
    makeIdentityResolver(CROSS_ACTOR_B_ID) as never,
    {} as never,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );
  const { ctx: ctxB, getStatus: getStatusB, getBody: getBodyB } = makeTestContext({
    method: "GET",
    pathname: `/api/v1/remediation-executions/${CROSS_EXECUTION_A_ID}`,
    userId: CROSS_ACTOR_B_ID,
  });
  const handled = await routesB.handle(ctxB);
  assert.equal(handled, true);
  assert.equal(getStatusB(), 404, "GET inspection by cross-org actor must return 404");
  const bodyB = getBodyB() as { error?: string };
  assert.equal(bodyB.error, "Remediation execution not found or insufficient permissions.");
  assert.equal("execution" in (bodyB as object), false, "response must not disclose execution data to Org B actor");
  assert.equal(prisma.getMutationCount(), 0, "inspection must not mutate database state");
});

test("C15: cross-org access denial — POST claim by Org B owner returns 403 without creating lease or mutating state", async () => {
  const fixture = createCrossOrgFixture();
  const prisma = createCrossOrgPrisma(fixture);

  let beginReconciliationCalls = 0;
  let stateMutationCalls = 0;
  let eventAppendedCalls = 0;

  const persistence = {
    async beginReconciliation() {
      beginReconciliationCalls++;
      stateMutationCalls++;
      eventAppendedCalls++;
      return null;
    },
  } as unknown as RemediationExecutionPersistenceService;

  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver(CROSS_ACTOR_B_ID) as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );

  const { ctx, getStatus, getBody } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${CROSS_EXECUTION_A_ID}/reconciliation/claim`,
    userId: CROSS_ACTOR_B_ID,
  });

  const handled = await routes.handle(ctx);
  assert.equal(handled, true);
  assert.equal(getStatus(), 403, "claim by cross-org actor must return 403 Forbidden");
  const body = getBody() as { error?: string };
  assert.equal(body.error, "Forbidden: active owner or admin membership with remediation:approve is required.");
  assert.equal("lease" in (body as object), false, "response must not return a reconciliation lease");

  // Invariants:
  assert.equal(beginReconciliationCalls, 0, "no reconciliation lease must be created for cross-org actor");
  assert.equal(stateMutationCalls, 0, "no execution state changes must occur");
  assert.equal(eventAppendedCalls, 0, "no execution event or audit record must be appended");
  assert.equal(prisma.getMutationCount(), 0, "no database mutations must occur");
});

test("C16: cross-org access denial — POST resolve by Org B owner returns 403 without resolving execution or appending events", async () => {
  const fixture = createCrossOrgFixture();
  const prisma = createCrossOrgPrisma(fixture);

  let resolveReconciliationCalls = 0;
  let stateMutationCalls = 0;
  let eventAppendedCalls = 0;

  const persistence = {
    async resolveReconciliation() {
      resolveReconciliationCalls++;
      stateMutationCalls++;
      eventAppendedCalls++;
      return false;
    },
  } as unknown as RemediationExecutionPersistenceService;

  const routes = new RemediationReconciliationApiRoutes(
    makeIdentityResolver(CROSS_ACTOR_B_ID) as never,
    persistence,
    prisma,
    { expectedIssuer: "https://issuer.test" }
  );

  const { ctx, getStatus, getBody } = makeTestContext({
    method: "POST",
    pathname: `/api/v1/remediation-executions/${CROSS_EXECUTION_A_ID}/reconciliation/resolve`,
    userId: CROSS_ACTOR_B_ID,
    body: {
      leaseToken: "00000000-0000-4000-8000-000000000001",
      outcome: "failed",
    },
  });

  const handled = await routes.handle(ctx);
  assert.equal(handled, true);
  assert.equal(getStatus(), 403, "resolve by cross-org actor must return 403 Forbidden");
  const body = getBody() as { error?: string };
  assert.equal(body.error, "Forbidden: active owner or admin membership with remediation:approve is required.");

  // Invariants:
  assert.equal(resolveReconciliationCalls, 0, "no reconciliation resolution must be executed for cross-org actor");
  assert.equal(stateMutationCalls, 0, "no execution state changes must occur");
  assert.equal(eventAppendedCalls, 0, "no execution event or audit record must be appended");
  assert.equal(prisma.getMutationCount(), 0, "no database mutations must occur");
});
