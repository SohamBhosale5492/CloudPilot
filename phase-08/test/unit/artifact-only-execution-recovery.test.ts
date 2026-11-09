import assert from "node:assert/strict";
import test from "node:test";
import { mutationRequestHash } from "../../src/github/internal-mutation-boundary.js";
import { executionRecoveryPolicy, isValidExecutionRecoveryIntent } from "../../src/remediation/artifact-only-execution-recovery.js";
import { isPersistedUnresolvedExecutionIntent, type UnresolvedExecutionIntent } from "../../src/remediation/remediation-execution-persistence.js";
import { RemediationExecutionPersistenceService } from "../../src/remediation/remediation-execution-persistence.js";
import { ArtifactOnlyExecutionRecoveryService } from "../../src/remediation/artifact-only-execution-recovery.js";
import { PrismaClient } from "@prisma/client";

const scope = {
  proposalId: "remediation-1", tenantId: "tenant-1", organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "project-1", repositoryBindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  repositoryId: "9007199254740993", installationRecordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  artifactHash: "a".repeat(64), baseRef: "main", baseCommitSha: "b".repeat(40)
};

function candidate(stage: UnresolvedExecutionIntent["identity"]["stage"] = "blob"): UnresolvedExecutionIntent {
  const operation = { filePath: "config/observability/metrics.yaml", renderedContentSha256: "c".repeat(64),
    byteLength: 12, expectedBlobSha: "d".repeat(40) };
  const expected = { blobSha: "d".repeat(40), contentSha256: "c".repeat(64), byteLength: 12,
    encoding: "exact-artifact-bytes" };
  const requestHash = mutationRequestHash(stage, scope, operation, expected);
  return {
    executionId: "execution-1", attemptNumber: 2, ...{
      tenantId: scope.tenantId, organizationId: scope.organizationId, projectId: scope.projectId,
      remediationId: scope.proposalId, repositoryBindingId: scope.repositoryBindingId,
      installationRecordId: scope.installationRecordId, githubRepositoryId: scope.repositoryId,
      artifactHash: scope.artifactHash, baseRef: scope.baseRef, baseCommitSha: scope.baseCommitSha
    },
    identity: { stage, operationKey: `${stage}:${requestHash}`, requestHash, operation, expected },
    lease: { id: scope.proposalId, tenantId: scope.tenantId, projectId: scope.projectId, workerId: "worker-1",
      leaseToken: "private-lease-value", retriesLeft: 1 },
    status: "execution_started", reconciliationStatus: "not_required", commitSha: null, branchName: null,
    pullRequestNumber: null, pullRequestUrl: null
  };
}

test("recovery policy separates provable read-back cases from manual-review-only tree and commit cases", () => {
  for (const stage of ["blob", "branch", "pull_request", "pull_request_close"] as const) {
    assert.equal(executionRecoveryPolicy(stage), "read_verify");
  }
  for (const stage of ["tree", "commit"] as const) assert.equal(executionRecoveryPolicy(stage), "manual_review_only");
});

test("persisted intent descriptor must match the full execution scope and canonical request hash", () => {
  const valid = candidate();
  assert.equal(isValidExecutionRecoveryIntent(valid), true);
  assert.equal(isPersistedUnresolvedExecutionIntent(valid), false, "plain objects cannot impersonate a DB-loaded recovery candidate");
  const altered = { ...valid, identity: { ...valid.identity, expected: { ...valid.identity.expected!, blobSha: "e".repeat(40) } } };
  assert.equal(isValidExecutionRecoveryIntent(altered), false);
  const crossedScope = { ...valid, githubRepositoryId: "9007199254740994" };
  assert.equal(isValidExecutionRecoveryIntent(crossedScope), false);
  const wrongOperationKey = { ...valid, identity: { ...valid.identity, operationKey: `blob:${"0".repeat(64)}` } };
  assert.equal(isValidExecutionRecoveryIntent(wrongOperationKey), false);
});

test("restart discovery rebuilds runtime provenance from the durable intent and preserves missing-lease cases for escalation", async () => {
  const value = candidate();
  const operationKey = value.identity.operationKey;
  const requestHash = value.identity.requestHash;
  const row = {
    executionId: value.executionId, attemptNumber: value.attemptNumber, stage: value.identity.stage,
    operationKey, requestHash, metadata: { operation: value.identity.operation, expected: value.identity.expected },
    status: value.status, reconciliationStatus: value.reconciliationStatus, commitSha: null, branchName: null,
    pullRequestNumber: null, pullRequestUrl: null, remediationId: value.remediationId, tenantId: value.tenantId,
    organizationId: value.organizationId, projectId: value.projectId, repositoryBindingId: value.repositoryBindingId,
    installationRecordId: value.installationRecordId, githubRepositoryId: BigInt(value.githubRepositoryId),
    artifactHash: value.artifactHash, baseRef: value.baseRef, baseCommitSha: value.baseCommitSha,
    workerId: null, leaseToken: null, retriesLeft: 0, leaseExpiresAt: null
  };
  const prisma = { $queryRaw: async () => [row] } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const [found] = await persistence.discoverUnresolvedIntents();
  assert.ok(found);
  assert.equal(isPersistedUnresolvedExecutionIntent(found), true);
  assert.equal(isValidExecutionRecoveryIntent(found), true);
  assert.equal(found.githubRepositoryId, "9007199254740993", "repository IDs remain exact decimal strings");
  assert.equal(found.lease.leaseToken, "", "a cleared lease is not fabricated; it is retained as an escalation candidate");
});

