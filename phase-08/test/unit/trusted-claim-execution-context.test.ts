import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import type { RemediationLease } from "../../src/jobs/remediation-repo.js";
import { renderExecutionArtifact } from "../../src/remediation/execution-artifact.js";
import { RemediationExecutionPersistenceService, isRemediationExecutionSession } from "../../src/remediation/remediation-execution-persistence.js";
import {
  isTrustedClaimExecutionContext,
  TrustedClaimExecutionContextService
} from "../../src/remediation/trusted-claim-execution-context.js";

const lease: RemediationLease = {
  id: "proposal-1", tenantId: "tenant-1", projectId: "project-1", workerId: "worker-1",
  leaseToken: "d60587a1-58d7-4836-bc3d-f8ebecb10147", retriesLeft: 2
};
const scope = {
  proposalId: lease.id, tenantId: lease.tenantId, organizationId: "org-1", projectId: lease.projectId,
  repositoryBindingId: "binding-1", githubRepositoryId: "9007199254740993",
  installationRecordId: "installation-1", planHash: "a".repeat(64)
};
const planSnapshot = {
  schemaVersion: 1,
  plannerVersion: "phase07-planner-v1",
  projectId: lease.projectId,
  finding: { id: "finding-1", scanId: "scan-1", requirementId: "req", ruleId: "rule", ruleVersion: "1",
    signal: "metric", outcome: "gap", expected: "count >= 1", observed: "0", reason: "No matching evidence." },
  repository: { bindingId: scope.repositoryBindingId, repositoryId: scope.githubRepositoryId,
    installationRecordId: scope.installationRecordId, owner: "octo", name: "demo" },
  patch: { filePath: "config/observability/metrics.yaml", title: "title", body: "body",
    commitMessage: "message", summary: "summary" }
};
const planHash = createHash("sha256").update(JSON.stringify(planSnapshot), "utf8").digest("hex");
const artifact = renderExecutionArtifact({
  scope: { ...scope, planHash },
  finding: { requirementId: "req", ruleId: "rule", ruleVersion: "1", signal: "metric", outcome: "gap",
    expected: "count >= 1", observed: "0", reason: "No matching evidence." },
  snapshot: { immutableRepositoryId: scope.githubRepositoryId, baseRef: "main", baseCommitSha: "b".repeat(40),
    filePath: "config/observability/metrics.yaml",
    file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true } },
  createdAt: new Date("2026-11-06T00:00:00.000Z")
});

function baseState() {
  return {
    remediation: {
      id: lease.id, tenantId: lease.tenantId, organizationId: scope.organizationId, projectId: lease.projectId,
      scanId: "scan-1", findingId: "finding-1", status: "running", workerId: lease.workerId,
      leaseExpiresAt: new Date("2026-11-06T02:00:00.000Z"),
      leaseToken: lease.leaseToken, approvalState: "approved", requestedByIdentityUserId: "requester-1",
      approvedByIdentityUserId: "approver-1", approvedAt: new Date("2026-11-05T00:00:00.000Z"),
      repositoryBindingId: scope.repositoryBindingId, githubRepositoryId: BigInt(scope.githubRepositoryId),
      planHash, planSnapshot: structuredClone(planSnapshot), executionArtifact: structuredClone(artifact.artifact),
      executionArtifactHash: artifact.artifactHash, approvedArtifactHash: artifact.artifactHash
    },
    organizationStatus: "active",
    project: { id: lease.projectId, tenantId: lease.tenantId, organizationId: scope.organizationId },
    scan: { id: "scan-1", tenantId: lease.tenantId, projectId: lease.projectId },
    finding: { id: "finding-1", tenantId: lease.tenantId, projectId: lease.projectId, scanId: "scan-1",
      requirementId: "req", ruleId: "rule", ruleVersion: "1", signal: "metric", outcome: "gap",
      expected: "count >= 1", observed: "0", reason: "No matching evidence." },
    adoptionStatus: "approved",
    binding: { id: scope.repositoryBindingId, tenantId: lease.tenantId, organizationId: scope.organizationId,
      projectId: lease.projectId, installationRecordId: scope.installationRecordId,
      githubRepositoryId: BigInt(scope.githubRepositoryId), ownerLogin: "octo", repositoryName: "demo", status: "active",
      installation: { organizationId: scope.organizationId, status: "active", githubInstallationId: 9223372036854775000n } },
    requesterStatus: "active", approverStatus: "active",
    approverMembership: { role: "admin", status: "active", userStatus: "active", organizationStatus: "active" }
  };
}