test("recovery session is recreated from persisted state and a verified event makes rediscovery idempotent", async () => {
  const value = candidate();
  const metadata = { operation: value.identity.operation, expected: value.identity.expected };
  const dbRow = {
    id: value.executionId, tenantId: value.tenantId, organizationId: value.organizationId, projectId: value.projectId,
    remediationId: value.remediationId, repositoryBindingId: value.repositoryBindingId,
    installationRecordId: value.installationRecordId, githubRepositoryId: BigInt(value.githubRepositoryId),
    artifactHash: value.artifactHash, baseRef: value.baseRef, baseCommitSha: value.baseCommitSha,
    status: value.status, stage: "blob", attemptNumber: value.attemptNumber, version: 4n,
    leaseTokenHash: "f".repeat(64), leaseExpiresAt: new Date(Date.now() + 30_000), commitSha: null,
    branchName: null, pullRequestNumber: null, pullRequestUrl: null, reconciliationStatus: "not_required"
  };
  let completed = false;
  const intentRow = { stage: "blob", requestHash: value.identity.requestHash, metadata };
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray) => {
      const sql = parts.join(" ");
      if (sql.includes("FROM remediation_executions e JOIN remediations r")) return [dbRow];
      if (sql.includes("SELECT stage, request_hash AS \"requestHash\", metadata")) return [intentRow];
      if (sql.includes("event_type IN ('remote_result_verified', 'remote_mutation_rejected')")) {
        return completed ? [{ id: "already-terminal" }] : [];
      }
      return [];
    }
  };
  const prisma = {
    $queryRaw: async () => [{
      executionId: value.executionId, attemptNumber: value.attemptNumber, stage: "blob",
      operationKey: value.identity.operationKey, requestHash: value.identity.requestHash, metadata,
      status: value.status, reconciliationStatus: value.reconciliationStatus, commitSha: null, branchName: null,
      pullRequestNumber: null, pullRequestUrl: null, remediationId: value.remediationId, tenantId: value.tenantId,
      organizationId: value.organizationId, projectId: value.projectId, repositoryBindingId: value.repositoryBindingId,
      installationRecordId: value.installationRecordId, githubRepositoryId: BigInt(value.githubRepositoryId),
      artifactHash: value.artifactHash, baseRef: value.baseRef, baseCommitSha: value.baseCommitSha,
      workerId: "worker-1", leaseToken: value.lease.leaseToken, retriesLeft: 1, leaseExpiresAt: new Date(Date.now() + 30_000)
    }],
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)
  } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma);
  const [loaded] = await persistence.discoverUnresolvedIntents();
  assert.ok(loaded);
  assert.ok(await persistence.resumeForRecovery(loaded));
  completed = true;
  assert.equal(await persistence.resumeForRecovery(loaded), null, "a committed verified-result event blocks replay");
});

test("tree and commit restart outcomes are durably escalated without GitHub reads or writes", async () => {
  for (const stage of ["tree", "commit"] as const) {
    const base = candidate(stage);
    const operation = { treeSha: "d".repeat(40), parentCommitSha: "b".repeat(40) };
    const expected = { commitParentSha: "b".repeat(40), commitTreeSha: "d".repeat(40) };
    const requestHash = mutationRequestHash(stage, scope, operation, expected);
    const row = {
      executionId: base.executionId, attemptNumber: base.attemptNumber, stage,
      operationKey: `${stage}:${requestHash}`, requestHash, metadata: { operation, expected },
      status: base.status, reconciliationStatus: base.reconciliationStatus, commitSha: null, branchName: null,
      pullRequestNumber: null, pullRequestUrl: null, remediationId: base.remediationId, tenantId: base.tenantId,
      organizationId: base.organizationId, projectId: base.projectId, repositoryBindingId: base.repositoryBindingId,
      installationRecordId: base.installationRecordId, githubRepositoryId: BigInt(base.githubRepositoryId),
      artifactHash: base.artifactHash, baseRef: base.baseRef, baseCommitSha: base.baseCommitSha,
      workerId: null, leaseToken: null, retriesLeft: 0, leaseExpiresAt: null
    };
    const authority = new RemediationExecutionPersistenceService({ $queryRaw: async () => [row] } as unknown as PrismaClient);
    let escalated = 0; let remoteCalls = 0; let capabilityCalls = 0;
    const persistence = { discoverUnresolvedIntents: authority.discoverUnresolvedIntents.bind(authority),
      async requireRecoveryReview() { escalated++; return true; } } as unknown as RemediationExecutionPersistenceService;
    const recovery = new ArtifactOnlyExecutionRecoveryService(persistence,
      { async prepare() { capabilityCalls++; return null; } } as never,
      { async issue() { capabilityCalls++; return null; }, leaseGuardFor() { return null; } } as never,
      { async recoverBlobMutation() { remoteCalls++; return null; } } as never,
      { async recoverBranchMutation() { remoteCalls++; return null; }, async recoverDraftPullRequestMutation() { remoteCalls++; return null; } } as never);
    const [outcome] = await recovery.recover("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    assert.equal(outcome?.kind, "manual_review");
    assert.equal(escalated, 1);
    assert.equal(remoteCalls, 0);
    assert.equal(capabilityCalls, 0);
  }
});