function harness(options: {
  state?: ReturnType<typeof baseState>;
  mutate?: (state: ReturnType<typeof baseState>) => void;
  initiallyOwned?: boolean;
  ownedAtFinalCheck?: boolean;
  leaseExpiredInitially?: boolean;
  leaseExpiredAtFinalCheck?: boolean;
  leaseReplacedAtFinalCheck?: boolean;
  lockFailure?: string;
} = {}) {
  const state = baseState();
  options.mutate?.(state);
  const actualState = options.state ?? state;
  const calls: { sql: string[]; transactionOptions: unknown; identityWhere: unknown; projectWhere: unknown; scanWhere: unknown; findingWhere: unknown } = {
    sql: [], transactionOptions: undefined, identityWhere: undefined, projectWhere: undefined, scanWhere: undefined, findingWhere: undefined
  };
  let rawCall = 0;
  const clone = <T>(value: T): T => structuredClone(value);
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ? ");
      calls.sql.push(sql);
      rawCall++;
      if (rawCall === 1) return options.initiallyOwned === false || options.leaseExpiredInitially ? [] : [clone(actualState.remediation)];
      if (sql.includes("cloudpilot_lock_active_organization")) return options.lockFailure?.includes("organizations")
        ? [{ locked: false }] : [{ locked: actualState.organizationStatus === "active" }];
      if (sql.includes("cloudpilot_lock_active_member") || sql.includes("cloudpilot_lock_active_actor_for_update")) {
        const member = actualState.approverMembership;
        return [{ role: member?.status === "active" && member.userStatus === "active" &&
          member.organizationStatus === "active" && actualState.organizationStatus === "active" ? member.role : null }];
      }
      if (sql.includes("cloudpilot_lock_scoped_finding")) {
        const finding = actualState.finding;
        return [{ locked: !!finding && finding.id === "finding-1" && finding.tenantId === lease.tenantId &&
          finding.projectId === lease.projectId && finding.scanId === "scan-1" }];
      }
      if (sql.includes("cloudpilot_lock_active_binding_installation")) {
        const binding = actualState.binding;
        return [{ locked: !options.lockFailure?.includes("project_github_repositories") &&
          !options.lockFailure?.includes("organization_github_installations") && !!binding &&
          binding.status === "active" && binding.installation.status === "active" }];
      }
      if (/FROM remediations/.test(sql)) {
        return options.ownedAtFinalCheck === false || options.leaseExpiredAtFinalCheck || options.leaseReplacedAtFinalCheck
          ? [] : [{ id: lease.id }];
      }
      if (options.lockFailure && sql.includes(options.lockFailure)) return [];
      return [{ id: "locked-row" }];
    },
    organization: { findUnique: async () => actualState.organizationStatus ? { status: actualState.organizationStatus } : null },
    project: { findFirst: async (args: { where: unknown }) => { calls.projectWhere = args.where; return clone(actualState.project); } },
    scan: { findFirst: async (args: { where: unknown }) => { calls.scanWhere = args.where; return clone(actualState.scan); } },
    finding: { findFirst: async (args: { where: unknown }) => { calls.findingWhere = args.where; return clone(actualState.finding); } },
    projectOrganizationAdoption: { findFirst: async () => actualState.adoptionStatus === "approved" ? { status: "approved" } : null },
    projectGitHubRepository: { findFirst: async () => {
      const binding = actualState.binding;
      return binding?.status === "active" && binding.installation.status === "active" ? clone(binding) : null;
    } },
    identityUser: { findMany: async (args: { where: unknown }) => {
      calls.identityWhere = args.where;
      return [
        { id: actualState.remediation.requestedByIdentityUserId, status: actualState.requesterStatus },
        { id: actualState.remediation.approvedByIdentityUserId, status: actualState.approverStatus }
      ].filter((row) => row.id !== null);
    } },
    organizationMember: { findFirst: async () => {
      const member = actualState.approverMembership;
      return member?.status === "active" && member.userStatus === "active" && member.organizationStatus === "active"
        ? { role: member.role, status: member.status, user: { status: member.userStatus }, organization: { status: member.organizationStatus } }
        : null;
    } }
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>, txOptions: unknown) => {
      calls.transactionOptions = txOptions;
      return callback(tx);
    }
  } as unknown as PrismaClient;
  return { service: new TrustedClaimExecutionContextService(prisma), state: actualState, calls };
}

function persistenceHarness(options: { existing?: boolean; pendingIntent?: boolean; sameLeasePendingIntent?: boolean;
  priorIntentHash?: string; priorIntentStage?: string; updateCount?: number;
  failAudit?: boolean; denyLock?: string } = {}) {
  const statements: string[] = [];
  const committedStatements: string[] = [];
  const audits: unknown[] = [];
  const contextHarness = harness();
  const tokenHash = createHash("sha256").update(options.pendingIntent && !options.sameLeasePendingIntent ? "previous-lease-token" : lease.leaseToken).digest("hex");
  const execution = {
    id: "execution-1", tenantId: lease.tenantId, organizationId: scope.organizationId, projectId: lease.projectId,
    remediationId: lease.id, repositoryBindingId: scope.repositoryBindingId, installationRecordId: scope.installationRecordId,
    githubRepositoryId: BigInt(scope.githubRepositoryId), artifactHash: artifact.artifactHash, baseRef: "main",
    baseCommitSha: "b".repeat(40), status: options.pendingIntent ? "execution_started" : "execution_started",
    stage: null, attemptNumber: 1, version: 0n, leaseTokenHash: tokenHash,
    leaseExpiresAt: new Date(Date.now() + 60_000), commitSha: null, branchName: null,
    pullRequestNumber: null, pullRequestUrl: null, reconciliationStatus: "not_required"
  };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ? "); statements.push(sql);
      if (sql.includes("FROM remediations r")) return [{ id: lease.id, tenantId: lease.tenantId,
        organizationId: scope.organizationId, projectId: lease.projectId, repositoryBindingId: scope.repositoryBindingId,
        requestedByIdentityUserId: "requester-1", approvedByIdentityUserId: "approver-1",
        installationRecordId: scope.installationRecordId,
        githubRepositoryId: BigInt(scope.githubRepositoryId), artifactHash: artifact.artifactHash,
        baseRef: "main", baseCommitSha: "b".repeat(40) }];
      if (sql.includes("cloudpilot_lock_active_organization")) return [{ locked: !options.denyLock?.includes("organizations") }];
      if (sql.includes("cloudpilot_lock_active_actor_for_update")) return [{ role: "owner" }];
      if (sql.includes("cloudpilot_lock_active_member")) return [{ role: "admin" }];
      if (sql.includes("cloudpilot_lock_active_binding_installation")) return [{ locked: !options.denyLock?.includes("project_github_repositories") &&
        !options.denyLock?.includes("organization_github_installations") }];
      if (sql.includes("FOR SHARE")) return options.denyLock && sql.includes(options.denyLock) ? [] : [{ id: "locked-row" }];
      if (sql.includes("SELECT id,") && sql.includes("FROM remediation_executions") && sql.includes("FOR UPDATE") && !sql.includes("JOIN remediations")) {
        return options.existing ? [execution] : [];
      }
      if (sql.includes("FROM remediation_executions e")) return [execution];
      if (sql.includes("FROM remediation_executions e") && sql.includes("JOIN organization_members")) return [{ ...execution, actorRole: "owner" }];
      if (sql.includes("lease_expires_at > clock_timestamp() AS valid")) return [{ valid: true }];
      if (sql.includes("SELECT count(*) AS count")) return [{ count: options.pendingIntent ? 1n : 0n }];
      if (sql.includes("request_hash AS \"requestHash\"")) return options.priorIntentHash ? [{
        requestHash: options.priorIntentHash, stage: options.priorIntentStage ?? "commit"
      }] : [];
      if (sql.includes("INSERT INTO remediation_executions")) return [execution];
      if (sql.includes("COALESCE(MAX(sequence_number)")) return [{ sequence: 1 }];
      return [];
    },
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ? "); statements.push(sql);
      if (sql.includes("UPDATE remediation_executions")) return options.updateCount ?? 1;
      return 1;
    }
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      statements.length = 0;
      try {
        const result = await callback(tx);
        committedStatements.push(...statements);
        return result;
      } catch (error) {
        statements.length = 0; // model Prisma's rollback boundary for this focused unit test
        throw error;
      }
    }
  } as unknown as PrismaClient;
  const auditWriter = async (_tx: unknown, input: unknown) => {
    if (options.failAudit) throw new Error("audit unavailable");
    audits.push(input);
  };
  return { prisma, service: new RemediationExecutionPersistenceService(prisma, auditWriter as never), contextHarness,
    statements, committedStatements, audits };
}

test("durable execution start writes scoped aggregate, journal and audit in one serializable transaction", async () => {
  const h = persistenceHarness();
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session && isRemediationExecutionSession(session));
  assert.equal(session.attemptNumber, 1);
  assert.ok(h.committedStatements.some((sql) => sql.includes("INSERT INTO remediation_executions")));
  assert.ok(h.committedStatements.some((sql) => sql.includes("INSERT INTO remediation_execution_events")));
  assert.equal(h.audits.length, 1);
});

test("audit failure aborts the execution transaction and leaves no committed execution writes", async () => {
  const h = persistenceHarness({ failAudit: true });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  await assert.rejects(h.service.start(lease, context), /audit unavailable/);
  assert.deepEqual(h.committedStatements, []);
});

test("authorization-scope lock failure prevents execution creation and its audit", async () => {
  const h = persistenceHarness({ denyLock: "project_github_repositories" });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  assert.equal(await h.service.start(lease, context), null);
  assert.equal(h.committedStatements.some((sql) => sql.includes("INSERT INTO remediation_executions")), false);
  assert.equal(h.audits.length, 0);
});

test("unresolved remote request intent is converted to durable manual review, never a retry", async () => {
  const h = persistenceHarness({ existing: true, pendingIntent: true });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  assert.equal(await h.service.start(lease, context), null);
  assert.ok(h.committedStatements.some((sql) => sql.includes("status = 'manual_review_required'")));
  assert.ok(h.committedStatements.some((sql) => sql.includes("reconciliation_status = 'required'")));
  assert.equal(h.audits.length, 1);
});

test("same unexpired worker lease cannot reopen a session while a mutation intent is unresolved", async () => {
  const h = persistenceHarness({ existing: true, pendingIntent: true, sameLeasePendingIntent: true });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  assert.equal(await h.service.start(lease, context), null);
  assert.ok(h.committedStatements.some((sql) => sql.includes("status = 'manual_review_required'")));
  assert.equal(h.committedStatements.some((sql) => sql.includes("SELECT lease_expires_at > clock_timestamp() AS valid")), false);
});

test("intent replay with a different request hash conflicts without changing execution state", async () => {
  const h = persistenceHarness({ existing: true, priorIntentHash: "a".repeat(64) });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session);
  const before = h.committedStatements.length;
  await assert.rejects(session.recordIntent({ stage: "commit", operationKey: "commit-v1", requestHash: "b".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "intent_conflict");
  assert.equal(h.committedStatements.length, before);
});

test("replaying an identical request intent is rejected as potentially ambiguous", async () => {
  const h = persistenceHarness({ existing: true, priorIntentHash: "d".repeat(64) });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session);
  const beforeWrites = h.committedStatements.filter((sql) => /^\s*(INSERT|UPDATE)\b/i.test(sql)).length;
  const beforeAudits = h.audits.length;
  await assert.rejects(session.recordIntent({ stage: "commit", operationKey: "commit-v1", requestHash: "d".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "invalid_transition");
  assert.equal(h.committedStatements.filter((sql) => /^\s*(INSERT|UPDATE)\b/i.test(sql)).length, beforeWrites);
  assert.equal(h.audits.length, beforeAudits);
});

test("a matching prior intent is not accepted as permission to repeat a remote mutation", async () => {
  const h = persistenceHarness({ existing: true, priorIntentHash: "d".repeat(64) });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session);
  const beforeWrites = h.committedStatements.filter((sql) => /^\s*(INSERT|UPDATE)\b/i.test(sql)).length;
  const beforeAudits = h.audits.length;
  await assert.rejects(session.recordIntent({ stage: "commit", operationKey: "commit-v1", requestHash: "d".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "invalid_transition");
  assert.equal(h.committedStatements.filter((sql) => /^\s*(INSERT|UPDATE)\b/i.test(sql)).length, beforeWrites);
  assert.equal(h.audits.length, beforeAudits);
});

test("an operation key reused across stages is rejected even when the request hash matches", async () => {
  const h = persistenceHarness({ existing: true, priorIntentHash: "e".repeat(64), priorIntentStage: "commit" });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session);
  await assert.rejects(session.recordIntent({ stage: "blob", operationKey: "commit-v1", requestHash: "e".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "intent_conflict");
});

test("ordinary objects cannot advance verified state and reconciliation cannot assert completion without evidence", async () => {
  const h = persistenceHarness({ existing: true });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session);
  await assert.rejects(session.recordVerified({
    operationKey: "commit-v1", capability: {} as never,
    result: { kind: "committed", commitSha: "a".repeat(40), proposalId: lease.id,
      artifactHash: artifact.artifactHash, repositoryId: scope.githubRepositoryId, baseCommitSha: "b".repeat(40) } as never
  }), (error: unknown) => (error as { code?: string }).code === "invalid_input");
  assert.equal(await h.service.resolveReconciliation({
    lease: { executionId: "execution-1", organizationId: scope.organizationId,
      actorIdentityUserId: "approver-1", leaseToken: "reconcile-token", expiresAt: new Date().toISOString() },
    outcome: "completed"
  }), false);
  assert.equal(await h.service.resolveReconciliation({
    lease: { executionId: "execution-1", organizationId: scope.organizationId,
      actorIdentityUserId: "approver-1", leaseToken: "reconcile-token", expiresAt: new Date().toISOString() },
    outcome: "completed",
    completionEvidence: { capability: {} as never, result: {
      kind: "draft_pull_request", pullRequestNumber: 1, pullRequestUrl: "https://github.com/owner/repo/pull/1",
      branchName: "cloudpilot/remediation/" + "a".repeat(40), commitSha: "a".repeat(40),
      artifactHash: artifact.artifactHash, reconciled: true
    } as never }
  }), false, "copied or caller-created evidence has no publisher runtime brand");
});

test("reconciliation persistence uses DB-time lease expiry in the conditional CAS and journals close intents atomically", async () => {
  const h = persistenceHarness({ existing: true });
  const reconcileLease = { executionId: "execution-1", organizationId: scope.organizationId,
    actorIdentityUserId: "approver-1", leaseToken: "reconcile-token", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await h.service.recordReconciliationIntent(reconcileLease, {
    stage: "pull_request_close", operationKey: "close-v1", requestHash: "f".repeat(64)
  });
  const updates = h.committedStatements.filter((sql) => sql.includes("UPDATE remediation_executions"));
  assert.ok(updates.some((sql) => sql.includes("reconciliation_lease_until > clock_timestamp()")));
  assert.ok(h.committedStatements.some((sql) => sql.includes("'request_intent'")));
  assert.equal(await h.service.resolveReconciliation({ lease: reconcileLease, outcome: "failed", code: "execution_failed" }), true);
  assert.ok(h.committedStatements.filter((sql) => sql.includes("UPDATE remediation_executions"))
    .some((sql) => sql.includes("reconciliation_lease_until > clock_timestamp()")),
  "resolution repeats the expiry predicate in its CAS UPDATE, not only its SELECT");
  assert.equal(h.audits.length, 2);
});

test("reconciliation audit failure rolls back its journal and state transition", async () => {
  const h = persistenceHarness({ existing: true, failAudit: true });
  const reconcileLease = { executionId: "execution-1", organizationId: scope.organizationId,
    actorIdentityUserId: "approver-1", leaseToken: "reconcile-token", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await assert.rejects(h.service.recordReconciliationIntent(reconcileLease, {
    stage: "pull_request_close", operationKey: "close-v1", requestHash: "f".repeat(64)
  }), /audit unavailable/);
  assert.deepEqual(h.committedStatements, []);
});

test("migration encodes explicit nullable-pair, verified-commit, composite-scope, and TRUNCATE protections", async () => {
  const sql = await readFile("prisma/migrations/20261106120000_remediation_execution_persistence/migration.sql", "utf8");
  assert.match(sql, /"lease_owner" IS NOT NULL AND "lease_token_hash" IS NOT NULL AND "lease_expires_at" IS NOT NULL/);
  assert.match(sql, /"reconciliation_lease_hash" IS NOT NULL AND "reconciliation_lease_until" IS NOT NULL/);
  assert.match(sql, /"pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL/);
  assert.match(sql, /"commit_sha" IS NOT NULL AND "commit_verified_at" IS NOT NULL/);
  assert.match(sql, /"repository_binding_id", "github_repository_id", "installation_record_id"\)\s+REFERENCES "project_github_repositories"\("tenant_id", "organization_id", "project_id", "id", "github_repository_id", "installation_record_id"\)/);
  assert.match(sql, /FOREIGN KEY \("organization_id", "actor_user_id"\) REFERENCES "organization_members"\("organization_id", "user_id"\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON "remediation_execution_events"/);
  assert.match(sql, /BEFORE TRUNCATE ON "remediation_execution_events"\s+FOR EACH STATEMENT/);
  assert.match(sql, /Runtime role must not own these tables/);
});

test("failed version compare-and-set does not append an event or audit record", async () => {
  const h = persistenceHarness({ existing: true, updateCount: 0 });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session);
  const priorAuditCount = h.audits.length;
  await assert.rejects(session.recordIntent({ stage: "commit", operationKey: "commit-v1", requestHash: "c".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "execution_conflict");
  assert.equal(h.audits.length, priorAuditCount);
});

test("failure persistence rejects arbitrary text instead of storing it as a safe code", async () => {
  const h = persistenceHarness({ existing: true });
  const context = await h.contextHarness.service.prepare(lease);
  assert.ok(context);
  const session = await h.service.start(lease, context);
  assert.ok(session);
  await assert.rejects(session.recordFailure("commit", "ghp_secret_value"),
    (error: unknown) => (error as { code?: string }).code === "invalid_input");
});

test("valid persisted approved artifact produces a frozen copy-safe trusted context", async () => {
  const h = harness();
  const context = await h.service.prepare({ ...lease, repositoryUrl: "https://untrusted.invalid/repo.git",
    owner: "attacker", repo: "wrong", patch: { applyPatch: () => "forged" }, artifact: { renderedContent: "forged" } } as never);
  assert.ok(context);
  assert.equal(isTrustedClaimExecutionContext(context), true);
  assert.equal(isTrustedClaimExecutionContext({ ...context }), false, "copying fields cannot forge trusted provenance");
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.lease), true);
  assert.equal(Reflect.set(context.lease, "workerId", "attacker"), false);
  assert.equal(Reflect.set(context, "artifactHash", "forged"), false);
  assert.deepEqual({
    remediationId: context.remediationId, proposalId: context.proposalId, tenantId: context.tenantId,
    organizationId: context.organizationId, projectId: context.projectId, scanId: context.scanId,
    findingId: context.findingId, requesterIdentityUserId: context.requesterIdentityUserId,
    approverIdentityUserId: context.approverIdentityUserId, repositoryBindingId: context.repositoryBindingId,
    installationRecordId: context.installationRecordId, githubInstallationId: context.githubInstallationId,
    githubRepositoryId: context.githubRepositoryId, repositoryOwner: context.repositoryOwner, repositoryName: context.repositoryName,
    baseRef: context.baseRef, baseCommitSha: context.baseCommitSha, artifactHash: context.artifactHash,
    filePath: context.filePath, operation: context.operation, mode: context.mode,
    lease: context.lease
  }, {
    remediationId: lease.id, proposalId: lease.id, tenantId: lease.tenantId, organizationId: scope.organizationId,
    projectId: lease.projectId, scanId: "scan-1", findingId: "finding-1", requesterIdentityUserId: "requester-1",
    approverIdentityUserId: "approver-1", repositoryBindingId: scope.repositoryBindingId,
    installationRecordId: scope.installationRecordId, githubInstallationId: "9223372036854775000",
    githubRepositoryId: scope.githubRepositoryId, repositoryOwner: "octo", repositoryName: "demo",
    baseRef: "main", baseCommitSha: "b".repeat(40), artifactHash: artifact.artifactHash,
    filePath: artifact.artifact.filePath, operation: "create", mode: "100644",
    lease: { remediationId: lease.id, tenantId: lease.tenantId, projectId: lease.projectId,
      workerId: lease.workerId, leaseToken: lease.leaseToken, expiresAt: "2026-11-06T02:00:00.000Z" }
  });
  const expectedBytes = new Uint8Array(Buffer.from(artifact.artifact.renderedContent, "utf8"));
  const firstRead = context.renderedBytes;
  assert.deepEqual(firstRead, expectedBytes);
  firstRead.fill(0);
  assert.deepEqual(context.renderedBytes, expectedBytes, "callers receive a defensive byte copy");
  assert.equal("repositoryUrl" in context, false);
  assert.equal("owner" in context, false);
  assert.equal("repo" in context, false);
  assert.equal("token" in context, false);
  assert.equal("patch" in context, false);
  assert.equal((context as unknown as Record<string, unknown>).repositoryUrl, undefined);
});

test("invalid artifact, approval hash, and persisted scope fail closed", async () => {
  const cases: Array<(state: ReturnType<typeof baseState>) => void> = [
    (s) => { s.remediation.executionArtifact = null as unknown as typeof artifact.artifact; },
    (s) => { (s.remediation.executionArtifact as unknown as Record<string, unknown>).renderedContent = "changed"; },
    (s) => { s.remediation.approvedArtifactHash = "c".repeat(64); },
    (s) => { s.remediation.executionArtifactHash = "d".repeat(64); },
    (s) => { s.remediation.tenantId = "other-tenant"; },
    (s) => { s.remediation.projectId = "other-project"; },
    (s) => { s.remediation.organizationId = "other-org"; },
    (s) => { s.remediation.repositoryBindingId = "other-binding"; },
    (s) => { s.remediation.githubRepositoryId = 42n; },
    (s) => { s.binding!.installationRecordId = "other-installation"; },
    (s) => { s.binding!.githubRepositoryId = 42n; },
    (s) => { s.finding!.tenantId = "other-tenant"; },
    (s) => { s.finding!.projectId = "other-project"; },
    (s) => { s.scan!.id = "other-scan"; },
    (s) => { s.adoptionStatus = "rejected"; }, // project adoption revoked after approval
    (s) => { s.project!.organizationId = "reassigned-org"; },
    (s) => { s.binding!.status = "disconnected"; }, // binding disconnected before context preparation
    (s) => { s.binding!.installation.status = "suspended"; },
    (s) => { s.binding!.installation.status = "revoked"; },
    (s) => { s.organizationStatus = "inactive"; },
    (s) => { s.requesterStatus = "suspended"; }, // requester deactivated after approval
    (s) => { s.approverStatus = "suspended"; },
    (s) => { s.approverMembership = { role: "viewer", status: "active", userStatus: "active", organizationStatus: "active" }; }, // role downgraded
    (s) => { s.approverMembership = { role: "admin", status: "inactive", userStatus: "active", organizationStatus: "active" }; }, // membership revoked
    (s) => { s.remediation.approvalState = "rejected"; },
    (s) => { s.remediation.planSnapshot = { altered: true } as unknown as typeof planSnapshot; }
  ];
  for (const mutate of cases) {
    const h = harness({ mutate });
    assert.equal(await h.service.prepare(lease), null, String(mutate));
  }
});

test("missing, expired, wrong-token, or changed lease is rejected before context return", async () => {
  assert.equal(await harness({ initiallyOwned: false }).service.prepare(lease), null, "missing/expired claim fails the initial database-time check");
  assert.equal(await harness({ leaseExpiredInitially: true }).service.prepare(lease), null, "an initially expired lease fails the database-time check");
  const wrongToken = lease.leaseToken.replace(/^./, "e");
  assert.equal(await harness({ mutate: (s) => { s.remediation.leaseToken = wrongToken; } }).service.prepare(lease), null);
  assert.equal(await harness({ mutate: (s) => { s.remediation.status = "pending"; } }).service.prepare(lease), null);
  assert.equal(await harness({ leaseReplacedAtFinalCheck: true }).service.prepare(lease), null,
    "replacement of the lease token before final verification discards the context");
  assert.equal(await harness({ leaseExpiredAtFinalCheck: true }).service.prepare(lease), null,
    "expiry before final verification discards the context");
});

test("approver must retain active organization membership and remediation:approve permission", async () => {
  for (const role of ["owner", "admin"]) {
    assert.ok(await harness({ mutate: (s) => { s.approverMembership!.role = role; } }).service.prepare(lease));
  }
  for (const role of ["operator", "viewer"]) {
    assert.equal(await harness({ mutate: (s) => { s.approverMembership!.role = role; } }).service.prepare(lease), null);
  }
});

test("Prisma boundary locks and rechecks lease with DB time and Serializable isolation", async () => {
  const h = harness({ leaseExpiredAtFinalCheck: true });
  assert.equal(await h.service.prepare(lease), null, "simulated final lease check fails after validation");
  assert.equal(h.calls.sql.length, 11);
  assert.match(h.calls.sql[0], /FOR UPDATE/);
  assert.match(h.calls.sql[0], /lease_expires_at > clock_timestamp\(\)/);
  assert.match(h.calls.sql.at(-1)!, /lease_expires_at > clock_timestamp\(\)/);
  for (const relation of ["projects", "scans", "project_organization_adoptions", "identity_users"]) {
    assert.ok(h.calls.sql.some((sql) => sql.includes(`FROM ${relation}`) && /FOR SHARE/.test(sql)),
      `${relation} is locked through context issuance`);
  }
  for (const helper of ["cloudpilot_lock_active_organization", "cloudpilot_lock_scoped_finding",
    "cloudpilot_lock_active_binding_installation", "cloudpilot_lock_active_member"]) {
    assert.ok(h.calls.sql.some((sql) => sql.includes(helper)), `${helper} performs its lock inside the SECURITY DEFINER boundary`);
  }
  const lockSql = h.calls.sql.join("\n");
  for (const typedUuidComparison of [
    /cloudpilot_lock_active_organization\(\s*\?\s*::uuid/,
    /FROM projects WHERE .*organization_id =\s*\?\s*::uuid/,
    /FROM project_organization_adoptions WHERE .*organization_id =\s*\?\s*::uuid/,
    /cloudpilot_lock_active_binding_installation\([\s\S]*\?\s*::uuid[\s\S]*\?\s*::uuid/,
    /FROM identity_users WHERE id =\s*\?\s*::uuid/,
    /cloudpilot_lock_active_member\(\s*\?\s*::uuid\s*,\s*\?\s*::uuid/
  ]) {
    assert.match(lockSql, typedUuidComparison, `UUID database columns use explicit UUID-typed parameters: ${typedUuidComparison}`);
  }
  assert.deepEqual(h.calls.transactionOptions, { isolationLevel: "Serializable" });
  assert.deepEqual(h.calls.identityWhere, { id: { in: ["requester-1", "approver-1"] } });
  assert.deepEqual(h.calls.projectWhere, { id: "project-1", tenantId: "tenant-1", organizationId: "org-1" });
  assert.deepEqual(h.calls.scanWhere, { id: "scan-1", tenantId: "tenant-1", projectId: "project-1" });
  assert.deepEqual(h.calls.findingWhere, { id: "finding-1", tenantId: "tenant-1", projectId: "project-1", scanId: "scan-1" });
});

test("binding or installation revocation before its authorization lock fails closed", async () => {
  assert.equal(await harness({ lockFailure: "project_github_repositories" }).service.prepare(lease), null);
  assert.equal(await harness({ lockFailure: "organization_github_installations" }).service.prepare(lease), null);
});

test("repeated preparation rechecks persisted authorization instead of reusing stale context", async () => {
  const h = harness();
  assert.ok(await h.service.prepare(lease));
  h.state.approverMembership!.status = "inactive";
  assert.equal(await h.service.prepare(lease), null);
});
